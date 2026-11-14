//! Runs the engine on its own thread and streams fields to connections.
//!
//! The thread steps every open stream inside a frame budget and pushes a frame
//! when a job's revision changes. Slow connections lose frames, never queue them.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use anyhow::anyhow;
use mrs_engine::{encode_frame, Backend, Encoding, Engine, EngineConfig, EngineInfo, JobId, JobState, SceneData};
use mrs_site::LonLat;
use serde_json::{json, Value};
use tokio::sync::{mpsc as tmpsc, oneshot};

/// Time the engine may spend stepping jobs before it looks at commands again.
const FRAME_BUDGET: Duration = Duration::from_millis(12);

/// What a connection receives from the engine thread.
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
}

pub struct OpenRequest {
    pub conn: u64,
    pub kernel: String,
    pub params: Value,
    pub fields: Vec<String>,
    pub encoding: Encoding,
    pub max_hz: f64,
    pub out: tmpsc::Sender<Out>,
}

enum Command {
    Info(oneshot::Sender<EngineInfo>),
    Open(OpenRequest, oneshot::Sender<Result<u32, String>>),
    Set { conn: u64, stream: u32, params: Value, reply: oneshot::Sender<Result<(), String>> },
    Close { conn: u64, stream: u32 },
    CloseConnection(u64),
    LoadScene(SceneData, oneshot::Sender<Result<(), String>>),
}

#[derive(Clone)]
pub struct EngineHandle {
    tx: mpsc::Sender<Command>,
}

struct Stream {
    conn: u64,
    job: JobId,
    fields: Vec<String>,
    encoding: Encoding,
    interval: Duration,
    out: tmpsc::Sender<Out>,
    sent_revision: Option<u64>,
    last_sent: Instant,
    running: bool,
}

impl EngineHandle {
    pub fn spawn(backend: Backend, scene: SceneData, origin: LonLat) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new().name("mrs-engine".into()).spawn(move || {
            let engine = Engine::new(EngineConfig { backend }).and_then(|mut e| e.load_scene(scene).map(|_| e));
            match engine {
                Ok(engine) => {
                    let _ = ready_tx.send(Ok(()));
                    run(engine, origin, rx);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                }
            }
        })?;
        ready_rx.recv()?.map_err(|e| anyhow!("engine failed to start: {e}"))?;
        Ok(Self { tx })
    }

    fn send(&self, command: Command) -> anyhow::Result<()> {
        self.tx.send(command).map_err(|_| anyhow!("engine thread has stopped"))
    }

    pub async fn info(&self) -> anyhow::Result<EngineInfo> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Info(reply))?;
        Ok(rx.await?)
    }

    pub async fn open(&self, request: OpenRequest) -> Result<u32, String> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Open(request, reply)).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    pub async fn set(&self, conn: u64, stream: u32, params: Value) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Set { conn, stream, params, reply }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    pub fn close(&self, conn: u64, stream: u32) {
        let _ = self.send(Command::Close { conn, stream });
    }

    /// Replaces the scene, for a site whose sources changed. Running jobs pick it up on their next step.
    pub async fn load_scene(&self, scene: SceneData) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::LoadScene(scene, reply)).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    pub fn close_connection(&self, conn: u64) {
        let _ = self.send(Command::CloseConnection(conn));
    }
}

