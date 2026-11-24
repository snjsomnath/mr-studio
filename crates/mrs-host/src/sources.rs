//! The Sources manager (#41): the outside services a table reads from, and the keys they
//! need. A connection is a name, an address and a way of signing in, kept in
//! `sources.json` in the app's config folder. Its secret (a key, a password or a client
//! secret) is kept in the operating system's own store: the Keychain on macOS, the
//! Credential Manager on Windows. Neither ever goes into a table's folder, an export or
//! the repository.
//!
//! Surfaces never see a secret. They ask the host (`/api/sources/<id>/…`, `/api/wms`,
//! `/api/transit/…`), and the host adds the key to its own request to the service. The
//! host only does that for addresses on the connection's own server, so a key cannot be
//! sent anywhere else, and changing a connection's server forgets its key.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The name the keys are filed under in the Keychain and the Credential Manager.
pub const KEYCHAIN_SERVICE: &str = "MR Studio";

/// What kind of service a connection is. The kind decides the defaults and the test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Vasttrafik,
    Lantmateriet,
    Mapbox,
    Carto,
    Wms,
    Wmts,
    Arcgis,
    Tiles,
    Streetview,
    /// A phone relay (#89): phones join the table through it from any network.
    Relay,
}

/// How a request to the service is signed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Auth {
    /// Open: no key.
    #[default]
    None,
    /// The key as a query parameter, named by `param` (`access_token`, `api_key`, `key`).
    Query,
    /// The key in a request header, named by `param`.
    Header,
    /// `Authorization: Bearer <key>`.
    Bearer,
    /// A user name (`user`) and password: HTTP basic sign-in.
    Basic,
    /// OAuth client credentials: a client id (`user`) and secret are traded for a short-lived
    /// token at `param` (or `<address>/token`). With no client id, the secret is the ready
    /// `Basic` key that Västtrafik's developer portal shows.
    ClientCredentials,
}

/// The starting point for a new connection of one kind, as the Sources page offers it.
#[derive(Clone, Debug, Serialize)]
pub struct Template {
    pub kind: Kind,
    pub name: &'static str,
    /// One line on what it is for, shown on its card.
    pub purpose: &'static str,
    pub url: &'static str,
    pub auth: Auth,
    pub param: &'static str,
    /// Where someone gets a key or an account.
    pub get_key: &'static str,
    /// One per computer (a named service) rather than as many as wanted (a custom address).
    pub single: bool,
}

pub const TEMPLATES: [Template; 10] = [
    Template {
        kind: Kind::Vasttrafik,
        name: "Västtrafik",
        purpose: "Live trams, buses and ferries in western Sweden for Public transport",
        url: "https://ext-api.vasttrafik.se",
        auth: Auth::ClientCredentials,
        param: "",
        get_key: "https://developer.vasttrafik.se",
        single: true,
    },
    Template {
        kind: Kind::Lantmateriet,
        name: "Lantmäteriet",
        purpose: "Swedish maps and aerial photos (WMS and WMTS) with a Geotorget account",
        url: "https://maps.lantmateriet.se/topowebb/wms/v1",
        auth: Auth::Basic,
        param: "",
        get_key: "https://geotorget.lantmateriet.se",
        single: true,
    },
    Template {
        kind: Kind::Mapbox,
        name: "Mapbox",
        purpose: "Base maps and map styles, with an access token",
        url: "https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/{z}/{x}/{y}@2x",
        auth: Auth::Query,
        param: "access_token",
        get_key: "https://account.mapbox.com/access-tokens/",
        single: true,
    },
    Template {
        kind: Kind::Carto,
        name: "CARTO",
        purpose: "CARTO's light and dark base maps for picking a place and on the table",
        url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
        auth: Auth::Query,
        param: "api_key",
        get_key: "https://carto.com/basemaps",
        single: true,
    },
    Template {
        kind: Kind::Wms,
        name: "Web map (WMS)",
        purpose: "Any WMS service, open or with a sign-in, such as SLU or a municipality",
        url: "",
        auth: Auth::None,
        param: "",
        get_key: "",
        single: false,
    },
    Template {
        kind: Kind::Wmts,
        name: "Tiled web map (WMTS)",
        purpose: "Any WMTS service, open or with a sign-in",
        url: "",
        auth: Auth::None,
        param: "",
        get_key: "",
        single: false,
    },
    Template {
        kind: Kind::Arcgis,
        name: "ArcGIS service",
        purpose: "An ArcGIS REST map or feature service, open or with a token",
        url: "",
        auth: Auth::None,
        param: "token",
        get_key: "",
        single: false,
    },
    Template {
        kind: Kind::Tiles,
        name: "Map tiles",
        purpose: "Any {z}/{x}/{y} tile address, such as a base map with a key",
        url: "",
        auth: Auth::None,
        param: "",
        get_key: "",
        single: false,
    },
    Template {
        kind: Kind::Streetview,
        name: "Google Street View",
        purpose: "Street-level pictures on the controller for Isovist, with a Google Maps key",
        url: "https://maps.googleapis.com/maps/api/streetview",
        auth: Auth::Query,
        param: "key",
        get_key: "https://developers.google.com/maps/documentation/streetview/get-api-key",
        single: true,
    },
    Template {
        kind: Kind::Relay,
        name: "Phone relay",
        purpose: "Phones join from any network, over HTTPS, through your relay server (mrs-relay)",
        url: "https://relay.example.org",
        auth: Auth::Bearer,
        param: "",
        get_key: "https://github.com/snjsomnath/mr-studio/blob/main/docs/relay.md",
        single: true,
    },
];

