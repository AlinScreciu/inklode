#!/usr/bin/env bash
# Builds the app for a GitHub release of Inklode: signed, notarized and stapled, as the updater's archive and
# as a disk image. It does not sign the archive for the updater and does not publish: scripts/sign-update.sh
# signs, on the maintainer's Mac, where the updater's private key is. docs/releasing.md has the steps.
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/release.sh
#
# Needs:
#   - a clean working tree, with the same version in src-tauri/tauri.conf.json, src-tauri/Cargo.toml and package.json;
#   - APPLE_SIGNING_IDENTITY: a "Developer ID Application: ..." identity that is in the keychain;
#   - the notarytool keychain profile "inklode-notary" (xcrun notarytool store-credentials inklode-notary).
# NOTARY_KEYCHAIN, if set, is the keychain file that holds the notarytool profile (.github/workflows/release.yml
# sets it); without it notarytool looks in the login keychain.
#
# Writes to release/<version>/ (git-ignored):
#   Inklode.app.tar.gz              what the updater downloads, not yet signed for it
#   Inklode-<version>-aarch64.dmg   the download for people
#
# SKIP_APPLE=1 is for testing this script only. It skips the Developer ID signature, notarization, stapling and
# the Gatekeeper checks, and it allows a working tree with changes. What it makes must not be published:
# macOS refuses to open such an app when it was downloaded.

set -euo pipefail

REPO="AlinScreciu/inklode"
PRODUCT="Inklode"
NOTARY_PROFILE="inklode-notary"
SKIP_APPLE="${SKIP_APPLE:-0}"
# How notarytool finds its credentials. CI keeps the profile in a keychain of its own and names it here.
NOTARY=(--keychain-profile "$NOTARY_PROFILE")
[ -z "${NOTARY_KEYCHAIN:-}" ] || NOTARY+=(--keychain "$NOTARY_KEYCHAIN")

die() {
  echo "release: $*" >&2
  exit 1
}

step() {
  echo
  echo "== $*"
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ "$(uname -s)" = "Darwin" ] || die "this script runs on macOS only"
[ "$(uname -m)" = "arm64" ] || die "this script builds for Apple Silicon only, and this Mac is $(uname -m)"

VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version in src-tauri/tauri.conf.json is not x.y.z: $VERSION"
TAG="v$VERSION"

# The three manifests carry the version; the app's own is tauri.conf.json.
PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -n 1)"
[ "$PACKAGE_VERSION" = "$VERSION" ] || die "package.json has version $PACKAGE_VERSION, tauri.conf.json has $VERSION"
[ "$CARGO_VERSION" = "$VERSION" ] || die "src-tauri/Cargo.toml has version $CARGO_VERSION, tauri.conf.json has $VERSION"

if [ "$SKIP_APPLE" = "1" ]; then
  echo "release: SKIP_APPLE=1: a test run. No Developer ID signature, no notarization. Do not publish the result."
  unset APPLE_SIGNING_IDENTITY
else
  [ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes; commit or stash them first"
  : "${APPLE_SIGNING_IDENTITY:?set it to the \"Developer ID Application: ...\" identity in the keychain}"
  case "$APPLE_SIGNING_IDENTITY" in
    "Developer ID Application: "*) ;;
    *) die "APPLE_SIGNING_IDENTITY must be a \"Developer ID Application: ...\" identity; notarization accepts no other" ;;
  esac
  grep -F -q "\"$APPLE_SIGNING_IDENTITY\"" <<<"$(security find-identity -v -p codesigning)" \
    || die "no valid identity \"$APPLE_SIGNING_IDENTITY\" in the keychain (security find-identity -v -p codesigning)"
  # Asked before the build, so a missing or expired profile does not show up only after it.
  xcrun notarytool history "${NOTARY[@]}" >/dev/null \
    || die "the notarytool profile \"$NOTARY_PROFILE\" does not work (xcrun notarytool store-credentials $NOTARY_PROFILE)"
fi

OUT="$ROOT/release/$VERSION"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/inklode-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT"

