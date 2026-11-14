# Releasing MR Studio

A release is a version tag. The "Desktop app" workflow builds the installers for it and attaches them to a draft GitHub release.
Publishing that draft is what makes installed apps offer the update.

## What people with the app installed see

The app looks at the published releases of this repository a few seconds after it starts (this can be turned off on the Updates tab).
If a newer version exists, the launcher's Updates tab gets a dot and shows:

- which version is available and how many releases it is ahead;
- the release notes of every release in between, newest first, with their pictures;
- breaking changes first, in a red box, when any of those releases has them;
- one button: "Update to x and restart", or "Open the download page" for a copy that cannot install updates itself.

Nothing is installed until the person presses the button. A table that starts by itself is never interrupted; the dot is there the next time someone opens the launcher.

## Writing the notes

The draft starts from `.github/release-notes-template.md`. Write for the people who run a table.

- Pictures: drag them into the editor on GitHub. The app shows pictures hosted on github.com and githubusercontent.com.
- **Breaking changes**: add a heading that starts with "Breaking", for example `## Breaking changes`, and under it say what changes and what people must do. The app shows that section before anything else. A release that raises the major version is also marked as breaking.
- Pre-releases and drafts are never offered.

## Steps

1. Set the version: `version` under `[workspace.package]` in `Cargo.toml`. It is the only place. Merge that to `main`.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`. The workflow fails if the tag and the version differ.
3. Wait for the workflow. It creates a draft release with the Windows installer, the macOS dmg, the signed update files and `latest.json`.
4. Open the draft, write the notes, publish. From that moment installed apps offer the update.

## The updater key (once)

The app only installs files signed with a key that belongs to this project. Until the key exists, releases still work and the app still announces them, but the button opens the download page.

1. Make the key pair on your own computer: `pnpm --filter @mrstudio/studio exec tauri signer generate -w ~/.tauri/mr-studio.key`. Choose a password.
2. In the repository's settings, under Secrets and variables, Actions, add:
   - secret `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/mr-studio.key`;
   - secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password;
   - variable `MRS_UPDATER_PUBKEY`: the contents of `~/.tauri/mr-studio.key.pub`.
3. Keep the private key and its password somewhere safe. If they are lost, copies already installed can no longer be updated from inside the app and need one manual install of a build made with a new key.

The public key is compiled into the app, so only builds made after step 2 can install updates themselves. A copy installed before that needs one manual install.

This key is not operating system code signing. Without an Apple Developer ID and a Windows certificate the installers still show the "unknown developer" prompts on first install.

## Older site files

An update never strands a site. `site.json` carries a `format` number; when a release changes the format, it adds one step to `crates/mrs-site/src/migrate.rs`.
Opening a site saved by an older version runs the steps it needs, rewrites `site.json` and keeps the original beside it as `site.format-<n>.json`.
`mrstudio migrate <site>` does the same from the command line. A site saved by a newer version than the app is refused with a message that says to update the app.
A release that changes the format says so under "Breaking changes".
