#!/usr/bin/env bash
#
# deliver-apk.sh — build a PearDrop Android APK and drop it into the shared
# PearDrop deliveries folder, clearly named so mobile/desktop builds sort apart.
#
# Output:  ~/Anjou/_deliveries/peardrop_android_apk_v<version>[.dbg][_<stamp>].apk
#
# Usage:
#   npm run deliver:android            # debug build, arm64 only (fast, phone-ready)
#   scripts/deliver-apk.sh             # same
#   scripts/deliver-apk.sh --release   # release build (debug-signed unless keystore.properties exists)
#   scripts/deliver-apk.sh --all-abis  # build every ABI (universal APK, ~4x bigger)
#   scripts/deliver-apk.sh --clean     # ./gradlew clean first
#
# Why debug is still standalone: android/app/build.gradle sets
# `react { debuggableVariants = [] }`, so the debug variant embeds the Hermes
# JS bundle — the APK runs on a phone with no Metro server. See that file.
#
set -euo pipefail

# ── locate the repo (this script lives in <repo>/scripts) ───────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
DELIVERIES="${PEARDROP_DELIVERIES:-$HOME/Anjou/_deliveries}"

# ── options ─────────────────────────────────────────────────────────────────
BUILD_TYPE="debug"          # debug | release
ABIS="arm64-v8a"            # default: modern phones only (small, fast)
DO_CLEAN="no"
for arg in "$@"; do
  case "$arg" in
    --release)  BUILD_TYPE="release" ;;
    --debug)    BUILD_TYPE="debug" ;;
    --all-abis) ABIS="armeabi-v7a,arm64-v8a,x86,x86_64" ;;
    --clean)    DO_CLEAN="yes" ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

cd "$REPO"

# ── Android SDK discovery (fresh clone has no ANDROID_HOME / local.properties) ─
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

# ── 1. deps (fresh clone has no node_modules) ───────────────────────────────
if [ ! -d node_modules ]; then
  echo "▸ node_modules missing — running npm install…"
  npm install
fi

# ── 2. compile the Bare P2P backend (MUST run so engine changes are picked up)
echo "▸ Bundling Bare backend (bare-pack)…"
npm run bundle:backend

# ── 3. gradle build ─────────────────────────────────────────────────────────
GRADLE_TASK="assembleDebug"
OUT_SUBDIR="debug"
[ "$BUILD_TYPE" = "release" ] && { GRADLE_TASK="assembleRelease"; OUT_SUBDIR="release"; }

cd android
[ "$DO_CLEAN" = "yes" ] && { echo "▸ gradle clean…"; sh ./gradlew clean; }
echo "▸ ./gradlew $GRADLE_TASK -PreactNativeArchitectures=$ABIS"
sh ./gradlew "$GRADLE_TASK" -PreactNativeArchitectures="$ABIS"
cd "$REPO"

# ── 4. locate the produced APK ──────────────────────────────────────────────
APK_DIR="android/app/build/outputs/apk/$OUT_SUBDIR"
BUILT_APK="$(ls -t "$APK_DIR"/*.apk 2>/dev/null | head -1 || true)"
if [ -z "$BUILT_APK" ]; then
  echo "✗ No APK found in $APK_DIR — build may have failed." >&2
  exit 1
fi

# ── 5. name + copy into deliveries (never clobber an existing build) ─────────
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
