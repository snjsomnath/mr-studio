//! Finding out that a newer MR Studio exists, and what it brings.
//!
//! The releases of the GitHub repository are the source: each published release is a
//! version, and its description is what the Updates tab shows before anyone chooses to
//! update. A release is marked breaking when it raises the major version or when its
//! description has a "Breaking changes" heading. Installing is done by the Tauri updater
//! from the signed files of the latest release (see `install` in main.rs and docs/RELEASING.md).

use semver::Version;
use serde::{Deserialize, Serialize};

/// The published releases, newest first.
pub const RELEASES_URL: &str = "https://api.github.com/repos/snjsomnath/mr-studio/releases?per_page=30";
/// What the updater reads: the versions, download links and signatures of the latest release.
pub const FEED_URL: &str = "https://github.com/snjsomnath/mr-studio/releases/latest/download/latest.json";
/// Where a person downloads an installer by hand.
pub const DOWNLOAD_PAGE: &str = "https://github.com/snjsomnath/mr-studio/releases/latest";

/// The public half of the key that release files are signed with. It is given to the
/// build by the release workflow; a build without it can tell that an update exists and
/// show what is new, but sends the person to the download page instead of installing.
pub fn public_key() -> Option<&'static str> {
    option_env!("MRS_UPDATER_PUBKEY").map(str::trim).filter(|key| !key.is_empty())
}

/// A release as the GitHub API lists it. Only what is used.
#[derive(Debug, Clone, Deserialize)]
pub struct Published {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    pub html_url: String,
}

/// A release newer than the running app.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Release {
    pub version: String,
    pub title: String,
    /// The release description, in Markdown, as written.
    pub notes: String,
    pub published_at: Option<String>,
    pub url: String,
    pub breaking: bool,
    /// The text under the "Breaking changes" heading, when there is one.
    pub breaking_notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Available {
    /// The newest version, or none when the app is up to date.
    pub latest: Option<String>,
    /// Every release newer than this app, newest first, so someone several versions
    /// behind sees everything they would get.
    pub releases: Vec<Release>,
    /// Any of them is breaking.
    pub breaking: bool,
}

/// `v1.2.3` and `1.2.3` are both versions; anything else is not a release of the app.
fn version_of(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

/// The text under a heading that starts with "Breaking", up to the next heading of the
/// same or a higher level. `None` when there is no such heading.
pub fn breaking_section(notes: &str) -> Option<String> {
    let heading = |line: &str| {
        let trimmed = line.trim_start();
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        (1..=6).contains(&level).then(|| (level, trimmed[level..].trim().trim_matches(['*', '_', ':', ' ']).to_lowercase()))
    };
    let notes = without_comments(notes);
    let mut lines = notes.lines();
    let level = lines.find_map(|line| heading(line).filter(|(_, title)| title.starts_with("breaking")).map(|(level, _)| level))?;
    let body: Vec<&str> = lines.take_while(|line| heading(line).is_none_or(|(next, _)| next > level)).collect();
    Some(body.join("\n").trim().to_string())
}

/// The release template carries a comment for whoever writes the notes; it is not part of them.
fn without_comments(notes: &str) -> String {
    let mut out = String::new();
    let mut rest = notes;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        rest = rest[start..].find("-->").map_or("", |end| &rest[start + end + 3..]);
    }
    out + rest
}

/// What is newer than `current` among the published releases. Drafts, pre-releases and
/// tags that are not versions are left out.
pub fn available(current: &Version, published: Vec<Published>) -> Available {
    let mut newer: Vec<(Version, Published)> = published
        .into_iter()
        .filter(|p| !p.draft && !p.prerelease)
        .filter_map(|p| version_of(&p.tag_name).filter(|v| v > current && v.pre.is_empty()).map(|v| (v, p)))
        .collect();
    newer.sort_by(|a, b| b.0.cmp(&a.0));
    let releases: Vec<Release> = newer
        .into_iter()
        .map(|(version, p)| {
            let notes = p.body.unwrap_or_default();
            let breaking_notes = breaking_section(&notes);
            Release {
                breaking: version.major > current.major || breaking_notes.is_some(),
                title: p.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("MR Studio {version}")),
                version: version.to_string(),
                notes,
                published_at: p.published_at,
                url: p.html_url,
                breaking_notes,
            }
        })
        .collect();
    Available { latest: releases.first().map(|r| r.version.clone()), breaking: releases.iter().any(|r| r.breaking), releases }
}

