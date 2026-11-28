//! MR Studio licences (#725): an offline licence file from Nodal Works, what it entitles a
//! computer to, and a random install code that counts computers without knowing anything
//! about them.
//!
//! Rules, from the thread that asked for this:
//! - Works offline. Nothing here talks to a network.
//! - Never stops a table that is presenting. Reminders are for the editor and Home only.
//! - The source is public, so a check can always be built out. For now licence files are on
//!   the honour system (Sanjay, 2026-11-28): unsigned and readable. Signing with an Ed25519
//!   key is built and switched off ([`SIGNING_REQUIRED`]); with it, an official build cannot
//!   be given a forged licence. The BSL makes using a patched build in production a breach.
//! - Nothing personal: the install code is random, and no file leaves the computer.
//! - All of it is switched off ([`SHOWN`], [`ENFORCED`], [`SIGNING_REQUIRED`]) until Sanjay
//!   turns it on.
//!
//! The file format and the CLI are described in docs/licensing.md.

pub mod date;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub use date::Day;

/// Whether the app shows anything about licences: the Licence page in Settings, the first-run
/// question, reminders. Off until Sanjay decides to turn licensing on. `MRS_LICENSING=preview`
/// in the environment shows it all on one computer, for trying it out and for screenshots.
pub const SHOWN: bool = false;

/// Whether an entitlement check may block anything. While false every check only logs what it
/// would have blocked. Even when true, a table that is already presenting is never stopped.
pub const ENFORCED: bool = false;

/// The environment variable that previews licensing on one computer.
pub const PREVIEW_ENV: &str = "MRS_LICENSING";

/// Days an organisation may evaluate MR Studio (the BSL allows evaluation; this is the
/// period the licensing page names).
pub const EVALUATION_DAYS: i64 = 90;
/// Days before a licence's end date that the editor starts to mention it.
pub const RENEWAL_NOTICE_DAYS: i64 = 30;
/// Days after a licence's end date before any limit would apply.
pub const GRACE_DAYS: i64 = 30;
/// Who to ask for a licence, in the app's words.
pub const LICENSOR: &str = "Nodal Works AB";
/// Whether a licence file must be signed (Sanjay, 2026-11-28: honour system for now). While
/// false, an unsigned file is read as it is, and a signed one is still checked when this
/// version knows its key. Turning signing on needs a licensor key first: see docs/licensing.md.
pub const SIGNING_REQUIRED: bool = false;
/// The current licence file format.
pub const FORMAT: u32 = 1;
/// A licence file's extension.
pub const EXTENSION: &str = "mrslicence";

/// Names of features a licence can list (`features`). A licence without a list allows them all.
pub mod features {
    pub const RECORDING: &str = "recording";
    pub const PHONES: &str = "phones";
    pub const DASHBOARDS: &str = "dashboards";
    pub const OPERATOR_MODE: &str = "operator_mode";
    pub const CODE_LAYERS: &str = "code_layers";
    pub const MCP: &str = "mcp";
    pub const ALL: [&str; 6] = [RECORDING, PHONES, DASHBOARDS, OPERATOR_MODE, CODE_LAYERS, MCP];
}

/// True when the app should show licensing ([`SHOWN`], or a preview on this computer).
pub fn shown() -> bool {
    SHOWN || std::env::var(PREVIEW_ENV).is_ok_and(|v| matches!(v.trim(), "preview" | "on" | "1"))
}

/// True when entitlement checks may block. See [`ENFORCED`].
pub fn enforced() -> bool {
    ENFORCED
}

#[derive(Debug, thiserror::Error)]
pub enum LicenceError {
    #[error("This is not an MR Studio licence file.")]
    NotALicence,
    #[error("This licence file is from a newer MR Studio. Update the app and add it again.")]
    Newer,
    #[error("This copy of MR Studio has no licensor key yet, so it cannot check licence files.")]
    NoKeys,
    #[error("This licence was signed with a key this version of MR Studio does not know ({0}).")]
    UnknownKey(String),
    #[error("This licence file has been changed since {LICENSOR} made it, so it is not valid.")]
    BadSignature,
    #[error("This licence file is not signed by {LICENSOR}.")]
    Unsigned,
    #[error("The key file is not an MR Studio licence key.")]
    BadKey,
    #[error("{0}")]
    Invalid(String),
}

/// The kind of licence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Education,
    Research,
    Personal,
    Evaluation,
    /// A table in regular use at an organisation.
    Table,
    /// A partner who sets up tables for others.
    Partner,
}

impl Tier {
    pub fn label(self) -> &'static str {
        match self {
            Tier::Education => "Education",
            Tier::Research => "Research",
            Tier::Personal => "Personal",
            Tier::Evaluation => "Evaluation",
            Tier::Table => "Table licence",
            Tier::Partner => "Partner licence",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(text.trim().to_lowercase())).ok()
    }
}