pub fn template(kind: Kind) -> &'static Template {
    TEMPLATES.iter().find(|t| t.kind == kind).expect("every kind has a template")
}

/// One configured service, as `sources.json` keeps it. No secret in here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub auth: Auth,
    /// The query parameter or header that carries the key, or the token address.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub param: String,
    /// The user name or client id. Not a secret, so it can be shown.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub user: String,
    /// Whether a key was saved for it. Kept here so that listing sources never asks the
    /// keychain: on macOS that can open an "allow" prompt, and nothing should wait on one
    /// just to draw the Sources page. Files from before this field count as having a key.
    #[serde(default)]
    pub has_secret: Option<bool>,
}

impl Connection {
    pub fn keyed(&self) -> bool {
        self.has_secret.unwrap_or(false)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default = "one")]
    format: u32,
    #[serde(default)]
    sources: Vec<Connection>,
}

fn one() -> u32 {
    1
}

/// The result of the last Test.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub ok: bool,
    pub message: String,
    /// Seconds since 1970.
    pub at: u64,
}

/// A connection as the Sources page and the editor see it: whether it has a key, never the key.
#[derive(Clone, Debug, Serialize)]
pub struct View {
    #[serde(flatten)]
    pub connection: Connection,
    /// It can be used: it is open, or its key is there.
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
}

/// A change from the Sources page. Fields left out keep their value.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Change {
    /// Left out for a new connection; a named service then takes its kind as id.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub kind: Option<Kind>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub auth: Option<Auth>,
    #[serde(default)]
    pub param: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    /// A new key or password. Empty or left out keeps the one there is.
    #[serde(default)]
    pub secret: Option<String>,
    /// Forget the key.
    #[serde(default)]
    pub forget_secret: bool,
}

/// Where secrets live. The app uses the operating system's store; tests use memory.
pub trait Vault: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// The Keychain on macOS, the Credential Manager on Windows, the kernel keyring on Linux.
pub struct Keychain;

impl Keychain {
    fn entry(id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, &format!("source:{id}")).map_err(|e| e.to_string())
    }
}

impl Vault for Keychain {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match Self::entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        // Linux's kernel keyring can refuse the very first write of a session; once more is enough.
        match Self::entry(id)?.set_password(secret) {
            Err(keyring::Error::NoEntry) => Self::entry(id)?.set_password(secret).map_err(|e| e.to_string()),
            done => done.map_err(|e| e.to_string()),
        }
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Secrets in memory only, for tests and for a host started without the app.
#[derive(Default)]
pub struct MemoryVault(Mutex<HashMap<String, String>>);

impl Vault for MemoryVault {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

/// Why a request through a connection was not made, with the HTTP status the host answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
}

impl Refusal {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The app's connections and their keys. One per app; the host and the Sources page share it.
pub struct Sources {
    path: Option<PathBuf>,
    vault: std::sync::Arc<dyn Vault>,
    list: RwLock<Vec<Connection>>,
    /// Keys already read, so the Keychain is asked once per run (macOS may ask to allow it).
    secrets: Mutex<HashMap<String, Option<String>>>,
    status: Mutex<HashMap<String, Status>>,
    tokens: tokio::sync::Mutex<HashMap<String, (String, Instant)>>,
    client: reqwest::Client,
}

impl std::fmt::Debug for Sources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sources").field("path", &self.path).field("count", &self.list.read().unwrap().len()).finish()
    }
}

