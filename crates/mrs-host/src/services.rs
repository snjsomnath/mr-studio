//! Outside compute for layers (#278): services a site declares under `services` in site.json.
//!
//! A service is either a program the host starts beside the table (a Python model in its own
//! venv, say) or an address it forwards to. Surfaces reach a service only through the host,
//! at `/api/services/<id>/<path>`, from this computer. Answers are kept in the site folder, so a
//! table whose service is down or offline still shows the last answer to the same question.
//! Contract in docs/contracts/site.md, "Services".

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use mrs_site::{Service, Site};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;

/// Where answers are kept, inside the site folder. Hidden, so a `.mrstable` export leaves it out.
pub const CACHE_DIR: &str = ".mrstudio/services";
/// The longest a crashed service waits before it is started again.
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Lines of a service's own output kept for the operator.
const LOG_LINES: usize = 200;

/// What a service is doing, as the operator's view and `GET /api/services` show it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Making its venv or installing its requirements.
    Installing,
    Starting,
    Up,
    /// Not answering; the host starts it again after a pause.
    Down,
    /// A remote service: the host forwards and does not start anything.
    Remote,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    pub id: String,
    pub name: String,
    pub state: ServiceState,
    /// Why it is down or what it is installing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub restarts: u32,
    /// Where the host forwards to now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

struct Entry {
    spec: Service,
    status: Mutex<ServiceStatus>,
    log: Mutex<std::collections::VecDeque<String>>,
}

impl Entry {
    fn set(&self, state: ServiceState, message: Option<String>) {
        let mut status = self.status.lock().unwrap();
        status.state = state;
        status.message = message;
    }
    fn note(&self, line: String) {
        let mut log = self.log.lock().unwrap();
        if log.len() == LOG_LINES {
            log.pop_front();
        }
        log.push_back(line);
    }
}

/// A service's answer: status, content type and body, or why there was none.
pub type Answer = Result<(u16, String, axum::body::Bytes), String>;
type Pending = futures_util::future::Shared<futures_util::future::BoxFuture<'static, Answer>>;

/// How long a finished answer is given again to the same request: the views of one table send it
/// within moments of each other.
const SAME_REQUEST: Duration = Duration::from_secs(2);

/// The site's services. Dropping it stops every program it started.
pub struct Services {
    entries: BTreeMap<String, Arc<Entry>>,
    /// Requests in flight or just answered, by their cache file: identical ones share one answer.
    asked: Mutex<BTreeMap<PathBuf, (std::time::Instant, Pending)>>,
    cache: PathBuf,
    stop: watch::Sender<bool>,
}

impl Drop for Services {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

impl Services {
    /// Starts the site's local services and returns at once; they come up in the background.
    /// `incident` is told when one stops by itself, for the operator log.
    pub fn start(site: &Site, incident: impl Fn(String) + Send + Sync + 'static) -> Self {
        let (stop, stopped) = watch::channel(false);
        let incident = Arc::new(incident);
        let mut entries = BTreeMap::new();
        for spec in &site.manifest.services {
            let remote = spec.url.clone();
            let entry = Arc::new(Entry {
                status: Mutex::new(ServiceStatus {
                    id: spec.id.clone(),
                    name: spec.name.clone().unwrap_or_else(|| spec.id.clone()),
                    state: if remote.is_some() { ServiceState::Remote } else { ServiceState::Starting },
                    message: None,
                    restarts: 0,
                    address: remote.map(|u| u.trim_end_matches('/').to_string()),
                }),
                spec: spec.clone(),
                log: Default::default(),
            });
            if let Some(run) = &spec.run {
                if let Some(dir) = site.resolve(&run.cwd) {
                    let incident = incident.clone();
                    tokio::spawn(supervise(entry.clone(), dir, stopped.clone(), move |m| incident(m)));
                }
            }
            entries.insert(spec.id.clone(), entry);
        }
        Services { entries, asked: Default::default(), cache: site.dir.join(CACHE_DIR), stop }
    }

    pub fn statuses(&self) -> Vec<ServiceStatus> {
        self.entries.values().map(|e| e.status.lock().unwrap().clone()).collect()
    }

    /// The last lines a service wrote, newest last.
    pub fn log(&self, id: &str) -> Option<Vec<String>> {
        self.entries.get(id).map(|e| e.log.lock().unwrap().iter().cloned().collect())
    }

    /// The address to forward a request for `id` to, when it is up or remote.
    pub fn address(&self, id: &str) -> Result<String, Refusal> {
        let entry = self.entries.get(id).ok_or(Refusal::Unknown)?;
        let status = entry.status.lock().unwrap();
        match (&status.state, &status.address) {
            (ServiceState::Up | ServiceState::Remote, Some(address)) => Ok(address.clone()),
            _ => Err(Refusal::NotUp(status.state.clone(), status.message.clone())),
        }
    }

