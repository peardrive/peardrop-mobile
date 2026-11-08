#!/usr/bin/env bash
# Builds a PearDrop Android APK and copies it, versioned, into the shared deliveries folder.
set -euo pipefail

usage() {
  cat <<'EOF'
deliver-apk.sh: build a PearDrop Android APK and copy it into the deliveries folder.

Output:  ~/Anjou/_deliveries/peardrop_android_apk_v<version>[.dbg][_<stamp>].apk
         (override the folder with PEARDROP_DELIVERIES)

Usage:
  npm run deliver:android            debug build, arm64 only (fast, phone-ready)
  scripts/deliver-apk.sh             same
  scripts/deliver-apk.sh --release   release build (debug-signed unless keystore.properties exists)
  scripts/deliver-apk.sh --all-abis  build every ABI (universal APK, ~4x bigger)
  scripts/deliver-apk.sh --clean     ./gradlew clean first

A debug build is standalone too: android/app/build.gradle sets
`react { debuggableVariants = [] }`, so the JS bundle is embedded and no Metro server is needed.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
DELIVERIES="${PEARDROP_DELIVERIES:-$HOME/Anjou/_deliveries}"

BUILD_TYPE="debug"          # debug | release
ABIS="arm64-v8a"            # default: modern phones only (small, fast)
DO_CLEAN="no"
for arg in "$@"; do
  case "$arg" in
    --release)  BUILD_TYPE="release" ;;
    --debug)    BUILD_TYPE="debug" ;;
    --all-abis) ABIS="armeabi-v7a,arm64-v8a,x86,x86_64" ;;
    --clean)    DO_CLEAN="yes" ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

cd "$REPO"

# A fresh clone has no ANDROID_HOME and no local.properties.
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for cand in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -d "$cand/platform-tools" ] || [ -d "$cand/build-tools" ]; then
      export ANDROID_HOME="$cand"; export ANDROID_SDK_ROOT="$cand"; break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "✗ Android SDK not found. Set ANDROID_HOME or install the SDK (Android Studio)." >&2
  exit 1
fi
# gradle reads android/local.properties (gitignored) for sdk.dir — create if absent.
if [ ! -f android/local.properties ]; then
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties
  echo "▸ wrote android/local.properties (sdk.dir=$ANDROID_HOME)"
fi

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
GIT_DIRTY=""
git diff --quiet 2>/dev/null || GIT_DIRTY="-dirty"
STAMP="$(date +%Y%m%d-%H%M)"

echo "──────────────────────────────────────────────────────────────"
echo " PearDrop Android delivery build"
echo "   repo:      $REPO"
echo "   version:   v$VERSION  (git $GIT_SHA$GIT_DIRTY)"
echo "   build:     $BUILD_TYPE   abis: $ABIS"
echo "   deliver→   $DELIVERIES"
echo "──────────────────────────────────────────────────────────────"

if [ ! -d node_modules ]; then
  echo "▸ node_modules missing — running npm install…"
  npm install
fi

# Always re-bundle the Bare backend, or the APK carries a stale engine.
echo "▸ Bundling Bare backend (bare-pack)…"
npm run bundle:backend

GRADLE_TASK="assembleDebug"
OUT_SUBDIR="debug"
[ "$BUILD_TYPE" = "release" ] && { GRADLE_TASK="assembleRelease"; OUT_SUBDIR="release"; }

cd android
[ "$DO_CLEAN" = "yes" ] && { echo "▸ gradle clean…"; sh ./gradlew clean; }
echo "▸ ./gradlew $GRADLE_TASK -PreactNativeArchitectures=$ABIS"
sh ./gradlew "$GRADLE_TASK" -PreactNativeArchitectures="$ABIS"
cd "$REPO"

APK_DIR="android/app/build/outputs/apk/$OUT_SUBDIR"
BUILT_APK="$(ls -t "$APK_DIR"/*.apk 2>/dev/null | head -1 || true)"
if [ -z "$BUILT_APK" ]; then
  echo "✗ No APK found in $APK_DIR — build may have failed." >&2
  exit 1
fi

# Never clobber an earlier delivery of the same version.
mkdir -p "$DELIVERIES"
TAG=""; [ "$BUILD_TYPE" = "debug" ] && TAG=".dbg"
BASE="peardrop_android_apk_v${VERSION}${TAG}"
DEST="$DELIVERIES/${BASE}.apk"
if [ -e "$DEST" ]; then
  DEST="$DELIVERIES/${BASE}_${STAMP}.apk"   # keep the previous same-version build
fi
cp "$BUILT_APK" "$DEST"

SIZE="$(du -h "$DEST" | cut -f1)"
echo "──────────────────────────────────────────────────────────────"
echo " ✓ Delivered: $DEST"
echo "   size: $SIZE   (built from $BUILT_APK)"
echo "──────────────────────────────────────────────────────────────"
echo " Sideload it: copy to the phone and open it, or with adb:"
echo "   adb install -r \"$DEST\""