/// What a licence says. Unknown keys from a newer format are kept out of the way: the
/// signature covers the exact bytes, so nothing is lost by ignoring them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Licence {
    /// A short id, such as `NW-2026-0007`. Stamped into diagnostics and exported tables.
    pub id: String,
    /// Who holds it: the organisation that bought it, often a designer who sets up the table
    /// for an exhibitor, or a person for a personal licence.
    pub licensee: String,
    /// The exhibitor the table is for, when the licensee sets it up for someone else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    pub tier: Tier,
    /// `YYYY-MM-DD`.
    pub issued: String,
    /// The last day it is good for, `YYYY-MM-DD`. None: it does not end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    /// How many tables it covers. None: any number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tables: Option<u32>,
    /// How many computers may edit (editor seats). None: any number. A table computer can
    /// always edit the table it presents without taking a seat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editors: Option<u32>,
    /// The computers it is for, by install code, each a table or an editor seat. Empty: any
    /// computer, counted on trust.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub installs: Vec<Seat>,
    /// The layer types it allows (layer package ids such as `sunlight`). None: all of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layers: Option<Vec<String>>,
    /// The features it allows (see [`features`]). None: all of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<String>>,
    /// A line for the licensee, such as what the licence is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub issuer: String,
}

/// What a computer is in a licence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Presents a table (and may edit it).
    Table,
    /// Edits tables: an editor seat.
    Editor,
}

/// One computer named in a licence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Seat {
    pub code: String,
    pub role: Role,
    /// A name for it, such as "Studio PC" or "Anna's laptop".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl Licence {
    /// Whether this licence is for the computer with this install code.
    pub fn covers(&self, install: &str) -> bool {
        self.installs.is_empty() || self.seat(install).is_some()
    }

    /// This computer's place in the licence, when the licence names its computers.
    pub fn seat(&self, install: &str) -> Option<&Seat> {
        self.installs.iter().find(|seat| same_code(&seat.code, install))
    }

    /// The licensee and, when there is one, who it is for.
    pub fn holder(&self) -> String {
        match &self.client {
            Some(client) => format!("{}, for {client}", self.licensee),
            None => self.licensee.clone(),
        }
    }

    fn check(&self) -> Result<(), LicenceError> {
        if self.id.trim().is_empty() || self.licensee.trim().is_empty() {
            return Err(LicenceError::Invalid("A licence needs an id and a licensee.".into()));
        }
        if Day::parse(&self.issued).is_none() {
            return Err(LicenceError::Invalid(format!("The issue date {:?} is not a date (YYYY-MM-DD).", self.issued)));
        }
        if let Some(end) = &self.expires {
            if Day::parse(end).is_none() {
                return Err(LicenceError::Invalid(format!("The end date {end:?} is not a date (YYYY-MM-DD).")));
            }
        }
        Ok(())
    }
}

/// A `.mrslicence` file. Unsigned (the honour system, for now): `licence` is the licence
/// itself. Signed: `licence` is the licence as base64 JSON, `signature` an Ed25519 signature
/// over those exact bytes and `key` the signing key's id; `readable` is then a copy for people
/// who open the file in a text editor, and is never trusted.
#[derive(Debug, Serialize, Deserialize)]
struct LicenceFile {
    mrslicence: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    licence: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    readable: Option<serde_json::Value>,
}

/// A public key the app trusts, from `keys/trusted.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyRecord {
    pub id: String,
    /// The 32-byte Ed25519 public key, base64.
    pub public: String,
    pub owner: String,
    pub added: String,
}

/// The private half, kept by the licensor only. Never in the repository.
#[derive(Debug, Serialize, Deserialize)]
pub struct PrivateKey {
    pub kind: String,
    pub id: String,
    pub owner: String,
    /// The 32-byte Ed25519 secret, base64.
    pub secret: String,
}

const PRIVATE_KIND: &str = "mrs-licence-private-key";

/// The keys built into this version of the app. Add a key with `mrstudio licence keygen`.
pub fn trusted_keys() -> Vec<KeyRecord> {
    #[allow(unused_mut)]
    let mut keys: Vec<KeyRecord> = serde_json::from_str(include_str!("../keys/trusted.json")).expect("keys/trusted.json is a list of keys");
    // A development build may trust a test key, for trying licence files out and for
    // screenshots. Release builds never read it, so it is no way around a licence.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os(TEST_KEY_ENV) {
        match std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<KeyRecord>(&t).ok()) {
            Some(key) => keys.push(key),
            None => tracing::warn!("{TEST_KEY_ENV}: {} is not a public key record", std::path::Path::new(&path).display()),
        }
    }
    keys
}

/// In development builds only: a public key record (`licensor.pub.json`) to trust as well.
pub const TEST_KEY_ENV: &str = "MRS_LICENCE_TEST_KEY";

fn key_id(public: &VerifyingKey) -> String {
    let hash = Sha256::digest(public.as_bytes());
    hash[..6].iter().map(|b| format!("{b:02x}")).collect()
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random numbers");
    bytes
}

