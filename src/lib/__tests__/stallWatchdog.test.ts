// Tripwire for the stall watchdog inside
// pipeDriveToFile. The engine's pipeDriveToFile uses bare-fs streams;
// Jest can't load them. We mirror the watchdog logic against
// node:stream with fake timers, exercising three scenarios:
//   1. Successful transfer well under the timeout — no fire.
//   2. Simulated stall — timer fires with typed cause.
//   3. Slow-but-live transfer that keeps emitting data — no false fire.

import { PassThrough, Writable, Readable } from "node:stream";

const STALL_TIMEOUT_MS = 60000;

// FileStallError carries category via the EngineError base.
class FileStallError extends Error {
  category: string = "receive.stall";
  override cause: string;
  detail: unknown;
  constructor() {
    super(`stalled: no data for ${STALL_TIMEOUT_MS / 1000}s`);
    this.name = "FileStallError";
    this.cause = "file-stall";
    this.detail = {};
  }
}

function pipeWithWatchdog(
  rs: Readable,
  ws: Writable,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stallTimer: NodeJS.Timeout | null = null;
    const clearStall = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const done = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearStall();
      if (err) {
        try {
          rs.destroy();
        } catch {}
        try {
          ws.destroy();
        } catch {}
        reject(err);
      } else {
        resolve();
      }
    };
    const armStall = (): void => {
      clearStall();
      stallTimer = setTimeout(() => done(new FileStallError()), STALL_TIMEOUT_MS);
    };
    rs.once("error", done);
    ws.once("error", done);
    ws.once("close", () => done(null));
    ws.once("finish", () => done(null));
    rs.on("data", armStall);
    rs.pipe(ws);
    armStall();
  });
}

// A writable that collects chunks in memory for verification.
function memoryWritable(): Writable & { collected: Buffer[] } {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as Writable & { collected: Buffer[] };
  w.collected = chunks;
  return w;
}

describe("stall watchdog tripwire", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("scenario 1 — successful transfer under timeout does not fire", async () => {
    const rs = new PassThrough();
    const ws = memoryWritable();

    const pipePromise = pipeWithWatchdog(rs, ws);

    // Push all data and end quickly. Advance real microtasks first.
    rs.write("hello ");
    rs.write("world");
    rs.end();

    // Flush any pending timers set during the microtask queue.
    jest.advanceTimersByTime(1);

    await expect(pipePromise).resolves.toBeUndefined();
    expect(Buffer.concat(ws.collected).toString()).toBe("hello world");
  });

  test("scenario 2 — no data ever arriving fires the watchdog", async () => {
    const rs = new PassThrough();
    const ws = memoryWritable();

    const pipePromise = pipeWithWatchdog(rs, ws);

    // Advance past the stall window without any data.
    jest.advanceTimersByTime(STALL_TIMEOUT_MS + 100);

    await expect(pipePromise).rejects.toMatchObject({
      name: "FileStallError",
      cause: "file-stall",
      category: "receive.stall",
    });
  });

  test("scenario 3 — mid-transfer stall fires the watchdog", async () => {
    const rs = new PassThrough();
    const ws = memoryWritable();

    const pipePromise = pipeWithWatchdog(rs, ws);

    // Some data lands, then silence.
    rs.write("first chunk");
    // Wait 100 ms — well under threshold — then simulate the peer going quiet.
    jest.advanceTimersByTime(100);

    // No more writes. Advance past the stall window.
    jest.advanceTimersByTime(STALL_TIMEOUT_MS + 100);

    await expect(pipePromise).rejects.toMatchObject({
      cause: "file-stall",
      category: "receive.stall",
    });
  });

  test("scenario 4 — slow but live transfer keeps re-arming, no false fire", async () => {
    const rs = new PassThrough();
    const ws = memoryWritable();

    const pipePromise = pipeWithWatchdog(rs, ws);

    // Emit 10 chunks with 30 s between them. Each chunk resets the
    // 60 s timer, so we should never trip even though the whole transfer
    // takes 5 minutes.
    for (let i = 0; i < 10; i++) {
      rs.write(`chunk-${i}`);
      jest.advanceTimersByTime(30000);
    }
    rs.end();
    jest.advanceTimersByTime(1);

    await expect(pipePromise).resolves.toBeUndefined();
    expect(Buffer.concat(ws.collected).toString()).toContain("chunk-9");
  });

  test("scenario 5 — read-stream error propagates and clears the timer", async () => {
    const rs = new PassThrough();
    const ws = memoryWritable();

    const pipePromise = pipeWithWatchdog(rs, ws);

    rs.destroy(new Error("stream boom"));

    await expect(pipePromise).rejects.toThrow("stream boom");

    // Timer should have been cleared — advancing time now must not
    // produce a second rejection (already-settled guard also protects).
    jest.advanceTimersByTime(STALL_TIMEOUT_MS * 2);
    // No unhandled rejection assertion; the settled guard is the invariant.
  });
});
