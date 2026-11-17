# Releasing

A release is a GitHub release of `AlinScreciu/inklode` with four files, made on the maintainer's Mac by `scripts/release.sh`. macOS on Apple Silicon is the only platform.

| File | For |
|---|---|
| `Inklode-<version>-aarch64.dmg` | People: the download. Signed, notarized and stapled. |
| `Inklode.app.tar.gz` | The app's updater: the stapled app, archived. |
| `Inklode.app.tar.gz.sig` | The updater's signature of that archive. The same text is inside `latest.json`. |
| `latest.json` | The app's update check. It names the version, the archive's URL and its signature. |

## How the app updates

- The app reads `https://github.com/AlinScreciu/inklode/releases/latest/download/latest.json` (`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`). GitHub serves that from the newest release that is neither a draft nor a pre-release.
- It does so once when it starts, if "Check for updates when Inklode starts" is on (`updates.auto` in the app's settings, on by default), and on "Check for Updates…". A build under `pnpm tauri dev` does not check by itself.
- If `version` there is newer than the running app's, the app shows "Inklode X is available". Only "Install and restart" downloads the archive.
- The updater installs the archive only if its signature matches the public key in `plugins.updater.pubkey`, and (`requireSignedVersion`) only if the version inside the signature is the one `latest.json` names.
- It then puts the new `Inklode.app` in the place of the running one and the app restarts. If the app's folder is not writable by the user, macOS asks for an administrator password.

## One-time setup

1. **The updater key.** It exists: the private key is `~/.tauri/inklode-updater.key` (mode 0600, no password), the public key is next to it as `inklode-updater.key.pub` and in `tauri.conf.json`.

   **Back the private key up**, somewhere that is not this Mac (a password manager). Every installed copy of Inklode accepts updates signed with this key and no other. If it is lost, no installed copy can ever be updated again: its users have to download a new build by hand, with a new key in it. If it leaks, whoever has it and can also change the release files can ship code to every installed copy. It never goes into the repository, a log or CI output.

   A new pair is made with `pnpm tauri signer generate --ci -w ~/.tauri/inklode-updater.key`; the public key printed then goes into `plugins.updater.pubkey`. Do that only before the first release, or after a loss.

2. **The Developer ID certificate.** A "Developer ID Application: Name (TEAMID)" certificate with its private key in the login keychain. `security find-identity -v -p codesigning` lists it.

3. **The notary profile.** Credentials for Apple's notary service, stored in the keychain under the name the script uses:

   ```sh
   xcrun notarytool store-credentials inklode-notary --apple-id <apple id> --team-id <TEAMID>
   ```

   It asks for an app-specific password (made at account.apple.com).

## Steps

1. **Bump the version** in the three manifests, to the same `x.y.z`: `src-tauri/tauri.conf.json` (the app's own version, which the updater compares), `src-tauri/Cargo.toml` and `package.json`. Run `cargo check -p inklode` so `Cargo.lock` follows. The script refuses to run if the three differ.
2. **Changelog.** Add the section for the version to `CHANGELOG.md`.
3. **Test**: `cargo test --workspace`, `pnpm build`, every `pnpm test:*`.
4. **Commit and push.** The script refuses a working tree with changes, and the release's tag is put on the commit that was built.
5. **Run the script:**

   ```sh
   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/release.sh
   ```

   It builds the app signed with the hardened runtime, has Apple notarize it, staples it, checks it (`spctl`, `codesign`), makes the updater archive from the stapled app and signs it with the updater key, writes `latest.json`, and makes, notarizes and staples the disk image. The files are in `release/<version>/`, which git ignores. Nothing is published.

   The updater key is read from `~/.tauri/inklode-updater.key`. To use another, set `TAURI_SIGNING_PRIVATE_KEY` to its path or to the key's content.

6. **Check.** Open the disk image, drag the app to Applications, start it. `spctl -a -vv /Applications/Inklode.app` says `accepted` and `source=Notarized Developer ID`. Look at `release/<version>/latest.json`: the version and the URL are the ones of this release.
7. **Publish**, with the two commands the script prints: `gh release create v<version> ... --draft` with the four files, then `gh release edit v<version> --draft=false --latest`. From the second command on, installed apps offer the update. The file names must stay as they are: `latest.json` points at `releases/download/v<version>/Inklode.app.tar.gz`, and the app looks for `latest.json` by that name.
8. **Check the update** from the version before: start it, and it offers the new one.

## Building without the keys

`bundle.createUpdaterArtifacts` is on, so every `pnpm tauri build` wants the updater's private key in `TAURI_SIGNING_PRIVATE_KEY` (a path or the key's content; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is empty for this key) and fails at the end without it. A build that is not a release does not need the archive:

```sh
pnpm tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

`SKIP_APPLE=1 scripts/release.sh` runs the script without the Developer ID signature, notarization and stapling, and with a working tree that has changes. It is for testing the script. What it makes must not be published.

## Why the archive is made after stapling

`pnpm tauri build` also makes an `Inklode.app.tar.gz` and signs it, in `target/release/bundle/macos/`. The script does not use it. That archive is made before notarization, so the app in it has no notarization ticket, and the updater would install exactly that. The script archives the app only after `stapler staple`, and signs the archive last, because the updater's signature is over the archive's bytes: any change to the app after it would make the signature wrong.

## Limits

- The updater replaces the app where it runs. It needs that folder on the same volume as a temporary folder it can use, and to be writable (or an administrator password).
- An app started from the disk image, or from Downloads while macOS still runs it from a read-only copy (App Translocation, which ends once the app has been moved with Finder), cannot replace itself: the install fails with an error in the notice. Move it to Applications first.
- A release cannot be taken back from apps that already installed it. To stop one from spreading, make the release a draft again or publish a newer one.
- The app never downgrades: a `latest.json` with an older or the same version means "up to date".