/// Asks GitHub for the published releases and keeps the ones newer than `current`.
/// The request carries nothing about this computer or its user.
pub async fn check(current: &Version) -> anyhow::Result<Available> {
    let url = std::env::var("MRS_RELEASES_URL").unwrap_or_else(|_| RELEASES_URL.into());
    let client = reqwest::Client::builder().user_agent("mr-studio-update-check").timeout(std::time::Duration::from_secs(15)).build()?;
    let response = client.get(&url).header("Accept", "application/vnd.github+json").send().await?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("the release list answered {status}");
    }
    Ok(available(current, response.json().await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn published(tag: &str, body: &str) -> Published {
        Published {
            tag_name: tag.into(),
            name: None,
            body: Some(body.into()),
            draft: false,
            prerelease: false,
            published_at: None,
            html_url: format!("https://example.test/{tag}"),
        }
    }

    #[test]
    fn only_newer_published_versions_count_newest_first() {
        let current = Version::new(0, 2, 0);
        let mut draft = published("v0.9.0", "");
        draft.draft = true;
        let mut beta = published("v0.8.0", "");
        beta.prerelease = true;
        let list = vec![
            published("v0.2.0", "this one"),
            published("v0.3.0", "## New\n- wind"),
            draft,
            beta,
            published("0.4.1", "fixes"),
            published("v0.5.0-rc.1", "candidate"),
            published("nightly", "not a version"),
            published("v0.1.0", "old"),
        ];
        let found = available(&current, list);
        assert_eq!(found.latest.as_deref(), Some("0.4.1"));
        assert_eq!(found.releases.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(), ["0.4.1", "0.3.0"]);
        assert!(!found.breaking);
        assert_eq!(found.releases[1].title, "MR Studio 0.3.0");

        let none = available(&Version::new(1, 0, 0), vec![published("v1.0.0", ""), published("v0.9.0", "")]);
        assert_eq!((none.latest, none.releases.len(), none.breaking), (None, 0, false));
    }

    #[test]
    fn a_major_version_or_a_breaking_heading_marks_a_release_breaking() {
        let current = Version::new(1, 4, 0);
        let notes = "## New\n- composer\n\n## Breaking changes\n- Site format 2. Older sites are upgraded when opened.\n\n### Details\nmore\n\n## Fixes\n- x";
        let found = available(&current, vec![published("v1.5.0", notes), published("v2.0.0", "A new start."), published("v1.4.1", "fix")]);
        let by_version = |v: &str| found.releases.iter().find(|r| r.version == v).unwrap();
        assert!(found.breaking);
        assert!(by_version("2.0.0").breaking && by_version("2.0.0").breaking_notes.is_none(), "a major version is breaking by itself");
        assert!(by_version("1.5.0").breaking);
        assert_eq!(
            by_version("1.5.0").breaking_notes.as_deref(),
            Some("- Site format 2. Older sites are upgraded when opened.\n\n### Details\nmore"),
            "the section runs to the next heading of the same level"
        );
        assert!(!by_version("1.4.1").breaking);
    }

    #[test]
    fn breaking_headings_are_found_however_they_are_written() {
        assert_eq!(breaking_section("# Breaking\nA").as_deref(), Some("A"));
        assert_eq!(breaking_section("### **Breaking changes:**\nB\n### Next\nC").as_deref(), Some("B"));
        assert_eq!(breaking_section("## New\nNothing is breaking here."), None);
        assert_eq!(breaking_section(""), None);
        assert_eq!(breaking_section("<!--\n## Breaking changes\nhow to write them\n-->\n## New\n- x"), None, "a comment is not a heading");
        assert_eq!(without_comments("a<!-- b -->c<!-- d"), "ac");
    }
}
