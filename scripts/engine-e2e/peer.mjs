// One PearDrop engine, run on this computer instead of in the phone. Used by reshare-e2e.mjs.
// The engine file is the real one (backend/hyperdrive-engine.mjs); only its three phone-runtime
// imports (bare-fs, bare-fs/promises, bare-path) are pointed at the same parts of Node.
// Commands arrive one per line on stdin; each answer is one line: `RESULT <json>`.
import * as nodeModule from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const map = { "bare-fs": "node:fs", "bare-fs/promises": "node:fs/promises", "bare-path": "node:path" };
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve: (specifier, context, next) => next(map[specifier] ?? specifier, context),
  });
} else {
  const hooks = `
    const map = ${JSON.stringify(map)};
    export async function resolve(specifier, context, next) {
      return next(map[specifier] ?? specifier, context);
    }
  `;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}

// E2E_ENGINE points at another copy of the engine file, to prove the test fails on old code.
const engine = await import(
  process.env.E2E_ENGINE
    ? pathToFileURL(process.env.E2E_ENGINE).href
    : "../../backend/hyperdrive-engine.mjs"
);
const [dataDir, label = "peer"] = process.argv.slice(2);
if (!dataDir) {
  console.error("usage: node peer.mjs <dataDir> [label]");
  process.exit(2);
}

engine.engineSetEmit((evt) => {
  if (process.env.E2E_EVENTS) console.error(`[${label}] event ${JSON.stringify(evt)}`);
});
await engine.engineInit(dataDir, {});

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const summary = () =>
  engine.engineListDrives().map((d) => ({
    id: d.id,
    origin: d.origin,
    state: d.state,
    reshared: d.reshared,
    swarmMode: d.swarmMode,
    localFiles: (d.localFiles || []).length,
  }));

const commands = {
  async "share-file"(file) {
    const res = await engine.engineShareFromPaths([file], null, "e2e");
    return { ok: res?.ok !== false, link: res?.shareLink, driveId: res?.driveId, error: res?.error };
  },
  async grab(link) {
    const opened = await engine.engineOpenDrive(link);
    if (!opened?.ok) return { ok: false, step: "open", error: opened?.error };
    const got = await engine.engineDownload(opened.driveId);
    const files = (got?.files || []).map((f) => ({ name: f.name, sha256: sha256(f.path) }));
    return {
      ok: got?.ok === true && files.length > 0 && (got.failed || []).length === 0,
      step: "download",
      driveId: opened.driveId,
      sharing: got?.sharing,
      files,
      error: got?.error,
    };
  },
  async serve(driveId, value) {
    const res = await engine.engineActivateDrive(driveId, { serve: value === "true" });
    return { ok: res?.ok === true, mode: res?.mode, serveRefused: res?.serveRefused, error: res?.error };
  },
  async list() {
    return { ok: true, drives: summary() };
  },
};

console.log(`RESULT ${JSON.stringify({ ok: true, ready: true })}`);
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const [name, ...args] = line.trim().split("\t");
  if (!name) continue;
  if (name === "exit") break;
  let out;
  try {
    out = commands[name] ? await commands[name](...args) : { ok: false, error: `no command ${name}` };
  } catch (err) {
    out = { ok: false, error: String(err?.stack || err) };
  }
  console.log(`RESULT ${JSON.stringify(out)}`);
}
process.exit(0);