fn run(mut engine: Engine, origin: LonLat, rx: mpsc::Receiver<Command>) {
    let mut streams: HashMap<u32, Stream> = HashMap::new();
    let mut next_stream = 1u32;
    let mut busy = false;
    loop {
        // Sleep on the command channel when there is nothing to compute or send.
        let first = if busy {
            match rx.try_recv() {
                Ok(c) => Some(c),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return,
            }
        } else {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(c) => Some(c),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        };
        let mut pending = first;
        while let Some(command) = pending {
            match command {
                Command::Info(reply) => {
                    let _ = reply.send(engine.info());
                }
                Command::Open(request, reply) => {
                    let _ = reply.send(open(&mut engine, origin, request, &mut streams, &mut next_stream));
                }
                Command::Set { conn, stream, params, reply } => {
                    let result = match streams.get_mut(&stream).filter(|s| s.conn == conn) {
                        Some(s) => {
                            s.running = true;
                            engine.set_params(s.job, &params).map_err(|e| e.to_string())
                        }
                        None => Err(format!("unknown stream {stream}")),
                    };
                    let _ = reply.send(result);
                }
                Command::Close { conn, stream } => {
                    if streams.get(&stream).is_some_and(|s| s.conn == conn) {
                        engine.drop_job(streams.remove(&stream).unwrap().job);
                    }
                }
                Command::LoadScene(scene, reply) => {
                    let _ = reply.send(engine.load_scene(scene).map_err(|e| e.to_string()));
                }
                Command::CloseConnection(conn) => {
                    streams.retain(|_, s| {
                        if s.conn == conn {
                            engine.drop_job(s.job);
                        }
                        s.conn != conn
                    });
                }
            }
            pending = rx.try_recv().ok();
        }

        let active = streams.values().filter(|s| s.running).count().max(1) as u32;
        let budget = FRAME_BUDGET / active;
        let mut worked = false;
        let mut dead = Vec::new();
        busy = false;
        for (&id, stream) in streams.iter_mut() {
            if stream.out.is_closed() {
                dead.push(id);
                continue;
            }
            let was_running = stream.running;
            let status = match engine.step(stream.job, budget) {
                Ok(status) => status,
                Err(e) => {
                    tracing::error!("stream {id}: {e}");
                    let _ = stream.out.try_send(Out::Text(
                        json!({ "t": "ev", "m": "engine.error", "p": { "stream": id, "error": e.to_string() } }).to_string(),
                    ));
                    dead.push(id);
                    continue;
                }
            };
            stream.running = status.state == JobState::Running;
            worked |= was_running;
            let unsent = stream.sent_revision != Some(status.revision);
            // The final frame of a job is sent at once; intermediate ones respect the rate limit.
            let due = !stream.running || stream.last_sent.elapsed() >= stream.interval;
            if unsent && due && send_frames(&mut engine, id, stream, &status) {
                stream.sent_revision = Some(status.revision);
                stream.last_sent = Instant::now();
            }
            busy |= stream.running || stream.sent_revision != Some(status.revision);
        }
        for id in dead {
            if let Some(s) = streams.remove(&id) {
                engine.drop_job(s.job);
            }
        }
        if busy && !worked {
            // Only waiting for a rate limit or a full connection queue.
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn open(
    engine: &mut Engine,
    origin: LonLat,
    request: OpenRequest,
    streams: &mut HashMap<u32, Stream>,
    next: &mut u32,
) -> Result<u32, String> {
    let info = engine.info();
    let kernel = info.kernels.iter().find(|k| k.id == request.kernel).ok_or_else(|| format!("unknown kernel '{}'", request.kernel))?;
    for field in &request.fields {
        if !kernel.fields.iter().any(|f| f.name == field) {
            return Err(format!("kernel '{}' has no field '{field}'", request.kernel));
        }
    }
    if request.fields.is_empty() {
        return Err("fields must not be empty".into());
    }
    // Kernels that need the site's position get it from the host, so layers never hard-code it.
    let mut params = request.params;
    if let Some(map) = params.as_object_mut() {
        let accepts = |name: &str| kernel.params["properties"].get(name).is_some();
        if accepts("lat") && !map.contains_key("lat") {
            map.insert("lat".into(), json!(origin.lat));
        }
        if accepts("lon") && !map.contains_key("lon") {
            map.insert("lon".into(), json!(origin.lon));
        }
    }
    let job = engine.create_job(&request.kernel, &params).map_err(|e| e.to_string())?;
    let id = *next;
    *next += 1;
    let hz = request.max_hz.clamp(1.0, 120.0);
    streams.insert(
        id,
        Stream {
            conn: request.conn,
            job,
            fields: request.fields,
            encoding: request.encoding,
            interval: Duration::from_secs_f64(1.0 / hz),
            out: request.out,
            sent_revision: None,
            last_sent: Instant::now() - Duration::from_secs(1),
            running: true,
        },
    );
    Ok(id)
}

/// Sends the status and every field of a stream. Returns false if the connection's queue is full.
fn send_frames(engine: &mut Engine, id: u32, stream: &Stream, status: &mrs_engine::JobStatus) -> bool {
    if stream.out.capacity() < stream.fields.len() + 1 {
        return false;
    }
    let text = json!({ "t": "ev", "m": "engine.status", "p": {
        "stream": id, "state": status.state, "progress": status.progress, "revision": status.revision, "info": status.info,
    }});
    if stream.out.try_send(Out::Text(text.to_string())).is_err() {
        return false;
    }
    for (index, name) in stream.fields.iter().enumerate() {
        match engine.read_field(stream.job, name) {
            Ok(field) => {
                let frame = encode_frame(&field, stream.encoding, id, index as u32, status.revision as u32, status.progress);
                if stream.out.try_send(Out::Binary(frame)).is_err() {
                    return false;
                }
            }
            // A field that does not exist in the job's current mode is skipped, not fatal.
            Err(mrs_engine::EngineError::UnknownField(_)) => {}
            Err(e) => tracing::error!("stream {id} field {name}: {e}"),
        }
    }
    true
}
