# Releasing

A release is a GitHub release of `AlinScreciu/inklode` with four files. macOS on Apple Silicon is the only platform.

| File | For | Made by |
|---|---|---|
| `Inklode-<version>-aarch64.dmg` | People: the download. Signed, notarized and stapled. | `scripts/release.sh`, in CI |
| `Inklode.app.tar.gz` | The app's updater: the stapled app, archived. | `scripts/release.sh`, in CI |
| `Inklode.app.tar.gz.sig` | The updater's signature of that archive. The same text is inside `latest.json`. | `scripts/sign-update.sh`, on the maintainer's Mac |
| `latest.json` | The app's update check. It names the version, the archive's URL and its signature. | `scripts/sign-update.sh`, on the maintainer's Mac |

## Who can ship an update

Two things are needed, and they are kept apart on purpose:

- **The GitHub repository** builds the app from a pushed tag, with the Developer ID certificate, and holds the release.
- **The updater's private key** signs the archive. It is on the maintainer's Mac and is not a GitHub secret, so a taken-over GitHub account, a changed workflow or a dependency that runs during the build cannot make an update that installed apps accept.

On GitHub, the repository refuses actions that are not pinned to a commit hash, refuses to move or delete a `v*` tag or to force-push `main` (rulesets), and makes a published release immutable: its files and its tag cannot be changed afterwards.

## How the app updates

- The app reads `https://github.com/AlinScreciu/inklode/releases/latest/download/latest.json` (`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`). GitHub serves that from the newest release that is neither a draft nor a pre-release. After a release is published, this address can keep answering with the one before for a few minutes.
- It does so once when it starts, if "Check for updates when Inklode starts" is on (`updates.auto` in the app's settings, on by default), and on "Check for Updates…". A build under `pnpm tauri dev` does not check by itself.
- If `version` there is newer than the running app's, the app shows "Inklode X is available". Only "Install and restart" downloads the archive.
- The updater installs the archive only if its signature matches the public key in `plugins.updater.pubkey`, and (`requireSignedVersion`) only if the version inside the signature is the one `latest.json` names.
- It then puts the new `Inklode.app` in the place of the running one and the app restarts. If the app's folder is not writable by the user, macOS asks for an administrator password.

## One-time setup

1. **The updater key.** It exists: the private key is `~/.tauri/inklode-updater.key` (mode 0600, no password), the public key is next to it as `inklode-updater.key.pub` and in `tauri.conf.json`.

   **Back the private key up**, somewhere that is not this Mac (a password manager). Every installed copy of Inklode accepts updates signed with this key and no other. If it is lost, no installed copy can ever be updated again: its users have to download a new build by hand, with a new key in it. If it leaks, whoever has it and can also change the release files can ship code to every installed copy. It never goes into the repository, a GitHub secret, a log or CI output.

   A new pair is made with `pnpm tauri signer generate --ci -w ~/.tauri/inklode-updater.key`; the public key printed then goes into `plugins.updater.pubkey`. Do that only before the first release, or after a loss.

2. **The secrets of the workflow.** The release job runs in the environment `release` (limited to `v*` tags), which holds them, so no other workflow can read them:

   | Secret | What |
   |---|---|
   | `APPLE_CERTIFICATE_P12` | The "Developer ID Application" certificate with its private key, exported from Keychain Access as a `.p12`, base64-encoded (`base64 -i file.p12`). Not the "Apple Development" one. |
   | `APPLE_CERTIFICATE_PASSWORD` | The password given at that export. |
   | `APPLE_ID`, `APPLE_TEAM_ID` | The Apple account and the team the certificate belongs to. |
   | `APPLE_APP_PASSWORD` | An app-specific password for that account (account.apple.com), made for CI alone so it can be revoked alone. |

   Set each from a file or a prompt, so the value is in no shell history: `gh secret set NAME --env release < file`, or `gh secret set NAME --env release` and paste.

## Steps

1. **Bump the version** in the three manifests, to the same `x.y.z`: `src-tauri/tauri.conf.json` (the app's own version, which the updater compares), `src-tauri/Cargo.toml` and `package.json`. Run `cargo check -p inklode` so `Cargo.lock` follows.
2. **Changelog.** Add the section for the version to `CHANGELOG.md`. It becomes the release's notes.
3. **Test**: `cargo test --workspace`, `pnpm build`, every `pnpm test:*`.
4. **Commit, push, tag:**

   ```sh
   git tag v<version> && git push origin main v<version>
   ```

   The tag cannot be moved afterwards. `.github/workflows/release.yml` refuses a tag that is not `v` plus the version in the manifests. It runs the tests of `ci.yml` on the tagged commit and, only if they pass, runs `scripts/release.sh`: the app built and signed with the hardened runtime, notarized, stapled and checked (`spctl`, `codesign`), the updater archive made from the stapled app, and the disk image made, notarized and stapled. The two files go to a **draft** release.

5. **Sign the update**, when the workflow is done:

   ```sh
   scripts/sign-update.sh
   ```

   It downloads the archive from the draft and checks it before signing: the tag names the same commit here and on GitHub, and the app in the archive is signed by the Developer ID team, notarized, stapled and of this version. Then it signs the archive with the updater key, writes `latest.json` and adds both files to the draft. It cannot check that the app was built from the tagged source and nothing else; sign only a draft of a tag you pushed yourself.

6. **Check.** Download the disk image from the draft, drag the app to Applications, start it. `spctl -a -vv /Applications/Inklode.app` says `accepted` and `source=Notarized Developer ID`.
7. **Publish:** `gh release edit v<version> --draft=false --latest` (or "Publish release" on the page). From then on installed apps offer the update, and the release cannot be changed. The file names must stay as they are: `latest.json` points at `releases/download/v<version>/Inklode.app.tar.gz`, and the app looks for `latest.json` by that name.
8. **Check the update** from the version before: start it, and it offers the new one.

## Without CI

`scripts/release.sh` also runs on the maintainer's Mac, in place of the workflow in step 4. It needs a clean working tree, the "Developer ID Application" certificate with its key in the login keychain, and the notary credentials stored under the name the script uses (`xcrun notarytool store-credentials inklode-notary --apple-id <apple id> --team-id <TEAMID>`, which asks for an app-specific password):

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/release.sh
```

The files are in `release/<version>/`, which git ignores. The script prints the `gh release create ... --draft` command for them; steps 5 to 8 follow as above.

`SKIP_APPLE=1 scripts/release.sh` runs the script without the Developer ID signature, notarization and stapling, and with a working tree that has changes. It is for testing the script. What it makes must not be published.

## Why the archive is made after stapling

The updater puts exactly the archive's bytes in the place of the installed app. An archive made before notarization holds an app without the notarization ticket. So the script archives the app only after `stapler staple`, and the updater's signature, which is over the archive's bytes, is made last, by `scripts/sign-update.sh`: any change to the app or the archive after it would make the signature wrong.

## Limits

- The updater replaces the app where it runs. It needs that folder on the same volume as a temporary folder it can use, and to be writable (or an administrator password).
- An app started from the disk image, or from Downloads while macOS still runs it from a read-only copy (App Translocation, which ends once the app has been moved with Finder), cannot replace itself: the install fails with an error in the notice. Move it to Applications first.
- A release cannot be taken back from apps that already installed it, and a published release cannot be changed. To stop one from spreading, publish a newer one.
- The app never downgrades: a `latest.json` with an older or the same version means "up to date".