/// Makes a new licensor key pair.
pub fn keygen(owner: &str, today: Day) -> (PrivateKey, KeyRecord) {
    let signing = SigningKey::from_bytes(&random::<32>());
    let public = signing.verifying_key();
    let id = key_id(&public);
    let private = PrivateKey { kind: PRIVATE_KIND.into(), id: id.clone(), owner: owner.into(), secret: B64.encode(signing.to_bytes()) };
    let record = KeyRecord { id, public: B64.encode(public.as_bytes()), owner: owner.into(), added: today.to_string() };
    (private, record)
}

impl PrivateKey {
    fn signing(&self) -> Result<SigningKey, LicenceError> {
        if self.kind != PRIVATE_KIND {
            return Err(LicenceError::BadKey);
        }
        let bytes: [u8; 32] = B64.decode(self.secret.trim()).ok().and_then(|b| b.try_into().ok()).ok_or(LicenceError::BadKey)?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    /// The public record for this key, to add to `keys/trusted.json`.
    pub fn record(&self, today: Day) -> Result<KeyRecord, LicenceError> {
        let public = self.signing()?.verifying_key();
        Ok(KeyRecord { id: key_id(&public), public: B64.encode(public.as_bytes()), owner: self.owner.clone(), added: today.to_string() })
    }
}

impl KeyRecord {
    fn verifying(&self) -> Option<VerifyingKey> {
        let bytes: [u8; 32] = B64.decode(self.public.trim()).ok()?.try_into().ok()?;
        VerifyingKey::from_bytes(&bytes).ok()
    }
}

/// Writes the text of a licence's `.mrslicence` file: signed with `key`, or unsigned (the
/// honour system) without one.
pub fn issue(licence: &Licence, key: Option<&PrivateKey>) -> Result<String, LicenceError> {
    licence.check()?;
    let file = match key {
        None => LicenceFile {
            mrslicence: FORMAT,
            key: None,
            licence: serde_json::to_value(licence).map_err(|e| LicenceError::Invalid(e.to_string()))?,
            signature: None,
            readable: None,
        },
        Some(key) => {
            let signing = key.signing()?;
            let payload = serde_json::to_vec(licence).map_err(|e| LicenceError::Invalid(e.to_string()))?;
            let signature = signing.sign(&payload);
            LicenceFile {
                mrslicence: FORMAT,
                key: Some(key_id(&signing.verifying_key())),
                licence: B64.encode(&payload).into(),
                signature: Some(B64.encode(signature.to_bytes())),
                readable: serde_json::to_value(licence).ok(),
            }
        }
    };
    Ok(serde_json::to_string_pretty(&file).expect("a licence file serialises") + "\n")
}

/// Reads a `.mrslicence` file. A signed file is checked against `keys`; an unsigned one is
/// taken on trust unless [`SIGNING_REQUIRED`].
pub fn read(text: &str, keys: &[KeyRecord]) -> Result<Licence, LicenceError> {
    read_checked(text, keys).map(|(licence, _)| licence)
}

/// [`read`], and whether the file's signature was checked.
pub fn read_checked(text: &str, keys: &[KeyRecord]) -> Result<(Licence, bool), LicenceError> {
    let file: LicenceFile = serde_json::from_str(text).map_err(|_| LicenceError::NotALicence)?;
    if file.mrslicence > FORMAT {
        return Err(LicenceError::Newer);
    }
    let (licence, signed) = match (&file.licence, &file.signature) {
        (serde_json::Value::Object(_), None) if !SIGNING_REQUIRED => {
            (serde_json::from_value::<Licence>(file.licence.clone()).map_err(|_| LicenceError::NotALicence)?, false)
        }
        (serde_json::Value::Object(_), None) => return Err(LicenceError::Unsigned),
        (serde_json::Value::String(encoded), Some(signature)) => {
            let payload = B64.decode(encoded.trim()).map_err(|_| LicenceError::NotALicence)?;
            let key = file.key.clone().unwrap_or_default();
            match keys.iter().find(|k| k.id == key) {
                Some(record) => {
                    let public = record.verifying().ok_or(LicenceError::BadKey)?;
                    let signature: [u8; 64] =
                        B64.decode(signature.trim()).ok().and_then(|b| b.try_into().ok()).ok_or(LicenceError::BadSignature)?;
                    public.verify(&payload, &ed25519_dalek::Signature::from_bytes(&signature)).map_err(|_| LicenceError::BadSignature)?;
                }
                None if SIGNING_REQUIRED && keys.is_empty() => return Err(LicenceError::NoKeys),
                None if SIGNING_REQUIRED => return Err(LicenceError::UnknownKey(key)),
                // Honour system: a signature this version cannot check is not held against it.
                None => {
                    let licence: Licence = serde_json::from_slice(&payload).map_err(|_| LicenceError::NotALicence)?;
                    licence.check()?;
                    return Ok((licence, false));
                }
            }
            (serde_json::from_slice::<Licence>(&payload).map_err(|_| LicenceError::NotALicence)?, true)
        }
        _ => return Err(LicenceError::NotALicence),
    };
    licence.check()?;
    Ok((licence, signed))
}

/// Reads a licence file from disk against the built-in keys.
pub fn read_file(path: &Path) -> Result<Licence, LicenceError> {
    let text = std::fs::read_to_string(path).map_err(|e| LicenceError::Invalid(format!("{} could not be read: {e}", path.display())))?;
    read(&text, &trusted_keys())
}

// ---------------------------------------------------------------------------------------------
// Install code

/// This computer's install code: random, made once, nothing about the computer or its user in
/// it. A licence lists the codes it covers, which is how installs are counted offline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Install {
    pub code: String,
    pub created: String,
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn new_code() -> String {
    let bytes = random::<10>();
    let mut bits: u128 = 0;
    for b in bytes {
        bits = (bits << 8) | u128::from(b);
    }
    let chars: Vec<char> = (0..16).rev().map(|i| CROCKFORD[((bits >> (i * 5)) & 31) as usize] as char).collect();
    let groups: Vec<String> = chars.chunks(4).map(|c| c.iter().collect()).collect();
    format!("MRS-{}", groups.join("-"))
}

/// Two install codes are the same however they are typed (case, spaces, dashes).
pub fn same_code(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect::<String>();
    norm(a) == norm(b)
}

impl Install {
    /// Reads the install code at `path`, or makes one and saves it there.
    pub fn load_or_create(path: &Path, today: Day) -> std::io::Result<Self> {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(install) = serde_json::from_str::<Install>(&text) {
                return Ok(install);
            }
        }
        let install = Install { code: new_code(), created: today.to_string() };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(&install)? + "\n")?;
        Ok(install)
    }
}

