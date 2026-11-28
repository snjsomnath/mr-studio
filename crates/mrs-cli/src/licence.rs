//! `mrstudio licence` (#726): make the licensor key, issue licence files, check them, and show
//! this computer's install code and status. See docs/licensing.md.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use clap::Subcommand;
use mrs_licence::{Day, KeyRecord, Licence, PrivateKey, Role, Seat, Store, Tier, LICENSOR};

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)] // parsed once from the command line
pub enum LicenceCommand {
    /// Make the licensor's key pair, once, for when licences are signed (not yet: they are on the
    /// honour system for now). The private key never goes in the repository: keep
    /// it somewhere safe and backed up. The public key goes into crates/mrs-licence/keys/trusted.json.
    Keygen {
        /// Folder to write `licensor.key` and `licensor.pub.json` into.
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value = LICENSOR)]
        owner: String,
    },
    /// Write a licence file for a customer. Unsigned (the honour system) unless a key is given.
    Issue {
        /// The private key from `mrstudio licence keygen`, to sign it. Leave out for an
        /// unsigned licence, which is all the app asks for while signing is not required.
        #[arg(long)]
        key: Option<PathBuf>,
        /// Who holds the licence: usually the designer who bought it.
        #[arg(long)]
        to: String,
        /// The exhibitor the table is for, when the holder sets it up for someone else.
        #[arg(long)]
        client: Option<String>,
        /// education, research, personal, evaluation, table or partner.
        #[arg(long, default_value = "table")]
        tier: String,
        /// How many tables (different places) it covers. Leave out for any number.
        #[arg(long)]
        tables: Option<u32>,
        /// How many editor seats it covers. Leave out for any number.
        #[arg(long)]
        editors: Option<u32>,
        /// The last day it is good for, YYYY-MM-DD. Leave out for no end.
        #[arg(long)]
        expires: Option<String>,
        /// Install code of a table computer, optionally with a name: MRS-…=Studio PC. Repeat for more.
        #[arg(long = "table")]
        table_codes: Vec<String>,
        /// Install code of an editor seat, optionally with a name. Repeat for more.
        #[arg(long = "editor")]
        editor_codes: Vec<String>,
        /// Only these layer types, comma separated (layer package ids).
        #[arg(long, value_delimiter = ',')]
        layers: Option<Vec<String>>,
        /// Only these features, comma separated (recording, phones, dashboards, operator_mode, code_layers, mcp).
        #[arg(long, value_delimiter = ',')]
        features: Option<Vec<String>>,
        /// A line for the customer, such as what it is for.
        #[arg(long)]
        note: Option<String>,
        /// The licence id. Made from the date when left out.
        #[arg(long)]
        id: Option<String>,
        /// The file to write, for example Universeum.mrslicence.
        #[arg(long)]
        out: PathBuf,
    },
    /// Check a licence file and print what it says.
    Verify {
        file: PathBuf,
        /// A public key record to check against instead of the keys built into this version.
        #[arg(long)]
        public: Option<PathBuf>,
    },
    /// This computer's install code and licence status, as the app sees them.
    Status,
}

pub fn run(action: LicenceCommand, config_dir: &Path) -> anyhow::Result<()> {
    let today = Day::today();
    match action {
        LicenceCommand::Keygen { out, owner } => {
            let private_path = out.join("licensor.key");
            let public_path = out.join("licensor.pub.json");
            if private_path.exists() {
                bail!("{} already exists. A new key would make every licence signed with the old one unreadable in new versions; move it away first if you really mean to.", private_path.display());
            }
            std::fs::create_dir_all(&out)?;
            let (private, record) = mrs_licence::keygen(&owner, today);
            write_private(&private_path, &serde_json::to_string_pretty(&private)?)?;
            std::fs::write(&public_path, serde_json::to_string_pretty(&record)? + "\n")?;
            println!("Made key {}.", record.id);
            println!("  private: {} (keep it safe, back it up, never commit it)", private_path.display());
            println!("  public:  {}", public_path.display());
            println!("Add the public record to crates/mrs-licence/keys/trusted.json so the next release can read licences signed with it.");
            Ok(())
        }
        LicenceCommand::Issue {
            key,
            to,
            client,
            tier,
            tables,
            editors,
            expires,
            table_codes,
            editor_codes,
            layers,
            features,
            note,
            id,
            out,
        } => {
            let private: Option<PrivateKey> = match &key {
                Some(key) => Some(
                    serde_json::from_str(&std::fs::read_to_string(key).with_context(|| format!("reading {}", key.display()))?)
                        .context("the key file is not an MR Studio licence key")?,
                ),
                None => None,
            };
            let tier = Tier::parse(&tier)
                .with_context(|| format!("{tier:?} is not a tier: education, research, personal, evaluation, table or partner"))?;
            let mut installs: Vec<Seat> = table_codes.iter().map(|c| seat(c, Role::Table)).collect();
            installs.extend(editor_codes.iter().map(|c| seat(c, Role::Editor)));
            let licence = Licence {
                id: id.unwrap_or_else(|| format!("NW-{}", today.to_string().replace('-', ""))),
                licensee: to,
                client,
                tier,
                issued: today.to_string(),
                expires,
                tables,
                editors,
                installs,
                layers,
                features,
                note,
                issuer: private.as_ref().map_or_else(|| LICENSOR.to_string(), |k| k.owner.clone()),
            };
            let text = mrs_licence::issue(&licence, private.as_ref())?;
            std::fs::write(&out, text).with_context(|| format!("writing {}", out.display()))?;
            println!(
                "Wrote {} ({}, {}, {}).",
                out.display(),
                licence.id,
                licence.holder(),
                if private.is_some() { "signed" } else { "unsigned" }
            );
            Ok(())
        }
        LicenceCommand::Verify { file, public } => {
            let text = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
            let keys: Vec<KeyRecord> = match public {
                Some(path) => vec![serde_json::from_str(&std::fs::read_to_string(&path)?).context("not a public key record")?],
                None => mrs_licence::trusted_keys(),
            };
            let (licence, signed) = mrs_licence::read_checked(&text, &keys)?;
            println!(
                "Valid licence {} for {} ({}).",
                licence.id,
                licence.holder(),
                if signed { "signature checked" } else { "not signed: the honour system" }
            );
            println!("{}", serde_json::to_string_pretty(&licence)?);
            Ok(())
        }
        LicenceCommand::Status => {
            let status = Store::new(config_dir).status(today);
            println!("Install code: {}", status.install_code);
            println!("{}: {}", status.title, status.detail);
            if let Some(problem) = &status.problem {
                println!("Problem: {problem}");
            }
            if !status.shown {
                println!("(Licensing is switched off in this version: the app shows none of this.)");
            }
            Ok(())
        }
    }
}

/// `MRS-…` or `MRS-…=Studio PC`.
fn seat(arg: &str, role: Role) -> Seat {
    let (code, label) = match arg.split_once('=') {
        Some((code, label)) => (code.trim(), Some(label.trim().to_string()).filter(|l| !l.is_empty())),
        None => (arg.trim(), None),
    };
    Seat { code: code.to_uppercase(), role, label }
}

fn write_private(path: &Path, text: &str) -> anyhow::Result<()> {
    std::fs::write(path, format!("{text}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