    /// Runs `ask` unless the same request (by its cache file) is in flight or was answered a
    /// moment ago, in which case that answer is given instead.
    pub async fn once(&self, key: PathBuf, ask: impl std::future::Future<Output = Answer> + Send + 'static) -> Answer {
        use futures_util::FutureExt;
        let pending = {
            let mut asked = self.asked.lock().unwrap();
            asked.retain(|_, (at, pending)| pending.peek().is_none() || at.elapsed() < SAME_REQUEST);
            match asked.get(&key) {
                Some((_, pending)) => pending.clone(),
                None => {
                    let pending = ask.boxed().shared();
                    asked.insert(key, (std::time::Instant::now(), pending.clone()));
                    pending
                }
            }
        };
        pending.await
    }

    pub fn knows(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    /// The file an answer to this request is kept in.
    pub fn cache_file(&self, id: &str, method: &str, path_and_query: &str, body: &[u8]) -> PathBuf {
        let mut key = Vec::with_capacity(method.len() + path_and_query.len() + body.len() + 2);
        key.extend_from_slice(method.as_bytes());
        key.push(b' ');
        key.extend_from_slice(path_and_query.as_bytes());
        key.push(b'\n');
        key.extend_from_slice(body);
        self.cache.join(id).join(format!("{:016x}", fnv1a(&key)))
    }

    /// A value a layer keeps under a name of its own (`ctx.service(id).remember`), for answers
    /// that took several requests, such as a finished job.
    pub fn kept_file(&self, id: &str, key: &str) -> PathBuf {
        self.cache.join(id).join(format!("kept-{:016x}", fnv1a(key.as_bytes())))
    }
}

#[derive(Debug)]
pub enum Refusal {
    Unknown,
    NotUp(ServiceState, Option<String>),
}

/// FNV-1a: a stable hash for cache file names, the same on every computer and version.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// The Python of a venv: `bin/python` on macOS and Linux, `Scripts\python.exe` on Windows.
fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// This computer's Python, for making a venv.
fn system_python() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

/// A free port on this computer, for a service to listen on.
fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn fill(text: &str, port: u16, python: &str) -> String {
    text.replace("{port}", &port.to_string()).replace("{python}", python)
}

/// Makes the venv and installs the requirements when either is missing or the requirements
/// changed since the last install (a stamp in the venv remembers which).
async fn install(entry: &Arc<Entry>, dir: &Path, stopped: &mut watch::Receiver<bool>) -> Result<Option<PathBuf>, String> {
    let run = entry.spec.run.as_ref().expect("a local service");
    let Some(venv) = run.venv.as_ref().map(|v| dir.join(v)) else { return Ok(None) };
    let python = venv_python(&venv);
    let requirements = run.requirements.as_ref().map(|r| dir.join(r));
    let wanted = match &requirements {
        Some(file) => std::fs::read(file).map(|b| format!("{:016x}", fnv1a(&b))).map_err(|e| format!("reading {}: {e}", file.display()))?,
        None => String::new(),
    };
    let stamp = venv.join(".mrstudio-installed");
    if python.is_file() && std::fs::read_to_string(&stamp).ok().as_deref() == Some(wanted.as_str()) {
        return Ok(Some(python));
    }
    if !python.is_file() {
        entry.set(ServiceState::Installing, Some("making its Python environment".into()));
        let mut make = tokio::process::Command::new(system_python());
        make.arg("-m").arg("venv").arg(&venv).current_dir(dir);
        step(entry, make, "python -m venv", stopped).await?;
    }
    if let Some(file) = &requirements {
        entry.set(
            ServiceState::Installing,
            Some(format!("installing {}", file.file_name().and_then(|n| n.to_str()).unwrap_or("requirements"))),
        );
        let mut pip = tokio::process::Command::new(&python);
        pip.args(["-m", "pip", "install", "--disable-pip-version-check", "-r"]).arg(file).current_dir(dir);
        step(entry, pip, "pip install", stopped).await?;
    }
    let _ = std::fs::write(&stamp, wanted);
    Ok(Some(python))
}

/// Runs one install step to its end, keeping its output in the service's log.
async fn step(
    entry: &Arc<Entry>,
    mut command: tokio::process::Command,
    what: &str,
    stopped: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("could not run {what}: {e}"))?;
    let lines = pipe_output(entry, &mut child);
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| format!("{what}: {e}"))?,
        _ = stopped.changed() => return Err("stopped".into()),
    };
    lines.await;
    if !status.success() {
        return Err(format!("{what} failed ({status}); see the service's log"));
    }
    Ok(())
}