impl Sources {
    /// Reads `path` (a missing file is an empty list) and keeps secrets in `vault`.
    pub fn open(path: PathBuf, vault: Box<dyn Vault>) -> anyhow::Result<Self> {
        let list = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<File>(&text)?
                .sources
                .into_iter()
                .map(|mut c| {
                    c.has_secret = Some(c.has_secret.unwrap_or(c.auth != Auth::None));
                    c
                })
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self::new(Some(path), vault, list))
    }

    /// No file and no keychain: what tests and a bare host use.
    pub fn in_memory() -> Self {
        Self::new(None, Box::<MemoryVault>::default(), Vec::new())
    }

    fn new(path: Option<PathBuf>, vault: Box<dyn Vault>, list: Vec<Connection>) -> Self {
        let client = reqwest::Client::builder().user_agent("MR Studio").timeout(Duration::from_secs(30)).build().expect("an HTTP client");
        Self {
            path,
            vault: vault.into(),
            list: RwLock::new(list),
            secrets: Default::default(),
            status: Default::default(),
            tokens: Default::default(),
            client,
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn connection(&self, id: &str) -> Option<Connection> {
        self.list.read().unwrap().iter().find(|c| c.id == id).cloned()
    }

    /// The key, read from the keychain once per run. The read runs off the async workers:
    /// a keychain prompt then holds up only the request that needs the key.
    async fn secret(&self, id: &str) -> Result<Option<String>, String> {
        let known = self.secrets.lock().unwrap().get(id).cloned();
        if let Some(known) = known {
            return Ok(known);
        }
        let vault = self.vault.clone();
        let owned = id.to_string();
        let secret = tokio::task::spawn_blocking(move || vault.get(&owned)).await.map_err(|e| e.to_string())??.filter(|s| !s.is_empty());
        self.secrets.lock().unwrap().insert(id.into(), secret.clone());
        Ok(secret)
    }

    /// Every connection, without its secret.
    pub fn list(&self) -> Vec<View> {
        let list = self.list.read().unwrap().clone();
        let status = self.status.lock().unwrap().clone();
        list.into_iter()
            .map(|connection| {
                let ready = connection.auth == Auth::None || connection.keyed();
                View { status: status.get(&connection.id).cloned(), connection, ready }
            })
            .collect()
    }

    /// What the Sources page shows: the connections and the kinds that can be added.
    pub fn page(&self) -> Value {
        json!({ "sources": self.list(), "templates": TEMPLATES, "file": self.path })
    }

    /// Adds or changes a connection, and stores or forgets its key.
    pub fn save(&self, change: Change) -> Result<View, String> {
        let mut list = self.list.write().unwrap();
        let at = change.id.as_deref().and_then(|id| list.iter().position(|c| c.id == id));
        let mut connection = match at {
            Some(i) => list[i].clone(),
            None => {
                let kind = change.kind.ok_or("say which kind of service this is")?;
                let t = template(kind);
                let id = match change.id.clone() {
                    Some(id) => id,
                    None if t.single => kind_id(kind),
                    None => unique_id(&list, change.name.as_deref().unwrap_or(t.name)),
                };
                if !mrs_site::is_instance_id(&id) {
                    return Err(format!("'{id}' must be lowercase letters, digits and dashes"));
                }
                if list.iter().any(|c| c.id == id) {
                    return Err(format!("there is already a source called '{id}'"));
                }
                Connection {
                    id,
                    kind,
                    name: t.name.into(),
                    url: t.url.into(),
                    auth: t.auth,
                    param: t.param.into(),
                    user: String::new(),
                    has_secret: Some(false),
                }
            }
        };
        let before = connection.clone();
        if let Some(kind) = change.kind {
            if at.is_some() && kind != connection.kind {
                return Err("a source keeps its kind; add a new one instead".into());
            }
        }
        if let Some(name) = change.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
            connection.name = name.chars().take(80).collect();
        }
        if let Some(url) = change.url {
            connection.url = url.trim().to_string();
        }
        if let Some(auth) = change.auth {
            connection.auth = auth;
        }
        if let Some(param) = change.param {
            connection.param = param.trim().to_string();
        }
        if let Some(user) = change.user {
            connection.user = user.trim().to_string();
        }
        check(&connection)?;

        // A key belongs to the server it was given for: moving the address elsewhere forgets it,
        // so nothing can redirect a saved key to another server.
        let moved = at.is_some() && origin(&before.url) != origin(&connection.url);
        let new_secret = change.secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(secret) = &new_secret {
            if secret.len() > 2000 {
                return Err("that key is longer than any service uses".into());
            }
            self.vault.set(&connection.id, secret)?;
            self.secrets.lock().unwrap().insert(connection.id.clone(), Some(secret.clone()));
            connection.has_secret = Some(true);
        } else if change.forget_secret || moved {
            self.vault.delete(&connection.id)?;
            self.secrets.lock().unwrap().insert(connection.id.clone(), None);
            connection.has_secret = Some(false);
        }
        if new_secret.is_some() || change.forget_secret || moved || before != connection {
            self.status.lock().unwrap().remove(&connection.id);
        }
        self.tokens.try_lock().map(|mut t| t.remove(&connection.id)).ok();

        match at {
            Some(i) => list[i] = connection.clone(),
            None => list.push(connection.clone()),
        }
        self.write(&list)?;
        drop(list);
        Ok(self.list().into_iter().find(|v| v.connection.id == connection.id).expect("just saved"))
    }

    /// Removes a connection and its key.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut list = self.list.write().unwrap();
        let before = list.len();
        list.retain(|c| c.id != id);
        if list.len() == before {
            return Err(format!("there is no source called '{id}'"));
        }
        self.vault.delete(id)?;
        self.secrets.lock().unwrap().remove(id);
        self.status.lock().unwrap().remove(id);
        self.write(&list)
    }

    fn write(&self, list: &[Connection]) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        let text = serde_json::to_string_pretty(&File { format: 1, sources: list.to_vec() }).expect("json");
        (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let partial = path.with_extension("json.part");
            std::fs::write(&partial, text)?;
            std::fs::rename(&partial, path)
        })()
        .map_err(|e| format!("{} could not be saved: {e}", path.display()))
    }

    /// A GET to `url` on the connection's server, signed with its key. `url` must be on the
    /// same server as the connection's own address.
    pub async fn request(&self, id: &str, url: reqwest::Url) -> Result<reqwest::RequestBuilder, Refusal> {
        let connection = self.connection(id).ok_or_else(|| Refusal::new(404, format!("there is no source called '{id}'")))?;
        if origin(url.as_str()) != origin(&connection.url) || origin(url.as_str()).is_none() {
            return Err(Refusal::new(403, format!("{} only signs requests to its own server", connection.name)));
        }
        self.sign(&connection, url, false).await
    }

    async fn sign(&self, connection: &Connection, mut url: reqwest::Url, fresh_token: bool) -> Result<reqwest::RequestBuilder, Refusal> {
        let key = if connection.auth == Auth::None {
            None
        } else {
            Some(
                self.secret(&connection.id)
                    .await
                    .map_err(|e| Refusal::new(500, format!("the key for {} could not be read from the keychain: {e}", connection.name)))?
                    .ok_or_else(|| Refusal::new(424, format!("{} needs a key: add it in Sources", connection.name)))?,
            )
        };
        let secret = || -> Result<String, Refusal> { Ok(key.clone().unwrap_or_default()) };
        Ok(match connection.auth {
            Auth::None => self.client.get(url),
            Auth::Query => {
                let param = if connection.param.is_empty() { "key" } else { &connection.param };
                url.query_pairs_mut().append_pair(param, &secret()?);
                self.client.get(url)
            }
            Auth::Header => {
                let name = if connection.param.is_empty() { "X-API-Key" } else { &connection.param };
                self.client.get(url).header(name, secret()?)
            }
            Auth::Bearer => self.client.get(url).bearer_auth(secret()?),
            Auth::Basic => self.client.get(url).basic_auth(&connection.user, Some(secret()?)),
            Auth::ClientCredentials => {
                let token = self.token(connection, &secret()?, fresh_token).await?;
                self.client.get(url).bearer_auth(token)
            }
        })
    }

    /// An OAuth token for client credentials, reused until a minute before it runs out.
    async fn token(&self, connection: &Connection, secret: &str, fresh: bool) -> Result<String, Refusal> {
        let mut tokens = self.tokens.lock().await;
        if !fresh {
            if let Some((token, until)) = tokens.get(&connection.id) {
                if Instant::now() < *until {
                    return Ok(token.clone());
                }
            }
        }
        let address =
            if connection.param.is_empty() { format!("{}/token", connection.url.trim_end_matches('/')) } else { connection.param.clone() };
        let ask = self.client.post(&address).form(&[("grant_type", "client_credentials")]);
        let ask = if connection.user.is_empty() {
            ask.header("Authorization", format!("Basic {}", secret.trim_start_matches("Basic ").trim()))
        } else {
            ask.basic_auth(&connection.user, Some(secret))
        };
        let answer = ask.send().await.map_err(|e| unreachable(connection, e))?;
        let status = answer.status();
        if !status.is_success() {
            return Err(Refusal::new(502, refused_words(connection, status.as_u16())));
        }
        let body: Value = answer.json().await.map_err(|_| Refusal::new(502, format!("{} answered without a token", connection.name)))?;
        let token =
            body["access_token"].as_str().ok_or_else(|| Refusal::new(502, format!("{} answered without a token", connection.name)))?;
        let lasts = body["expires_in"].as_u64().unwrap_or(600).saturating_sub(60).max(30);
        tokens.insert(connection.id.clone(), (token.to_string(), Instant::now() + Duration::from_secs(lasts)));
        Ok(token.to_string())
    }

    /// Sends a signed GET and hands back the answer when it is a success.
    pub async fn fetch(&self, id: &str, url: reqwest::Url) -> Result<reqwest::Response, Refusal> {
        let connection = self.connection(id).ok_or_else(|| Refusal::new(404, format!("there is no source called '{id}'")))?;
        let answer = self.request(id, url).await?.send().await.map_err(|e| unreachable(&connection, e))?;
        if !answer.status().is_success() {
            return Err(Refusal::new(502, refused_words(&connection, answer.status().as_u16())));
        }
        Ok(answer)
    }

    /// The address of one map tile from a tile connection's `{z}/{x}/{y}` template.
    pub fn tile_url(&self, id: &str, z: u32, x: u32, y: u32) -> Result<reqwest::Url, Refusal> {
        let connection = self.connection(id).ok_or_else(|| Refusal::new(404, format!("there is no source called '{id}'")))?;
        if !connection.url.contains("{z}") {
            return Err(Refusal::new(400, format!("{} is not a tile address with {{z}}/{{x}}/{{y}}", connection.name)));
        }
        if z > 24 || x >= 1 << z || y >= 1 << z {
            return Err(Refusal::new(400, "no such tile"));
        }
        let url =
            connection.url.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string()).replace("{s}", "a");
        reqwest::Url::parse(&url).map_err(|e| Refusal::new(400, e.to_string()))
    }

    /// Tries the connection the way it will be used and remembers the answer.
    /// The phone relay this computer has, ready to use (#89): its address and the header that
    /// signs the host in. None without one, or without its token.
    pub async fn relay(&self) -> Option<crate::relay::RelayLink> {
        let view = self.list().into_iter().find(|v| v.connection.kind == Kind::Relay && v.ready)?;
        let url = view.connection.url.trim_end_matches('/').to_string();
        let probe = reqwest::Url::parse(&format!("{url}/host")).ok()?;
        let signed = self.request(&view.connection.id, probe).await.ok()?.build().ok()?;
        let authorization = signed.headers().get(reqwest::header::AUTHORIZATION)?.to_str().ok()?.to_string();
        Some(crate::relay::RelayLink { url, authorization })
    }

    pub async fn test(&self, id: &str) -> Result<Status, String> {
        let connection = self.connection(id).ok_or_else(|| format!("there is no source called '{id}'"))?;
        let (ok, message) = match self.try_it(&connection).await {
            Ok(message) => (true, message),
            Err(refusal) => (false, refusal.message),
        };
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let status = Status { ok, message, at };
        self.status.lock().unwrap().insert(connection.id.clone(), status.clone());
        Ok(status)
    }

    async fn try_it(&self, c: &Connection) -> Result<String, Refusal> {
        let parse = |url: &str| reqwest::Url::parse(url).map_err(|_| Refusal::new(400, "the address is not a web address"));
        let host = origin(&c.url).unwrap_or_default();
        let send = |request: reqwest::RequestBuilder| async move { request.send().await.map_err(|e| unreachable(c, e)) };
        match c.kind {
            Kind::Vasttrafik => {
                let _signed_in = self.sign(c, parse(&c.url)?, true).await?;
                Ok("Signed in. Live vehicles can be shown.".into())
            }
            Kind::Mapbox if c.auth == Auth::Query => {
                let token = self.secret(&c.id).await.ok().flatten().ok_or_else(|| Refusal::new(424, "Add the access token first."))?;
                let mut url = parse(&format!("{host}/tokens/v2"))?;
                url.query_pairs_mut().append_pair(&c.param, &token);
                let answer = send(self.client.get(url)).await?;
                let body: Value = answer.json().await.unwrap_or(Value::Null);
                match body["code"].as_str() {
                    Some("TokenValid") => Ok("The token works.".into()),
                    Some(code) => Err(Refusal::new(502, format!("Mapbox says the token is not valid ({code})."))),
                    None => Err(Refusal::new(502, "Mapbox did not answer as expected.")),
                }
            }
            Kind::Relay => {
                let answer = send(self.sign(c, parse(&format!("{}/health", c.url.trim_end_matches('/')))?, false).await?).await?;
                if !answer.status().is_success() {
                    return Err(Refusal::new(502, format!("The relay answered {}.", answer.status().as_u16())));
                }
                Ok("The relay answers. Phones join through it the next time a table starts.".into())
            }
            Kind::Mapbox | Kind::Carto | Kind::Tiles => {
                let url = self.tile_url(&c.id, 0, 0, 0)?;
                let answer = send(self.sign(c, url, false).await?).await?;
                let kind = content_type(&answer);
                if !answer.status().is_success() {
                    return Err(Refusal::new(502, refused_words(c, answer.status().as_u16())));
                }
                if !kind.starts_with("image/") && !kind.contains("protobuf") {
                    return Err(Refusal::new(502, format!("The tile came back as {kind}, not a picture.")));
                }
                Ok("A map tile came back.".into())
            }
            Kind::Lantmateriet | Kind::Wms | Kind::Wmts => {
                let wmts = c.kind == Kind::Wmts || c.url.to_ascii_lowercase().contains("wmts");
                let mut url = parse(&c.url)?;
                if !url.path().ends_with(".xml") {
                    url.query_pairs_mut()
                        .append_pair("SERVICE", if wmts { "WMTS" } else { "WMS" })
                        .append_pair("REQUEST", "GetCapabilities");
                }
                let answer = send(self.sign(c, url, false).await?).await?;
                if !answer.status().is_success() {
                    return Err(Refusal::new(502, refused_words(c, answer.status().as_u16())));
                }
                let text = answer.text().await.unwrap_or_default();
                if text.contains("ServiceException") || text.contains("ExceptionReport") {
                    return Err(Refusal::new(502, "The service answered with an error. Check the address."));
                }
                if !text.contains("Capabilities") {
                    return Err(Refusal::new(502, "That address did not answer like a map service."));
                }
                let layers = text.matches("<Layer").count().max(text.matches("<Layer>").count());
                Ok(if layers > 0 { format!("The service answers, with {layers} layers.") } else { "The service answers.".into() })
            }
            Kind::Streetview => {
                // The metadata service is free and says whether the key works without using up a picture.
                let mut url = parse(&format!("{host}/maps/api/streetview/metadata"))?;
                url.query_pairs_mut().append_pair("location", "57.68838,11.97776");
                let answer = send(self.sign(c, url, false).await?).await?;
                if !answer.status().is_success() {
                    return Err(Refusal::new(502, refused_words(c, answer.status().as_u16())));
                }
                let body: Value = answer.json().await.unwrap_or(Value::Null);
                match body["status"].as_str() {
                    Some("OK") | Some("ZERO_RESULTS") => Ok("The key works.".into()),
                    Some("REQUEST_DENIED") => Err(Refusal::new(
                        502,
                        "Google refused the key. Turn on the Street View Static API for it in the Google Cloud console.",
                    )),
                    Some(status) => Err(Refusal::new(502, format!("Google answered {status}."))),
                    None => Err(Refusal::new(502, "Google did not answer as expected.")),
                }
            }
            Kind::Arcgis => {
                let mut url = parse(&c.url)?;
                url.query_pairs_mut().append_pair("f", "json");
                let answer = send(self.sign(c, url, false).await?).await?;
                if !answer.status().is_success() {
                    return Err(Refusal::new(502, refused_words(c, answer.status().as_u16())));
                }
                let body: Value =
                    answer.json().await.map_err(|_| Refusal::new(502, "That address did not answer like an ArcGIS service."))?;
                if let Some(error) = body.get("error") {
                    let code = error["code"].as_u64().unwrap_or(0) as u16;
                    return Err(Refusal::new(
                        502,
                        if code == 498 || code == 499 {
                            refused_words(c, 401)
                        } else {
                            format!("The service said: {}", error["message"].as_str().unwrap_or("an error"))
                        },
                    ));
                }
                Ok("The service answers.".into())
            }
        }
    }
}

