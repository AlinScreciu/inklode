#!/usr/bin/env bash
# Signs a draft release's archive for the app's updater and adds the signature and latest.json to the draft.
# Run on the maintainer's Mac: the updater's private key is here and nowhere else, so nothing that happens on
# GitHub alone can ship an update to installed apps. docs/releasing.md has the steps around it.
#
#   scripts/sign-update.sh [version]     (default: the version in src-tauri/tauri.conf.json)
#
# Needs:
#   - the draft release v<version> on GitHub with Inklode.app.tar.gz in it (the release workflow makes it);
#   - the tag v<version> in this clone, on the commit you mean to release;
#   - the updater's private key at ~/.tauri/inklode-updater.key, or INKLODE_UPDATER_KEY set to another path.
#     The key is read by the Tauri CLI; this script never prints it.
#
# Before it signs, it checks that the archive is what a release of this version must be: built from the commit
# the local tag names, signed by the Developer ID team below, notarized, and of that version. It cannot check
# that the app was built from that commit's source and nothing else; that rests on the workflow.
#
# Adds to the draft, and leaves in release/<version>/ (git-ignored):
#   Inklode.app.tar.gz.sig    the signature (the same text is inside latest.json)
#   latest.json               what the app's update check reads

set -euo pipefail

REPO="AlinScreciu/inklode"
PRODUCT="Inklode"
BUNDLE_ID="app.inklode.desktop"
# The Apple developer team whose Developer ID signs releases.
TEAM="H5KM68FLXU"
KEY="${INKLODE_UPDATER_KEY:-$HOME/.tauri/inklode-updater.key}"

die() {
  echo "sign-update: $*" >&2
  exit 1
}

step() {
  echo
  echo "== $*"
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p 'require("./src-tauri/tauri.conf.json").version')}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version is not x.y.z: $VERSION"
TAG="v$VERSION"
[ -f "$KEY" ] || die "no updater key at $KEY (docs/releasing.md says where it lives)"

step "The draft release $TAG"
DRAFT="$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" || die "no release $TAG on GitHub"
[ "$DRAFT" = "true" ] || die "the release $TAG is already published; a published release is not changed"

# The tag here and the tag on GitHub must name the same commit, so that what gets signed is the release that
# was tagged from this clone, not one made from another commit under the same name.
LOCAL_COMMIT="$(git rev-parse --verify --quiet "$TAG^{commit}")" || die "no tag $TAG in this clone"
REMOTE_COMMIT="$(git ls-remote "https://github.com/$REPO.git" "refs/tags/$TAG" | cut -f1)"
[ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ] \
  || die "the tag $TAG is $LOCAL_COMMIT here and ${REMOTE_COMMIT:-missing} on GitHub"
echo "$TAG is $LOCAL_COMMIT here and on GitHub"

OUT="$ROOT/release/$VERSION"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/inklode-sign.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
ARCHIVE="$OUT/$PRODUCT.app.tar.gz"
gh release download "$TAG" --repo "$REPO" --pattern "$PRODUCT.app.tar.gz" --dir "$OUT" --clobber

step "Check the app in the archive"
[ "$(tar -tzf "$ARCHIVE" | cut -d/ -f1 | sort -u)" = "$PRODUCT.app" ] \
  || die "the archive holds something else than one $PRODUCT.app folder"
tar -xzf "$ARCHIVE" -C "$WORK"
APP="$WORK/$PRODUCT.app"
codesign --verify --deep --strict "$APP" || die "the app's signature does not verify"
SIGNATURE="$(codesign --display --verbose=2 "$APP" 2>&1)"
grep -q "^TeamIdentifier=$TEAM\$" <<<"$SIGNATURE" || die "the app is not signed by team $TEAM"
grep -q "^Identifier=$BUNDLE_ID\$" <<<"$SIGNATURE" || die "the app's identifier is not $BUNDLE_ID"
GATEKEEPER="$(spctl -a -vv "$APP" 2>&1)" || die "Gatekeeper refuses the app: $GATEKEEPER"
grep -q "^source=Notarized Developer ID\$" <<<"$GATEKEEPER" || die "the app is not notarized: $GATEKEEPER"
xcrun stapler validate "$APP" >/dev/null || die "the app has no notarization ticket stapled"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ "$APP_VERSION" = "$VERSION" ] || die "the app in the archive says version $APP_VERSION, expected $VERSION"
echo "$PRODUCT $APP_VERSION, team $TEAM, notarized, ticket stapled"

step "Sign the archive"
# `--app-version` puts the version into the signed part of the signature. The app has
# `plugins.updater.requireSignedVersion` on and refuses an update whose signature names another version than
# latest.json does, so a changed latest.json cannot pass an older release off as a new one.
# `signer sign` takes the key file with -f; the key has no password.
rm -f "$ARCHIVE.sig"
env -u TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  pnpm tauri signer sign --app-version "$VERSION" -f "$KEY" "$ARCHIVE" >/dev/null
[ -s "$ARCHIVE.sig" ] || die "signing made no $ARCHIVE.sig"
grep -q "version:$VERSION\$" <<<"$(base64 -d <"$ARCHIVE.sig")" || die "the signature does not carry version $VERSION"

step "latest.json"
# The format of the updater's static JSON file: `signature` is the content of the .sig file, and the key under
# `platforms` is <os>-<arch>.
node -e '
  const fs = require("fs");
  const [out, version, url, sig, notes] = process.argv.slice(1);
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": { signature: fs.readFileSync(sig, "utf8").trim(), url } },
  };
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
' "$OUT/latest.json" "$VERSION" "https://github.com/$REPO/releases/download/$TAG/$PRODUCT.app.tar.gz" \
  "$ARCHIVE.sig" "https://github.com/$REPO/releases/tag/$TAG"
cat "$OUT/latest.json"

step "Add both to the draft"
gh release upload "$TAG" --repo "$REPO" --clobber "$ARCHIVE.sig" "$OUT/latest.json"

cat <<EOF

The draft $TAG is complete and still a draft. Start the app from its disk image, then publish; from that
moment installed apps offer the update, and the release can no longer be changed:

  gh release edit $TAG --repo $REPO --draft=false --latest
EOF