# Sends a file to Apple's notary service and waits. notarytool also exits 0 when Apple rejects the file, so the
# status is read from its answer.
notarize() {
  local file="$1" answer id status
  answer="$(xcrun notarytool submit "$file" "${NOTARY[@]}" --wait --output-format json)"
  echo "$answer"
  id="$(node -p 'JSON.parse(process.argv[1]).id' "$answer")"
  status="$(node -p 'JSON.parse(process.argv[1]).status' "$answer")"
  [ "$status" = "Accepted" ] \
    || die "notarization of $(basename "$file") ended as \"$status\"; the reasons: xcrun notarytool log $id --keychain-profile $NOTARY_PROFILE"
}

step "Build $PRODUCT $VERSION"
# With APPLE_SIGNING_IDENTITY set, Tauri signs the app with the hardened runtime (`bundle.macOS.hardenedRuntime`
# in tauri.conf.json), which notarization requires. The app needs no entitlements file: the webview's own
# processes carry theirs, and the app asks for nothing the hardened runtime forbids.
# The variables that make Tauri notarize by itself are taken away, so that it happens once, below.
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  pnpm tauri build --bundles app

BUILT="$ROOT/target/release/bundle/macos/$PRODUCT.app"
[ -d "$BUILT" ] || die "the build did not make $BUILT"
BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$BUILT/Contents/Info.plist")"
[ "$BUILT_VERSION" = "$VERSION" ] || die "the built app says version $BUILT_VERSION, expected $VERSION"

# The copy that is released. `ditto` keeps the signature intact.
APP="$WORK/$PRODUCT.app"
ditto "$BUILT" "$APP"

if [ "$SKIP_APPLE" != "1" ]; then
  step "Check the signature"
  codesign --verify --deep --strict --verbose=2 "$APP"
  # Read into a variable first: `grep -q` stops reading at its match, and with pipefail codesign's broken
  # pipe would count as a failure.
  SIGNATURE="$(codesign --display --verbose=2 "$APP" 2>&1)"
  grep -q 'flags=.*runtime' <<<"$SIGNATURE" || die "the app is not signed with the hardened runtime"

  step "Notarize the app"
  ditto -c -k --keepParent "$APP" "$WORK/$PRODUCT-notarize.zip"
  notarize "$WORK/$PRODUCT-notarize.zip"

  step "Staple and check the app"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl -a -vv "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
fi

step "Updater archive"
# The archive is made only now, from the stapled app:
#   - The updater puts exactly these bytes in the place of the installed app. Stapling adds the notarization
#     ticket to the bundle, so an archive made earlier would install an app without the ticket, and a Mac that
#     is offline, or cannot reach Apple, could not confirm that the app is notarized.
#   - The updater's signature is over the bytes of the archive. scripts/sign-update.sh signs exactly this
#     file later, so nothing may change the app or the archive after this point.
ARCHIVE="$OUT/$PRODUCT.app.tar.gz"
# COPYFILE_DISABLE and --no-mac-metadata keep AppleDouble "._" files out, which would break the app's seal
# once unpacked by the updater. The archive's one top-level entry is the .app folder, as the updater expects.
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$ARCHIVE" -C "$WORK" "$PRODUCT.app"

step "Disk image"
DMG="$OUT/$PRODUCT-$VERSION-aarch64.dmg"
mkdir "$WORK/dmg"
ditto "$APP" "$WORK/dmg/$PRODUCT.app"
ln -s /Applications "$WORK/dmg/Applications"
hdiutil create -volname "$PRODUCT $VERSION" -srcfolder "$WORK/dmg" -format UDZO -ov "$DMG"
if [ "$SKIP_APPLE" != "1" ]; then
  codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl -a -vv -t open --context context:primary-signature "$DMG"
fi

step "Done"
ls -l "$OUT"
if [ "$SKIP_APPLE" = "1" ]; then
  echo
  echo "SKIP_APPLE=1: THIS IS A TEST BUILD, NOT SIGNED BY A DEVELOPER ID AND NOT NOTARIZED. DO NOT PUBLISH IT."
  echo "The commands a real run would print:"
fi
cat <<EOF

Nothing was published, and the archive is not signed for the updater yet. Make the draft release, which no
installed app sees (the tag $TAG must be pushed first):

  gh release create $TAG --repo $REPO --draft --verify-tag --title "$PRODUCT $VERSION" --notes-file <notes.md> \\
    "release/$VERSION/$PRODUCT-$VERSION-aarch64.dmg" \\
    "release/$VERSION/$PRODUCT.app.tar.gz"

Then sign the update, which also says how to publish:

  scripts/sign-update.sh
EOF