/// Copies a child's output into the service's log, line by line, until both pipes close.
fn pipe_output(entry: &Arc<Entry>, child: &mut tokio::process::Child) -> impl std::future::Future<Output = ()> + Send + 'static {
    let pipes: Vec<Box<dyn tokio::io::AsyncRead + Unpin + Send>> = [
        child.stdout.take().map(|o| Box::new(o) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child.stderr.take().map(|e| Box::new(e) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let entry = entry.clone();
            async move {
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("[service {}] {line}", entry.spec.id);
                    entry.note(line);
                }
            }
        })
        .collect();
    async move {
        futures_util::future::join_all(readers).await;
    }
}

/// Supervises one local service: install, start, wait for health, restart after a crash.
async fn supervise(entry: Arc<Entry>, dir: PathBuf, mut stopped: watch::Receiver<bool>, incident: impl Fn(String) + Send + Sync + 'static) {
    let run = entry.spec.run.clone().expect("a local service");
    let health = entry.spec.health.clone().unwrap_or_else(|| "/".into());
    let start_within = Duration::from_secs_f64(run.start_s.unwrap_or(60.0).clamp(1.0, 3600.0));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("an HTTP client");
    let mut backoff = Duration::from_secs(1);
    loop {
        if *stopped.borrow() {
            return;
        }
        let python = match install(&entry, &dir, &mut stopped).await {
            Ok(python) => python,
            Err(why) if why == "stopped" => return,
            Err(why) => {
                entry.set(ServiceState::Down, Some(why.clone()));
                incident(format!("service '{}' could not be installed: {why}", entry.spec.id));
                // An install that failed fails again until someone fixes it: wait long.
                if wait(&mut stopped, MAX_BACKOFF).await {
                    return;
                }
                continue;
            }
        };
        let python = python.map(|p| p.display().to_string()).unwrap_or_else(|| system_python().to_string());
        let port = match free_port() {
            Ok(port) => port,
            Err(e) => {
                entry.set(ServiceState::Down, Some(format!("no free port: {e}")));
                if wait(&mut stopped, backoff).await {
                    return;
                }
                continue;
            }
        };
        entry.set(ServiceState::Starting, None);
        let program = fill(&run.command[0], port, &python);
        let mut command = tokio::process::Command::new(&program);
        command
            .args(run.command[1..].iter().map(|a| fill(a, port, &python)))
            .current_dir(&dir)
            .env("PORT", port.to_string())
            .envs(run.env.iter().map(|(k, v)| (k, fill(v, port, &python))))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                entry.set(ServiceState::Down, Some(format!("could not start {program}: {e}")));
                incident(format!("service '{}' could not start: {e}", entry.spec.id));
                if wait(&mut stopped, MAX_BACKOFF).await {
                    return;
                }
                continue;
            }
        };
        let output = tokio::spawn(pipe_output(&entry, &mut child));
        let address = format!("http://127.0.0.1:{port}");
        let started = SystemTime::now();
        // Up once its health path answers; down if it exits or does not answer in time.
        let mut up = false;
        let ended = loop {
            tokio::select! {
                status = child.wait() => break Some(status),
                _ = stopped.changed() => {
                    let _ = child.kill().await;
                    output.abort();
                    return;
                }
                _ = tokio::time::sleep(Duration::from_millis(if up { 3000 } else { 400 })) => {}
            }
            let healthy = client.get(format!("{address}{health}")).send().await.map(|r| r.status().is_success()).unwrap_or(false);
            if healthy && !up {
                up = true;
                backoff = Duration::from_secs(1);
                let mut status = entry.status.lock().unwrap();
                status.state = ServiceState::Up;
                status.message = None;
                status.address = Some(address.clone());
                tracing::info!("service '{}' is up at {address}", entry.spec.id);
            } else if !up && started.elapsed().unwrap_or_default() > start_within {
                let _ = child.kill().await;
                break None;
            }
        };
        output.abort();
        let why = match ended {
            Some(Ok(status)) => format!("it stopped ({status})"),
            Some(Err(e)) => format!("it stopped: {e}"),
            None => format!("it did not answer {health} within {} s", start_within.as_secs()),
        };
        {
            let mut status = entry.status.lock().unwrap();
            status.state = ServiceState::Down;
            status.message = Some(why.clone());
            status.address = None;
            status.restarts += 1;
        }
        incident(format!("service '{}': {why}; starting it again in {} s", entry.spec.id, backoff.as_secs()));
        if wait(&mut stopped, backoff).await {
            return;
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Waits, or returns true when the services are stopping.
async fn wait(stopped: &mut watch::Receiver<bool>, pause: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(pause) => *stopped.borrow(),
        _ = stopped.changed() => true,
    }
}
