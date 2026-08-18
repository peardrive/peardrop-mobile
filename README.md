# PearDrop

PearDrop is a peer-to-peer file sharing app for Android. There is no server and no account: the sending device hosts the files directly from a Hyperdrive and announces itself on a Hyperswarm DHT, and the receiving device connects straight to it. You hand over a share by copying a `peardrop://` link or by scanning a QR code, and transfers run device-to-device for as long as the sender keeps the share active.

## Requirements

- Node.js 18+
- JDK 17
- Android SDK (set `ANDROID_HOME`, or add `sdk.dir` to `android/local.properties`)
- An Android device or emulator
- ~8 GB free disk for release builds

## Setup

```bash
npm install
npm run setup
```

## Run

```bash
npm run dev:android
```

## After changing anything in `backend/`

```bash
npm run bundle:backend
```

The dev scripts do this automatically.

## Build a release APK

```bash
cd android
./gradlew assembleRelease
```

## Testing

```bash
npm test        # jest
npm run lint    # eslint
```

The suite covers the pure logic layer only — path safety, the transfer reducer, link parsing, formatting, the resolve guard, picker-result handling, and mirrored tripwires for the engine's stream and manifest contracts. React Native components are not rendered in tests, and the engine's real behaviour on a device (swarm discovery, replication, transfer completion) is not covered. Verify those on hardware.

## Layout

- `backend/` — the Bare worklet engine. Owns Hyperdrive, Hyperswarm, and all disk I/O for shares. `hyperdrive-engine.mjs` is the only module that talks to Hyperdrive.
- `src/` — the React Native app: `state/` for the backend bridge and storage, `ui/` for components, `screens/` for routed screens, `lib/` for pure helpers.
- `rpc-commands.mjs` — the shared opcode table. Imported by both realms, so the two sides can't drift apart.
- `app/` — the expo-router entry point, plus the generated `app.bundle.mjs`.
- `android/` — the native Android project.
- `assets/demo/` — sample files bundled for the in-app demo mode.
