//! Runs the engine on its own thread and streams fields to connections.
//!
//! The thread steps every open stream inside a frame budget and pushes a frame
//! when a job's revision changes. Slow connections lose frames, never queue them.
//!
//! A table runs all day with nobody at the computer (#79), so the thread looks after itself:
//! when the engine panics or its GPU is lost, it starts a new engine (on the CPU after a GPU
//! failure) with the same scene and reports an [`Incident`]. Streams do not survive that; the
//! host tells the surfaces with `engine.restarted` and they open new ones.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
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
    Set {
        conn: u64,
        stream: u32,
        params: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Close {
        conn: u64,
        stream: u32,
    },
    CloseConnection(u64),
    LoadScene(SceneData, oneshot::Sender<Result<(), String>>),
    Relocate(SceneData, LonLat, oneshot::Sender<Result<(), String>>),
    /// For tests and the soak run: makes the engine thread fail as a GPU fault would.
    Fault,
}

/// Something the engine thread recovered from, for the operator log and the surfaces.
#[derive(Debug, Clone)]
pub struct Incident {
    /// What happened and what was done, in words for the operator log.
    pub message: String,
    /// The backend the new engine runs on.
    pub backend: Backend,
}

/// Why `run` returned.
enum Exit {
    /// The host dropped its handle: the thread ends.
    Closed,
    /// The GPU device was lost; the engine must be replaced.
    Lost,
}

/// After this many restarts within a minute the thread waits before trying again, so a fault
/// that comes back at once does not spin a core.
const RESTARTS_PER_MINUTE: usize = 5;

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
    pub fn spawn(backend: Backend, scene: SceneData, origin: LonLat, incidents: tmpsc::UnboundedSender<Incident>) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new().name("mrs-engine".into()).spawn(move || supervise(backend, scene, origin, rx, ready_tx, incidents))?;
        ready_rx.recv()?.map_err(|e| anyhow!("engine failed to start: {e}"))?;
        Ok(Self { tx })
    }

    /// Makes the engine thread fail as a GPU fault would. For tests and soak runs (#79).
    #[doc(hidden)]
    pub fn inject_fault(&self) {
        let _ = self.send(Command::Fault);
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

    /// Replaces the scene of a table that moved or changed size. Every stream is closed, since
    /// its fields no longer fit; surfaces reload on `site.changed` and open new ones.
    pub async fn relocate(&self, scene: SceneData, origin: LonLat) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Relocate(scene, origin, reply)).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    pub fn close_connection(&self, conn: u64) {
        let _ = self.send(Command::CloseConnection(conn));
    }
}

/// Runs engines on this thread until the host lets go: a new one after each panic or GPU loss.
fn supervise(
    requested: Backend,
    scene: SceneData,
    origin: LonLat,
    rx: mpsc::Receiver<Command>,
    ready: mpsc::Sender<Result<(), String>>,
    incidents: tmpsc::UnboundedSender<Incident>,
) {
    let mut backend = requested;
    // The scene and place the next engine starts with; `run` keeps them current.
    let mut current = (scene, origin);
    let mut started = false;
    let mut restarts: Vec<Instant> = Vec::new();
    let mut reason = String::new();
    loop {
        let built = Engine::new(EngineConfig { backend }).and_then(|mut e| e.load_scene(current.0.clone()).map(|_| e));
        let engine = match built {
            Ok(engine) => engine,
            Err(e) if !started => {
                let _ = ready.send(Err(e.to_string()));
                return;
            }
            Err(e) if backend != Backend::Cpu => {
                reason = format!("{reason}; a new engine on the GPU failed too ({e})");
                backend = Backend::Cpu;
                continue;
            }
            Err(e) => {
                tracing::error!("the engine could not be started again: {e}");
                let _ = incidents.send(Incident { message: format!("{reason}. The engine could not be started again: {e}"), backend });
                return;
            }
        };
        let running_on = engine.info().backend;
        if started {
            let message = format!("{reason}. A new engine runs on the {}.", if running_on == Backend::Gpu { "GPU" } else { "CPU" });
            tracing::warn!("{message}");
            let _ = incidents.send(Incident { message, backend: running_on });
        } else {
            let _ = ready.send(Ok(()));
            started = true;
        }
        let outcome = catch_unwind(AssertUnwindSafe(|| run(engine, &mut current, &rx)));
        reason = match outcome {
            Ok(Exit::Closed) => return,
            Ok(Exit::Lost) => "The GPU was lost".to_string(),
            Err(panic) => {
                let what = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_default();
                format!("The engine failed ({})", if what.is_empty() { "no message" } else { what.as_str() })
            }
        };
        // A GPU that failed once is not trusted again until the table is started anew.
        if running_on == Backend::Gpu {
            backend = Backend::Cpu;
        }
        let now = Instant::now();
        restarts.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        restarts.push(now);
        if restarts.len() > RESTARTS_PER_MINUTE {
            std::thread::sleep(Duration::from_secs(10));
        }
    }
}

fn run(mut engine: Engine, current: &mut (SceneData, LonLat), rx: &mpsc::Receiver<Command>) -> Exit {
    let mut origin = current.1;
    let mut streams: HashMap<u32, Stream> = HashMap::new();
    let mut next_stream = 1u32;
    let mut busy = false;
    loop {
        // Sleep on the command channel when there is nothing to compute or send.
        let first = if busy {
            match rx.try_recv() {
                Ok(c) => Some(c),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return Exit::Closed,
            }
        } else {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(c) => Some(c),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return Exit::Closed,
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
                    current.0 = scene.clone();
                    let _ = reply.send(engine.load_scene(scene).map_err(|e| e.to_string()));
                }
                Command::Relocate(scene, at, reply) => {
                    for (_, stream) in streams.drain() {
                        engine.drop_job(stream.job);
                    }
                    origin = at;
                    *current = (scene.clone(), at);
                    let _ = reply.send(engine.load_scene(scene).map_err(|e| e.to_string()));
                }
                Command::Fault => panic!("a fault was injected"),
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
        if engine.lost() {
            return Exit::Lost;
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