/// `scheme://host:port` of an address, or `None` when it is not a web address. Template
/// placeholders such as `{s}` in a host make it no origin at all, which is never matched.
pub fn origin(url: &str) -> Option<String> {
    let url = reqwest::Url::parse(url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some(format!("{}://{}:{}", url.scheme(), url.host_str()?, url.port_or_known_default()?))
}

fn check(c: &Connection) -> Result<(), String> {
    if c.url.is_empty() {
        return Err("give the service's address".into());
    }
    let probe = c.url.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");
    let url = reqwest::Url::parse(&probe).map_err(|_| "the address is not a web address".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("the address must start with https:// (or http://)".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("put the user name and password in their own fields, not in the address".into());
    }
    if c.auth != Auth::None && url.scheme() == "http" && !matches!(url.host_str(), Some("localhost" | "127.0.0.1")) {
        return Err("a key is only sent over https://".into());
    }
    if matches!(c.auth, Auth::Query | Auth::Header) && c.param.is_empty() && c.kind != Kind::Tiles {
        return Err("name the parameter or header that carries the key".into());
    }
    if matches!(c.auth, Auth::Basic) && c.user.is_empty() {
        return Err("give the user name".into());
    }
    Ok(())
}

fn kind_id(kind: Kind) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn unique_id(list: &[Connection], name: &str) -> String {
    let mut base: String = name
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'å' | 'ä' => 'a',
            'ö' => 'o',
            c if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    while base.contains("--") {
        base = base.replace("--", "-");
    }
    let base = base.trim_matches('-').chars().take(40).collect::<String>();
    let base = if base.is_empty() || !base.starts_with(|c: char| c.is_ascii_lowercase()) {
        format!("source-{base}").trim_end_matches('-').to_string()
    } else {
        base
    };
    let mut id = base.clone();
    let mut n = 2;
    while list.iter().any(|c| c.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

fn content_type(answer: &reqwest::Response) -> String {
    answer.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Words for a failed request. The address is left out: it may carry the key.
fn unreachable(c: &Connection, e: reqwest::Error) -> Refusal {
    let e = e.without_url();
    let why = if e.is_timeout() {
        "it did not answer in time".to_string()
    } else if e.is_connect() {
        "there is no connection to it".to_string()
    } else {
        e.to_string()
    };
    Refusal::new(502, format!("{} could not be reached: {why}.", c.name))
}

fn refused_words(c: &Connection, status: u16) -> String {
    match status {
        401 | 403 if c.auth == Auth::None => format!("{} wants a sign-in ({status}). Add a key or a login.", c.name),
        401 | 403 => format!("{} did not accept the key or login ({status}).", c.name),
        404 => format!("{} has nothing at that address (404).", c.name),
        429 => format!("{} says too many requests (429). Try again in a minute.", c.name),
        _ => format!("{} answered {status}.", c.name),
    }
}

/// The folder the desktop app keeps its settings in (Tauri's `app_config_dir` for
/// `app.mrstudio.studio`), so a host run from the command line finds the same sources.
pub fn app_config_dir() -> Option<PathBuf> {
    const ID: &str = "app.mrstudio.studio";
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join(ID))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|d| PathBuf::from(d).join("Library/Application Support").join(ID))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|d| PathBuf::from(d).join(".config")))
            .map(|d| d.join(ID))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(kind: Kind) -> Change {
        Change { kind: Some(kind), ..Default::default() }
    }

    #[test]
    fn named_services_take_their_kind_as_id_and_their_defaults() {
        let sources = Sources::in_memory();
        let v = sources.save(change(Kind::Mapbox)).unwrap();
        assert_eq!(v.connection.id, "mapbox");
        assert_eq!(v.connection.param, "access_token");
        assert!(!v.ready, "a key is still needed");
        assert_eq!(v.connection.has_secret, Some(false));
        assert!(sources.save(change(Kind::Mapbox)).is_err(), "one Mapbox per computer");
    }

    #[test]
    fn custom_sources_get_an_id_from_their_name() {
        let sources = Sources::in_memory();
        let make = |name: &str| {
            sources.save(Change { name: Some(name.into()), url: Some("https://maps.slu.se/wms".into()), ..change(Kind::Wms) }).unwrap()
        };
        assert_eq!(make("SLU Skogskarta").connection.id, "slu-skogskarta");
        assert_eq!(make("SLU Skogskarta").connection.id, "slu-skogskarta-2");
        assert_eq!(make("Göteborgs stad").connection.id, "goteborgs-stad");
    }

    #[test]
    fn the_secret_is_stored_apart_and_never_listed() {
        let dir = std::env::temp_dir().join(format!("mrs-sources-{}", std::process::id()));
        let path = dir.join("sources.json");
        let sources = Sources::open(path.clone(), Box::<MemoryVault>::default()).unwrap();
        sources.save(Change { secret: Some("pk.secret-value".into()), ..change(Kind::Mapbox) }).unwrap();
        let file = std::fs::read_to_string(&path).unwrap();
        assert!(!file.contains("secret-value"), "the key stays out of sources.json: {file}");
        let listed = serde_json::to_string(&sources.page()).unwrap();
        assert!(!listed.contains("secret-value"));
        assert!(sources.list()[0].ready && sources.list()[0].connection.keyed());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn moving_a_source_to_another_server_forgets_its_key() {
        let sources = Sources::in_memory();
        sources.save(Change { secret: Some("pk.abc".into()), ..change(Kind::Mapbox) }).unwrap();
        let same = sources
            .save(Change {
                id: Some("mapbox".into()),
                url: Some("https://api.mapbox.com/styles/v1/me/dark/tiles/256/{z}/{x}/{y}".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(same.connection.keyed(), "same server keeps the key");
        let moved = sources
            .save(Change { id: Some("mapbox".into()), url: Some("https://evil.example.org/{z}/{x}/{y}".into()), ..Default::default() })
            .unwrap();
        assert!(!moved.connection.keyed(), "another server loses it");
    }

    #[tokio::test]
    async fn requests_are_signed_only_for_their_own_server() {
        let sources = Sources::in_memory();
        sources.save(Change { secret: Some("pk.abc".into()), ..change(Kind::Mapbox) }).unwrap();
        let elsewhere = reqwest::Url::parse("https://example.org/steal").unwrap();
        assert_eq!(sources.request("mapbox", elsewhere).await.unwrap_err().status, 403);
        let tile = sources.tile_url("mapbox", 3, 4, 2).unwrap();
        let signed = sources.request("mapbox", tile).await.unwrap().build().unwrap();
        assert_eq!(signed.url().as_str(), "https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/3/4/2@2x?access_token=pk.abc");
    }

    #[tokio::test]
    async fn basic_and_header_keys_go_in_headers() {
        let sources = Sources::in_memory();
        sources.save(Change { user: Some("anna".into()), secret: Some("pw".into()), ..change(Kind::Lantmateriet) }).unwrap();
        let url = reqwest::Url::parse("https://maps.lantmateriet.se/topowebb/wms/v1?REQUEST=GetMap").unwrap();
        let signed = sources.request("lantmateriet", url).await.unwrap().build().unwrap();
        assert_eq!(signed.headers()["authorization"], "Basic YW5uYTpwdw==");
        assert!(!signed.url().as_str().contains("pw"));
    }

    #[tokio::test]
    async fn a_missing_key_is_said_plainly() {
        let sources = Sources::in_memory();
        sources.save(change(Kind::Carto)).unwrap();
        let tile = sources.tile_url("carto", 0, 0, 0).unwrap();
        let refusal = sources.request("carto", tile).await.unwrap_err();
        assert_eq!(refusal.status, 424);
        assert!(refusal.message.contains("needs a key"));
    }

    /// A keychain that would show an "allow" prompt: reading it must not be needed to list sources.
    struct Prompting;
    impl Vault for Prompting {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            panic!("listing sources must not read the keychain")
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn listing_never_reads_the_keychain() {
        let dir = std::env::temp_dir().join(format!("mrs-sources-list-{}", std::process::id()));
        let path = dir.join("sources.json");
        std::fs::create_dir_all(&dir).unwrap();
        // A file from before `has_secret` was kept: a source that signs in counts as keyed.
        std::fs::write(&path, r#"{"format":1,"sources":[{"id":"mapbox","kind":"mapbox","name":"Mapbox","url":"https://api.mapbox.com/{z}/{x}/{y}","auth":"query","param":"access_token"}]}"#).unwrap();
        let sources = Sources::open(path, Box::new(Prompting)).unwrap();
        let listed = sources.list();
        assert!(listed[0].ready && listed[0].connection.keyed());
        sources.save(Change { kind: Some(Kind::Carto), secret: Some("k".into()), ..Default::default() }).unwrap();
        assert!(sources.page()["sources"][1]["has_secret"].as_bool().unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn addresses_are_checked() {
        let sources = Sources::in_memory();
        let bad = |url: &str, auth: Auth| {
            sources.save(Change { url: Some(url.into()), auth: Some(auth), name: Some("x".into()), ..change(Kind::Wms) }).is_err()
        };
        assert!(bad("file:///etc/passwd", Auth::None));
        assert!(bad("https://user:pw@maps.example.org/wms", Auth::None));
        assert!(bad("http://maps.example.org/wms", Auth::Bearer), "keys only over https");
        assert!(bad("https://maps.example.org/wms", Auth::Basic), "basic needs a user");
        assert!(!bad("https://maps.example.org/wms", Auth::None));
    }

    #[test]
    fn tiles_stay_in_range() {
        let sources = Sources::in_memory();
        sources.save(change(Kind::Carto)).unwrap();
        assert!(sources.tile_url("carto", 2, 4, 0).is_err());
        assert_eq!(sources.tile_url("carto", 2, 3, 1).unwrap().as_str(), "https://basemaps.cartocdn.com/light_all/2/3/1@2x.png");
    }
}