// ---------------------------------------------------------------------------------------------
// How the computer is used: the first-run answer

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Use {
    Teaching,
    Research,
    Personal,
    /// A museum, municipality, company or other organisation: an evaluation, then a licence.
    Organisation,
}

impl Use {
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(text.trim().to_lowercase())).ok()
    }
}

/// The answer to "How will you use MR Studio?", kept on this computer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    #[serde(rename = "use")]
    pub kind: Use,
    /// The day it was answered, `YYYY-MM-DD`. An evaluation counts from here.
    pub since: String,
}

// ---------------------------------------------------------------------------------------------
// Entitlements

/// What this computer may do. Without a licence (free use, evaluation) everything is allowed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Entitlements {
    pub tables: Option<u32>,
    pub editors: Option<u32>,
    /// This computer's role, when the licence names its computers.
    pub role: Option<Role>,
    pub layers: Option<Vec<String>>,
    pub features: Option<Vec<String>>,
}

/// The outcome of a check.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "check", content = "reason", rename_all = "snake_case")]
pub enum Check {
    Allowed,
    /// Not allowed by the licence, but nothing is enforced yet: it was only logged.
    WouldBlock(String),
    Blocked(String),
}

impl Check {
    /// False only when the check blocks.
    pub fn allowed(&self) -> bool {
        !matches!(self, Check::Blocked(_))
    }

    fn refuse(reason: String) -> Self {
        if enforced() {
            tracing::warn!("licence: {reason}");
            Check::Blocked(reason)
        } else {
            tracing::info!("licence (not enforced): would refuse: {reason}");
            Check::WouldBlock(reason)
        }
    }
}

impl Entitlements {
    pub fn from_licence(licence: &Licence, install: &str) -> Self {
        Entitlements {
            tables: licence.tables,
            editors: licence.editors,
            role: licence.seat(install).map(|s| s.role),
            layers: licence.layers.clone(),
            features: licence.features.clone(),
        }
    }

    /// May this computer open a table in the editor? A table computer may edit the table it
    /// presents; editing other tables takes an editor seat.
    pub fn check_editing(&self, own_table: bool) -> Check {
        match self.role {
            Some(Role::Table) if !own_table => Check::refuse("this computer is a table in the licence, not an editor seat".into()),
            _ => Check::Allowed,
        }
    }

    /// May a table use this layer type (a layer package id)?
    pub fn check_layer(&self, kind: &str) -> Check {
        match &self.layers {
            Some(list) if !list.iter().any(|k| k == kind || k == "*") => {
                Check::refuse(format!("the licence does not include the {kind} layer"))
            }
            _ => Check::Allowed,
        }
    }

    /// May this computer use a feature (see [`features`])?
    pub fn check_feature(&self, feature: &str) -> Check {
        match &self.features {
            Some(list) if !list.iter().any(|f| f == feature || f == "*") => {
                Check::refuse(format!("the licence does not include {feature}"))
            }
            _ => Check::Allowed,
        }
    }

