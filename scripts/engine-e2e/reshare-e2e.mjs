// A link must keep working after the first sender goes away.
//
//   node scripts/engine-e2e/reshare-e2e.mjs
//
// Runs four real PearDrop engines on this computer, over the real network:
//   sender  makes a share
//   phone   downloads it (this is the engine the phone runs)
//   then the sender is killed, and a third engine must get the file from the phone alone.
// It then checks that Stop sharing really stops, that the answer survives a restart, and that a
// restart brings sharing back by itself when the user has not stopped it.
// Needs the internet. Takes two to three minutes: "nobody is sharing this" is only known by waiting.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "peardrop-e2e-"));
const peers = new Set();
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function startPeer(label, dir = path.join(root, label)) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(here, "peer.mjs"), dir, label], {
    stdio: ["pipe", "pipe", process.env.E2E_VERBOSE ? "inherit" : "ignore"],
    env: process.env,
  });
  peers.add(child);
  const waiting = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("RESULT ")) continue;
      const next = waiting.shift();
      if (next) next(JSON.parse(line.slice(7)));
    }
  });
  child.once("exit", (code) => {
    for (const next of waiting.splice(0)) next({ ok: false, error: `engine "${label}" stopped (code ${code})` });
  });
  const answer = () => new Promise((resolve) => waiting.push(resolve));
  const ready = answer();
  return {
    dir,
    ready,
    async ask(...parts) {
      const reply = answer();
      child.stdin.write(`${parts.join("\t")}\n`);
      return reply;
    },
    kill() {
      peers.delete(child);
      child.kill("SIGKILL");
      return new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = (reply) => (reply.drives || []).find((d) => d.origin === "received");

async function main() {
  const source = path.join(root, "clip.bin");
  fs.writeFileSync(source, randomBytes(3 * 1024 * 1024));
  const want = createHash("sha256").update(fs.readFileSync(source)).digest("hex");

  // 1. The sender shares, the phone downloads.
  const sender = startPeer("sender");
  await sender.ready;
  const shared = await sender.ask("share-file", source);
  check("sender made a share", shared.ok && /^peardrop:\/\//.test(shared.link || ""), shared.error);
  const link = shared.link;

  let phone = startPeer("phone");
  await phone.ready;
  const got = await phone.ask("grab", link);
  check("phone downloaded the file", got.ok && got.files?.[0]?.sha256 === want, JSON.stringify(got.error || ""));
  check("phone says it is sharing after the download", got.sharing === true);
  let row = only(await phone.ask("list"));
  check("phone's list shows the share in server mode", row?.swarmMode === "server" && row?.state === "active", JSON.stringify(row));

  // 2. The sender goes away. A third person must still get the file.
  await sender.kill();
  await sleep(2000);
  const third = startPeer("third");
  await third.ready;
  const fromPhone = await third.ask("grab", link);
  check("with the sender gone, a third person gets the file from the phone", fromPhone.ok && fromPhone.files?.[0]?.sha256 === want, JSON.stringify(fromPhone.error || ""));
  await third.kill();

  // 3. Stop sharing stops it. (The third person above is gone too, so nobody else holds it.)
  const stopped = await phone.ask("serve", got.driveId, "false");
  check("Stop sharing is accepted", stopped.ok && stopped.mode !== "server", JSON.stringify(stopped));
  row = only(await phone.ask("list"));
  check("after Stop the list shows it is not sharing", row?.swarmMode !== "server" && row?.reshared === false, JSON.stringify(row));

  // 4. The answer survives a restart.
  await phone.kill();
  phone = startPeer("phone");
  await phone.ready;
  await sleep(3000);
  row = only(await phone.ask("list"));
  check("after a restart it is still not sharing", row?.swarmMode !== "server" && row?.reshared === false, JSON.stringify(row));
  const fourth = startPeer("fourth");
  await fourth.ready;
  const refused = await fourth.ask("grab", link);
  check("a new person cannot get it while sharing is stopped", refused.ok !== true, refused.ok ? "it downloaded" : "");
  await fourth.kill();

  // 5. Share again, restart, and sharing comes back by itself.
  const again = await phone.ask("serve", got.driveId, "true");
  check("Share starts it again", again.ok && again.mode === "server", JSON.stringify(again));
  await phone.kill();
  phone = startPeer("phone");
  await phone.ready;
  await sleep(3000);
  row = only(await phone.ask("list"));
  check("after a restart the phone shares again without being asked", row?.swarmMode === "server", JSON.stringify(row));
  const fifth = startPeer("fifth");
  await fifth.ready;
  const afterRestart = await fifth.ask("grab", link);
  check("a new person gets the file from the restarted phone", afterRestart.ok && afterRestart.files?.[0]?.sha256 === want, JSON.stringify(afterRestart.error || ""));

  // 6. A phone that downloaded before this rule existed: its entry has no answer saved and rests
  //    as "inactive". After a restart it must share.
  await phone.kill();
  const manifestFile = findManifest(phone.dir);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  for (const e of Object.values(manifest.drives)) {
    delete e.reshared;
    e.state = "inactive";
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  phone = startPeer("phone");
  await phone.ready;
  await sleep(3000);
  row = only(await phone.ask("list"));
  check("an old finished download starts sharing after the update", row?.swarmMode === "server" && row?.state === "active", JSON.stringify(row));
}

function findManifest(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "drives") stack.push(full);
      } else if (ent.name === "drives-manifest.json") return full;
    }
  }
  throw new Error("no drives-manifest.json under " + dir);
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.log(`FAIL  the run itself broke — ${err?.stack || err}`);
} finally {
  for (const child of peers) child.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
