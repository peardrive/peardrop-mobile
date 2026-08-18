import fs from "node:fs/promises";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import b4a from "b4a";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    i++;
    if (out[key] == null) out[key] = next;
    else if (Array.isArray(out[key])) out[key].push(next);
    else out[key] = [out[key], next];
  }
  return out;
}

const MANIFEST_PATH = "/.peardrop.json";
const state = {
  baseDir: "",
  downloadDir: "",
  activeHosts: new Map(),
};

function fail(message, code = 1) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

function parseShareLink(link) {
  const value = String(link || "").trim();
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  const m = value.match(/^peardrop:\/\/([a-f0-9]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

function createShareLink(keyHex) {
  return `peardrop://${keyHex}`;
}

function mkId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function initDirs(baseDirArg, downloadDirArg) {
  state.baseDir = path.resolve(baseDirArg || ".peardrop-cli-data");
  state.downloadDir = path.resolve(downloadDirArg || ".peardrop-cli-downloads");
  await fs.mkdir(path.join(state.baseDir, "drives"), { recursive: true });
  await fs.mkdir(state.downloadDir, { recursive: true });
}

async function hostFiles(files) {
  const readable = [];
  for (const rawPath of files) {
    const abs = path.resolve(rawPath);
    const data = await fs.readFile(abs);
    readable.push({ abs, name: path.basename(abs), data });
  }
  if (!readable.length) return { ok: false, error: "No files provided." };

  const driveId = mkId("host");
  const drivePath = path.join(state.baseDir, "drives", driveId);
  const store = new Corestore(drivePath);
  await store.ready();
  const drive = new Hyperdrive(store);
  await drive.ready();

  let totalBytes = 0;
  const manifestFiles = [];
  for (const f of readable) {
    await drive.put(`/${f.name}`, f.data);
    totalBytes += f.data.byteLength;
    manifestFiles.push({ path: `/${f.name}`, name: f.name, size: f.data.byteLength });
  }
  await drive.put(
    MANIFEST_PATH,
    b4a.from(
      JSON.stringify({
        version: 1,
        name: readable.length === 1 ? readable[0].name : `${readable.length} files`,
        created: Date.now(),
        files: manifestFiles,
        totalBytes,
        totalFiles: readable.length,
      }),
      "utf8"
    )
  );

  const swarm = new Hyperswarm();
  swarm.on("connection", (socket) => {
    store.replicate(socket);
  });
  const done = drive.findingPeers();
  swarm.join(drive.discoveryKey);
  swarm.flush().then(done, done);

  const keyHex = b4a.toString(drive.key, "hex");
  const shareLink = createShareLink(keyHex);
  state.activeHosts.set(driveId, { driveId, store, drive, swarm, shareLink, totalBytes, files: manifestFiles });
  return { ok: true, driveId, shareLink, totalBytes, files: manifestFiles };
}

async function openByLink(link, timeoutMs = 30000) {
  const keyHex = parseShareLink(link);
  if (!keyHex) return { ok: false, error: "Invalid link. Expected peardrop:// + 64 hex chars." };

  const recvId = mkId("recv");
  const drivePath = path.join(state.baseDir, "drives", recvId);
  const store = new Corestore(drivePath);
  await store.ready();
  const drive = new Hyperdrive(store, b4a.from(keyHex, "hex"));
  await drive.ready();

  const swarm = new Hyperswarm();
  swarm.on("connection", (socket) => store.replicate(socket));
  const done = drive.findingPeers();
  swarm.join(drive.discoveryKey);
  await swarm.flush();
  done();

  await Promise.race([
    drive.update({ wait: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for peer")), timeoutMs)),
  ]);

  let files = [];
  try {
    const raw = await drive.get(MANIFEST_PATH);
    const parsed = raw ? JSON.parse(b4a.toString(raw, "utf8")) : null;
    files = Array.isArray(parsed?.files) ? parsed.files : [];
  } catch {}

  if (!files.length) {
    for await (const entry of drive.list("/")) {
      if (entry.key === MANIFEST_PATH) continue;
      files.push({
        path: entry.key,
        name: path.basename(entry.key),
        size: entry.value?.blob?.byteLength || 0,
      });
    }
  }

  return { ok: true, recvId, store, drive, swarm, files };
}

async function downloadFromLink(link, downloadDir, selectedPath) {
  const opened = await openByLink(link);
  if (!opened.ok) return opened;
  const { store, drive, swarm, files } = opened;
  try {
    const targets = selectedPath
      ? files.filter((f) => f.path === selectedPath || String(f.path).replace(/^\//, "") === String(selectedPath).replace(/^\//, ""))
      : files;
    if (!targets.length) return { ok: false, error: "No files to download." };

    const saved = [];
    for (const file of targets) {
      const blob = await drive.get(file.path);
      if (!blob) continue;
      const outPath = path.join(downloadDir, String(file.path).replace(/^\//, ""));
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, blob);
      saved.push({ name: path.basename(outPath), path: outPath, size: blob.byteLength });
    }
    return { ok: true, files: saved, destDir: downloadDir };
  } finally {
    try { await swarm.destroy(); } catch {}
    try { await drive.close(); } catch {}
    try { await store.close(); } catch {}
  }
}

async function stopHost(driveId) {
  const host = state.activeHosts.get(driveId);
  if (!host) return { ok: false, error: "Host drive not found." };
  try { await host.swarm.destroy(); } catch {}
  try { await host.drive.close(); } catch {}
  try { await host.store.close(); } catch {}
  state.activeHosts.delete(driveId);
  return { ok: true };
}

function appStatus() {
  return {
    ok: true,
    baseDir: state.baseDir,
    downloadDir: state.downloadDir,
    activeHosts: Array.from(state.activeHosts.values()).map((h) => ({
      driveId: h.driveId,
      shareLink: h.shareLink,
      totalBytes: h.totalBytes,
      fileCount: h.files.length,
    })),
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || "").trim().toLowerCase();
  const isInteractive = !cmd || cmd === "interactive";
  await initDirs(args.baseDir, args.downloadDir);

  if (cmd === "help") {
    console.log(
      JSON.stringify({
        ok: true,
        usage: [
          "interactive [--baseDir <dir>] [--downloadDir <dir>] [--verbose]",
          "host --file <path> [--file <path> ...] [--baseDir <dir>] [--verbose] [--keepAlive]",
          "open --link <peardrop://...> [--baseDir <dir>] [--verbose]",
          "download --link <peardrop://...> [--fileName <name>] [--destDir <dir>] [--baseDir <dir>] [--verbose]",
          "status [--baseDir <dir>]",
          "stop --driveId <id> [--baseDir <dir>]",
        ],
      })
    );
    return;
  }

  if (isInteractive) {
    const rl = readline.createInterface({ input, output });
    try {
      // Simple interactive harness for phone testing from PowerShell.
      while (true) {
        output.write("\nPearDrop Phone Test\n");
        output.write("1) Host files and generate share link\n");
        output.write("2) Download from share link\n");
        output.write("3) Status\n");
        output.write("4) Exit\n");
        const pick = (await rl.question("Choose 1-4: ")).trim();

        if (pick === "1") {
          const raw = (await rl.question("Enter file paths (comma-separated): ")).trim();
          const files = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (!files.length) {
            output.write("No files provided.\n");
            continue;
          }
          const share = await hostFiles(files);
          output.write(`${JSON.stringify(share, null, 2)}\n`);
          if (share.ok && share.shareLink) {
            output.write(`Share link: ${share.shareLink}\n`);
          }
          continue;
        }

        if (pick === "2") {
          const link = (await rl.question("Paste peardrop link: ")).trim();
          if (!link) {
            output.write("Link is required.\n");
            continue;
          }
          const opened = await openByLink(link);
          if (!opened.ok) {
            output.write(`${JSON.stringify(opened, null, 2)}\n`);
            continue;
          }
          const listForPrompt = opened.files || [];
          output.write(`${JSON.stringify({ ok: true, files: listForPrompt }, null, 2)}\n`);

          const onlyOne = (await rl.question("Download one file only? (y/N): ")).trim().toLowerCase();
          let selectedPath;
          if (onlyOne === "y" || onlyOne === "yes") {
            const listed = Array.isArray(listForPrompt) ? listForPrompt : [];
            if (!listed.length) {
              output.write("No files listed by drive.\n");
            } else {
              listed.forEach((f, i) => {
                output.write(`${i + 1}) ${f.name || f.path} (${f.size || 0} bytes)\n`);
              });
              const idxRaw = (await rl.question("Pick file number: ")).trim();
              const idx = Number(idxRaw);
              if (Number.isInteger(idx) && idx >= 1 && idx <= listed.length) {
                selectedPath = listed[idx - 1].path;
              }
            }
          }

          const dl = await downloadFromLink(link, state.downloadDir, selectedPath);
          output.write(`${JSON.stringify(dl, null, 2)}\n`);
          try { await opened.swarm.destroy(); } catch {}
          try { await opened.drive.close(); } catch {}
          try { await opened.store.close(); } catch {}
          continue;
        }

        if (pick === "3") {
          output.write(`${JSON.stringify(appStatus(), null, 2)}\n`);
          continue;
        }

        if (pick === "4") break;
        output.write("Invalid selection.\n");
      }
    } finally {
      rl.close();
    }
    return;
  }

  if (cmd === "host") {
    const files = []
      .concat(args.file || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!files.length) fail("host requires at least one --file path");

    const share = await hostFiles(files);
    console.log(JSON.stringify(share));
    if (!share.ok || !args.keepAlive) return;

    console.error("[host] Running. Press Ctrl+C to stop sharing.");
    await new Promise((resolve) => {
      const cleanup = async () => {
        try {
          await stopHost(share.driveId);
        } catch {}
        resolve();
      };
      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);
    });
    return;
  }

  if (cmd === "open") {
    const link = String(args.link || "").trim();
    if (!link) fail("open requires --link");
    const opened = await openByLink(link);
    console.log(JSON.stringify({ ok: opened.ok, files: opened.files, error: opened.error }));
    if (opened.ok) {
      try { await opened.swarm.destroy(); } catch {}
      try { await opened.drive.close(); } catch {}
      try { await opened.store.close(); } catch {}
    }
    return;
  }

  if (cmd === "download") {
    const link = String(args.link || "").trim();
    if (!link) fail("download requires --link");
    const dl = await downloadFromLink(
      link,
      args.destDir ? path.resolve(String(args.destDir)) : state.downloadDir,
      args.fileName ? String(args.fileName) : undefined
    );
    console.log(JSON.stringify(dl));
    if (!dl.ok) process.exit(1);
    return;
  }

  if (cmd === "status") {
    console.log(JSON.stringify(appStatus()));
    return;
  }

  if (cmd === "stop") {
    const driveId = String(args.driveId || "").trim();
    if (!driveId) fail("stop requires --driveId");
    const res = await stopHost(driveId);
    console.log(JSON.stringify(res));
    return;
  }

  fail(`Unknown command: ${cmd}`);
}

run().catch((err) => fail(String(err?.stack || err?.message || err)));