    /// May this computer keep `count` tables?
    pub fn check_tables(&self, count: usize) -> Check {
        match self.tables {
            Some(max) if count > max as usize => Check::refuse(format!("{count} tables, and the licence covers {max}")),
            _ => Check::Allowed,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The files on this computer

/// Where a computer keeps its licence files: `licence/` in the app's settings folder, with
/// `install.json` (the install code), `usage.json` (the first-run answer) and
/// `licence.mrslicence` (the licence, when one was added). Shared by the app and `mrstudio`.
pub struct Store {
    pub dir: std::path::PathBuf,
}

impl Store {
    pub fn new(config_dir: &Path) -> Self {
        Store { dir: config_dir.join("licence") }
    }

    fn licence_path(&self) -> std::path::PathBuf {
        self.dir.join(format!("licence.{EXTENSION}"))
    }

    pub fn install(&self, today: Day) -> std::io::Result<Install> {
        Install::load_or_create(&self.dir.join("install.json"), today)
    }

    pub fn usage(&self) -> Option<Usage> {
        serde_json::from_str(&std::fs::read_to_string(self.dir.join("usage.json")).ok()?).ok()
    }

    /// Saves the first-run answer. Answering again keeps the day an evaluation started.
    pub fn set_usage(&self, kind: Use, today: Day) -> std::io::Result<Usage> {
        let since = match self.usage() {
            Some(old) if old.kind == kind => old.since,
            _ => today.to_string(),
        };
        let usage = Usage { kind, since };
        std::fs::create_dir_all(&self.dir)?;
        std::fs::write(self.dir.join("usage.json"), serde_json::to_string_pretty(&usage)? + "\n")?;
        Ok(usage)
    }

    /// The licence on this computer: None when none was added.
    pub fn licence(&self) -> Option<Result<Licence, LicenceError>> {
        let path = self.licence_path();
        path.exists().then(|| read_file(&path))
    }

    /// Checks a licence file and keeps a copy. A file that does not check out is not kept.
    pub fn add(&self, text: &str) -> Result<Licence, LicenceError> {
        let licence = read(text, &trusted_keys())?;
        std::fs::create_dir_all(&self.dir)
            .and_then(|_| std::fs::write(self.licence_path(), text))
            .map_err(|e| LicenceError::Invalid(format!("The licence could not be saved: {e}")))?;
        Ok(licence)
    }

    pub fn remove(&self) -> std::io::Result<()> {
        match std::fs::remove_file(self.licence_path()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// This computer's status today.
    pub fn status(&self, today: Day) -> Status {
        let install = self.install(today).map(|i| i.code).unwrap_or_else(|e| {
            tracing::warn!("the install code could not be saved: {e}");
            "unknown".into()
        });
        let path = self.licence_path();
        let read = path.exists().then(|| {
            std::fs::read_to_string(&path).map_err(|e| LicenceError::Invalid(e.to_string())).and_then(|t| read_checked(&t, &trusted_keys()))
        });
        let mut status = status(
            today,
            self.usage().as_ref(),
            read.as_ref().map(|r| r.as_ref().map(|(l, _)| l.clone()).map_err(|e| LicenceError::Invalid(e.to_string()))).as_ref(),
            &install,
        );
        status.signed = status.licence.is_some() && matches!(read, Some(Ok((_, true))));
        status
    }
}

// ---------------------------------------------------------------------------------------------
// Counting tables

/// Which table a site is, for counting tables (Sanjay, 2026-11-28): a table is a place, so
/// duplicates and copies of a table are the same table, and only a table at another place (more
/// than about 100 m away) or with another size of ground is another one. The key is the centre
/// rounded to 0.001° and the ground rounded to 50 m.
pub fn table_key(lon: f64, lat: f64, width_m: f64, height_m: f64) -> String {
    let round = |v: f64, step: f64| ((v / step).round() * step * 1000.0).round() / 1000.0;
    format!("{}:{}:{}x{}", round(lon, 0.001), round(lat, 0.001), round(width_m, 50.0), round(height_m, 50.0))
}

/// The table key of a site.json, or None when it has no place yet.
pub fn table_key_of(site: &serde_json::Value) -> Option<String> {
    let lon = site["origin"]["lon"].as_f64()?;
    let lat = site["origin"]["lat"].as_f64()?;
    let w = site["extent"]["width_m"].as_f64().unwrap_or(0.0);
    let h = site["extent"]["height_m"].as_f64().unwrap_or(0.0);
    Some(table_key(lon, lat, w, h))
}

/// How many different tables there are among these site keys.
pub fn count_tables<'a>(keys: impl IntoIterator<Item = &'a str>) -> usize {
    keys.into_iter().collect::<std::collections::BTreeSet<_>>().len()
}

// ---------------------------------------------------------------------------------------------
// Status: what the app shows

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Not asked yet: Home asks how MR Studio will be used.
    Unanswered,
    /// Teaching, research or personal use, free under the licence.
    Free,
    Evaluation,
    EvaluationOver,
    Licensed,
    /// Licensed, ending within [`RENEWAL_NOTICE_DAYS`].
    RenewalDue,
    /// Ended less than [`GRACE_DAYS`] ago.
    Grace,
    Expired,
}

/// Everything the Licence page, Home and the editor need, in their words.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub shown: bool,
    pub enforced: bool,
    pub state: State,
    pub title: String,
    pub detail: String,
    /// A quiet line for the editor and Home. Never shown on the table, TV or phones.
    pub reminder: Option<String>,
    pub days_left: Option<i64>,
    pub licence: Option<Licence>,
    pub tier: Option<Tier>,
    /// What is wrong with the licence file on this computer, if anything.
    pub problem: Option<String>,
    pub install_code: String,
    pub usage: Option<Usage>,
    pub entitlements: Entitlements,
    pub licensor: &'static str,
    pub evaluation_days: i64,
    /// The licence file's signature was checked. False on the honour system.
    pub signed: bool,
}

/// Works out the licence status of this computer.
pub fn status(today: Day, usage: Option<&Usage>, licence: Option<&Result<Licence, LicenceError>>, install: &str) -> Status {
    let mut status = Status {
        shown: shown(),
        enforced: enforced(),
        state: State::Unanswered,
        title: String::new(),
        detail: String::new(),
        reminder: None,
        days_left: None,
        licence: None,
        tier: None,
        problem: None,
        install_code: install.to_string(),
        usage: usage.cloned(),
        entitlements: Entitlements::default(),
        licensor: LICENSOR,
        evaluation_days: EVALUATION_DAYS,
        signed: false,
    };
    match licence {
        Some(Ok(l)) if l.covers(install) => {
            licensed(&mut status, today, l, install);
            return status;
        }
        Some(Ok(l)) => {
            status.problem = Some(format!(
                "The licence {} for {} is for another computer. Send {LICENSOR} this computer's install code to have it added.",
                l.id, l.licensee
            ))
        }
        Some(Err(e)) => status.problem = Some(e.to_string()),
        None => {}
    }
    unlicensed(&mut status, today, usage);
    status
}

fn licensed(status: &mut Status, today: Day, licence: &Licence, install: &str) {
    status.tier = Some(licence.tier);
    status.entitlements = Entitlements::from_licence(licence, install);
    status.licence = Some(licence.clone());
    status.title = format!("Licensed to {}", licence.holder());
    let count = |n: Option<u32>, one: &str, many: &str| match n {
        Some(1) => format!("1 {one}"),
        Some(n) => format!("{n} {many}"),
        None => format!("any number of {many}"),
    };
    status.detail = format!(
        "{}: {} and {}.",
        licence.tier.label(),
        count(licence.tables, "table", "tables"),
        count(licence.editors, "editor seat", "editor seats")
    );
    match licence.seat(install) {
        Some(Seat { role: Role::Table, label, .. }) => {
            status.detail.push_str(&format!(" This computer is a table{}.", label.as_ref().map(|l| format!(" ({l})")).unwrap_or_default()))
        }
        Some(Seat { role: Role::Editor, label, .. }) => status
            .detail
            .push_str(&format!(" This computer is an editor seat{}.", label.as_ref().map(|l| format!(" ({l})")).unwrap_or_default())),
        None => {}
    }
    let Some(end) = licence.expires.as_deref().and_then(Day::parse) else {
        status.state = State::Licensed;
        status.detail.push_str(" It does not end.");
        return;
    };
    let left = today.until(end);
    status.days_left = Some(left);
    if left > RENEWAL_NOTICE_DAYS {
        status.state = State::Licensed;
        status.detail.push_str(&format!(" Good until {end}."));
    } else if left >= 0 {
        status.state = State::RenewalDue;
        status.detail.push_str(&format!(" Good until {end}."));
        status.reminder = Some(format!("Your MR Studio licence runs until {end}. Renew it with {LICENSOR} to keep updates and support."));
    } else if left >= -GRACE_DAYS {
        status.state = State::Grace;
        status.detail.push_str(&format!(" It ended on {end}."));
        status.reminder = Some(format!(
            "Your MR Studio licence ended on {end}. Nothing has stopped working. Renew it with {LICENSOR} within {} days.",
            GRACE_DAYS + left
        ));
    } else {
        status.state = State::Expired;
        status.detail.push_str(&format!(" It ended on {end}."));
        status.reminder = Some(format!("Your MR Studio licence ended on {end}. Please renew it with {LICENSOR}."));
    }
}

fn unlicensed(status: &mut Status, today: Day, usage: Option<&Usage>) {
    let Some(usage) = usage else {
        status.state = State::Unanswered;
        status.title = "Not set up yet".into();
        status.detail = "Tell MR Studio how it will be used on this computer.".into();
        return;
    };
    let free = |what: &str| format!("Free for {what} under the MR Studio licence. No licence file is needed.");
    match usage.kind {
        Use::Teaching => {
            status.state = State::Free;
            status.tier = Some(Tier::Education);
            status.title = "Teaching and learning".into();
            status.detail = free("teaching and learning at a school or university");
        }
        Use::Research => {
            status.state = State::Free;
            status.tier = Some(Tier::Research);
            status.title = "Research".into();
            status.detail = free("research at a university or non-profit research organisation");
        }
        Use::Personal => {
            status.state = State::Free;
            status.tier = Some(Tier::Personal);
            status.title = "Personal use".into();
            status.detail = free("your own learning, hobby or study");
        }
        Use::Organisation => {
            status.tier = Some(Tier::Evaluation);
            let since = Day::parse(&usage.since).unwrap_or(today);
            let end = since.plus(EVALUATION_DAYS);
            let left = today.until(end);
            status.days_left = Some(left);
            if left > 0 {
                status.state = State::Evaluation;
                status.title = format!("Evaluation, {left} {} left", if left == 1 { "day" } else { "days" });
                status.detail =
                    format!("Try everything until {end}. A table in regular use at an organisation needs a table licence from {LICENSOR}.");
                if left <= RENEWAL_NOTICE_DAYS {
                    status.reminder = Some(format!(
                        "Your evaluation of MR Studio ends on {end}. For a table in regular use, ask {LICENSOR} for a table licence."
                    ));
                }
            } else {
                status.state = State::EvaluationOver;
                status.title = "Evaluation ended".into();
                status.detail = format!(
                    "The evaluation ended on {end}. A table in regular use at an organisation needs a table licence from {LICENSOR}."
                );
                status.reminder = Some(format!("Your evaluation of MR Studio ended on {end}. Nothing has stopped working. For a table in regular use, ask {LICENSOR} for a table licence."));
            }
        }
    }
}

/// The few licence facts that go into diagnostics and exported tables (#732): never a name
/// of a person, only the licence id, its kind and the random install code.
pub fn stamp(status: &Status) -> serde_json::Value {
    serde_json::json!({
        "licence": status.licence.as_ref().map(|l| l.id.clone()),
        "tier": status.tier,
        "install": status.install_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> Day {
        Day::parse(text).unwrap()
    }

    fn sample(expires: Option<&str>) -> Licence {
        Licence {
            id: "NW-2026-0001".into(),
            licensee: "Kaminsky Arkitektur".into(),
            client: Some("Universeum".into()),
            tier: Tier::Table,
            issued: "2026-11-28".into(),
            expires: expires.map(Into::into),
            tables: Some(1),
            editors: Some(2),
            installs: vec![],
            layers: None,
            features: None,
            note: None,
            issuer: LICENSOR.into(),
        }
    }

    #[test]
    fn signed_licence_reads_back_and_rejects_changes() {
        let (private, record) = keygen("Test", day("2026-11-28"));
        let text = issue(&sample(Some("2027-11-30")), Some(&private)).unwrap();
        let keys = vec![record];
        assert_eq!(read(&text, &keys).unwrap(), sample(Some("2027-11-30")));

        // Changing the readable copy does nothing; changing the signed payload breaks it.
        let mut file: serde_json::Value = serde_json::from_str(&text).unwrap();
        file["readable"]["tables"] = 99.into();
        assert_eq!(read(&file.to_string(), &keys).unwrap().tables, Some(1));
        let mut forged = sample(Some("2099-12-31"));
        forged.tables = None;
        file["licence"] = B64.encode(serde_json::to_vec(&forged).unwrap()).into();
        assert!(matches!(read(&file.to_string(), &keys), Err(LicenceError::BadSignature)));

        assert!(read_checked(&text, &keys).unwrap().1);
        // A key this version does not know: taken on trust while signing is not required.
        let (_, other) = keygen("Other", day("2026-11-28"));
        assert_eq!(read_checked(&text, &[other]).map(|(_, signed)| signed).ok(), (!SIGNING_REQUIRED).then_some(false));
        assert!(matches!(read("{}", &keys), Err(LicenceError::NotALicence)));
    }

    #[test]
    fn unsigned_licence_is_the_honour_system() {
        let text = issue(&sample(None), None).unwrap();
        assert!(text.contains("\"licensee\": \"Kaminsky Arkitektur\""), "readable as it is: {text}");
        let read_back = read_checked(&text, &[]);
        if SIGNING_REQUIRED {
            assert!(matches!(read_back, Err(LicenceError::Unsigned)));
        } else {
            assert_eq!(read_back.unwrap(), (sample(None), false));
        }
    }

    #[test]
    fn private_key_gives_back_its_public_record() {
        let (private, record) = keygen("Test", day("2026-11-28"));
        assert_eq!(private.record(day("2026-11-28")).unwrap().public, record.public);
        assert_eq!(private.id, record.id);
    }

    #[test]
    fn install_codes_are_random_and_compare_loosely() {
        let a = new_code();
        assert!(a.starts_with("MRS-") && a.len() == 23, "{a}");
        assert_ne!(a, new_code());
        assert!(same_code(&a, &a.to_lowercase().replace('-', " ")));
        let mut l = sample(None);
        assert!(l.covers(&a));
        l.installs = vec![Seat { code: new_code(), role: Role::Editor, label: None }];
        assert!(!l.covers(&a));
        l.installs.push(Seat { code: a.to_lowercase(), role: Role::Table, label: Some("Studio PC".into()) });
        assert_eq!(l.seat(&a).map(|s| s.role), Some(Role::Table));
        let e = Entitlements::from_licence(&l, &a);
        assert_eq!(e.check_editing(true), Check::Allowed);
        assert!(matches!(e.check_editing(false), Check::WouldBlock(_)));
    }

    #[test]
    fn status_follows_the_dates() {
        let today = day("2026-11-28");
        let at = |end: &str| status(today, None, Some(&Ok(sample(Some(end)))), "MRS-X").state;
        assert_eq!(at("2027-11-30"), State::Licensed);
        let s = status(today, None, Some(&Ok(sample(None))), "MRS-X");
        assert_eq!(s.title, "Licensed to Kaminsky Arkitektur, for Universeum");
        assert_eq!(s.detail, "Table licence: 1 table and 2 editor seats. It does not end.");
        assert_eq!(at("2026-12-20"), State::RenewalDue);
        assert_eq!(at("2026-11-28"), State::RenewalDue);
        assert_eq!(at("2026-11-10"), State::Grace);
        assert_eq!(at("2026-09-01"), State::Expired);
        assert_eq!(status(today, None, Some(&Ok(sample(None))), "MRS-X").state, State::Licensed);

        let usage = |kind, since: &str| Usage { kind, since: since.into() };
        assert_eq!(status(today, None, None, "MRS-X").state, State::Unanswered);
        assert_eq!(status(today, Some(&usage(Use::Research, "2026-01-01")), None, "MRS-X").state, State::Free);
        let eval = status(today, Some(&usage(Use::Organisation, "2026-11-28")), None, "MRS-X");
        assert_eq!((eval.state, eval.days_left, eval.reminder.is_some()), (State::Evaluation, Some(90), false));
        let late = status(today, Some(&usage(Use::Organisation, "2026-09-15")), None, "MRS-X");
        assert_eq!((late.state, late.reminder.is_some()), (State::Evaluation, true));
        assert_eq!(status(today, Some(&usage(Use::Organisation, "2026-01-01")), None, "MRS-X").state, State::EvaluationOver);

        // A licence for another computer falls back to the answer, and says why.
        let mut other = sample(None);
        other.installs = vec![Seat { code: "MRS-Y".into(), role: Role::Table, label: None }];
        let s = status(today, Some(&usage(Use::Organisation, "2026-11-28")), Some(&Ok(other)), "MRS-X");
        assert_eq!(s.state, State::Evaluation);
        assert!(s.problem.unwrap().contains("another computer"));
    }

    #[test]
    fn checks_only_log_while_not_enforced() {
        let mut l = sample(None);
        l.layers = Some(vec!["sunlight".into()]);
        l.features = Some(vec![features::PHONES.into()]);
        let e = Entitlements::from_licence(&l, "MRS-X");
        assert_eq!(e.check_layer("sunlight"), Check::Allowed);
        assert!(matches!(e.check_layer("wind"), Check::WouldBlock(_)));
        assert!(e.check_layer("wind").allowed());
        assert_eq!(e.check_feature(features::PHONES), Check::Allowed);
        assert!(matches!(e.check_feature(features::RECORDING), Check::WouldBlock(_)));
        assert_eq!(e.check_tables(1), Check::Allowed);
        assert!(matches!(e.check_tables(2), Check::WouldBlock(_)));
        assert_eq!(Entitlements::default().check_tables(50), Check::Allowed);
    }

    #[test]
    fn store_keeps_the_answer_and_the_install_code() {
        let dir = std::env::temp_dir().join(format!("mrs-licence-{}", new_code()));
        let store = Store::new(&dir);
        let today = day("2026-11-28");
        assert_eq!(store.status(today).state, State::Unanswered);
        let code = store.install(today).unwrap().code;
        assert_eq!(store.install(today).unwrap().code, code);
        store.set_usage(Use::Organisation, today).unwrap();
        store.set_usage(Use::Organisation, day("2026-12-10")).unwrap();
        assert_eq!(store.usage().unwrap().since, "2026-11-28");
        assert_eq!(store.status(day("2026-12-28")).days_left, Some(60));
        assert!(store.licence().is_none());
        assert!(matches!(store.add("not a licence"), Err(LicenceError::NotALicence)));
        assert!(store.licence().is_none());
        store.remove().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn duplicates_are_one_table() {
        let a = table_key(11.9700, 57.7000, 1000.0, 600.0);
        assert_eq!(a, table_key(11.97012, 57.70004, 1010.0, 590.0));
        assert_ne!(a, table_key(11.9750, 57.7000, 1000.0, 600.0));
        assert_ne!(a, table_key(11.9700, 57.7000, 2000.0, 600.0));
        let site = serde_json::json!({ "origin": { "lon": 11.97, "lat": 57.7 }, "extent": { "width_m": 1000, "height_m": 600 } });
        assert_eq!(table_key_of(&site).as_deref(), Some(a.as_str()));
        let b = table_key(12.0, 57.7, 1000.0, 600.0);
        assert_eq!(count_tables([a.as_str(), a.as_str(), b.as_str()]), 2);
    }

    #[test]
    fn licensing_is_switched_off() {
        // Turning these on is Sanjay's decision (#725); this test is the reminder to update
        // docs/licensing.md and the release notes when it happens.
        const { assert!(!SHOWN && !ENFORCED && !SIGNING_REQUIRED) };
    }

    #[test]
    fn built_in_keys_parse() {
        for key in trusted_keys() {
            assert!(key.verifying().is_some(), "keys/trusted.json has a bad key {}", key.id);
        }
    }
}
