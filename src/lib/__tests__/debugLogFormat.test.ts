import {
  MAX_ENTRY_BYTES,
  MAX_LOG_BYTES,
  buildBundle,
  buildBundleHeader,
  buildLogFilename,
  clampEntry,
  formatEntry,
  formatStructuredError,
  formatTimestamp,
  maxOnDiskBytes,
  shouldRotate,
  slugifyLabel,
  stringifyDetail,
} from "../debugLogFormat";

// Local-time constructor so these assertions hold in any timezone.
const AT = new Date(2026, 7, 8, 14, 3, 7, 412).getTime(); // 2026-08-08 14:03:07.412

describe("formatTimestamp", () => {
  it("renders local time to millisecond resolution", () => {
    expect(formatTimestamp(AT)).toBe("2026-08-08 14:03:07.412");
  });

  it("zero-pads every component", () => {
    const early = new Date(2026, 0, 2, 3, 4, 5, 6).getTime();
    expect(formatTimestamp(early)).toBe("2026-01-02 03:04:05.006");
  });
});

describe("formatEntry", () => {
  it("lays out timestamp, padded level, tag and message", () => {
    expect(formatEntry(AT, "warn", "engine.open", "drive.update raced abort")).toBe(
      "2026-08-08 14:03:07.412  WARN  [engine.open] drive.update raced abort"
    );
  });

  it("pads levels to a fixed width so the tag column stays aligned", () => {
    const debug = formatEntry(AT, "debug", "t", "m");
    const info = formatEntry(AT, "info", "t", "m");
    const error = formatEntry(AT, "error", "t", "m");
    expect(debug.indexOf("[t]")).toBe(info.indexOf("[t]"));
    expect(info.indexOf("[t]")).toBe(error.indexOf("[t]"));
  });

  it("keeps one entry on exactly one line so the export stays grep-able", () => {
    const entry = formatEntry(AT, "error", "x", "line one\nline two\r\nline three");
    expect(entry).not.toMatch(/\n/);
    expect(entry).toContain("line one\\nline two\\nline three");
  });

  it("sanitises tags that would break the bracket column", () => {
    expect(formatEntry(AT, "info", "we ird]tag", "m")).toContain("[we-ird-tag]");
  });

  it("falls back to a default tag when none is given", () => {
    expect(formatEntry(AT, "info", "", "m")).toContain("[app]");
  });

  it("clamps a pathological message so one entry can't eat the budget", () => {
    const entry = formatEntry(AT, "info", "t", "x".repeat(MAX_ENTRY_BYTES * 4));
    expect(entry.length).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(entry.endsWith("…[truncated]")).toBe(true);
  });
});

describe("clampEntry", () => {
  it("leaves short lines untouched", () => {
    expect(clampEntry("short", 100)).toBe("short");
  });

  it("marks truncation visibly rather than silently cutting", () => {
    const out = clampEntry("abcdefghij", 8);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out).toContain("…[truncated]".slice(0, 1));
  });
});

describe("stringifyDetail", () => {
  it("passes strings through and serialises objects", () => {
    expect(stringifyDetail("hi")).toBe("hi");
    expect(stringifyDetail({ a: 1 })).toBe('{"a":1}');
    expect(stringifyDetail(42)).toBe("42");
    expect(stringifyDetail(null)).toBe("");
  });

  it("survives circular structures instead of throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => stringifyDetail(circular)).not.toThrow();
  });
});

describe("formatStructuredError", () => {
  it("preserves category, cause, message and detail (the B4 fix)", () => {
    const rendered = formatStructuredError({
      category: "receive.stall",
      cause: "file-stall",
      message: "no data for 60s",
      detail: { key: "/a.txt", bytes: 12 },
    });
    expect(rendered).toContain("category=receive.stall");
    expect(rendered).toContain("cause=file-stall");
    expect(rendered).toContain('message="no data for 60s"');
    expect(rendered).toContain('detail={"key":"/a.txt","bytes":12}');
  });

  it("does not flatten a structured error down to its message", () => {
    const rendered = formatStructuredError({
      category: "share.file-read-fail",
      cause: "share-file-unreadable",
      message: "Cannot read file",
    });
    expect(rendered).not.toBe("Cannot read file");
  });

  it("degrades gracefully for plain values", () => {
    expect(formatStructuredError("boom")).toBe("boom");
    expect(formatStructuredError(null)).toBe("");
  });
});

describe("shouldRotate", () => {
  it("rotates once the pending write would cross the cap", () => {
    expect(shouldRotate(MAX_LOG_BYTES - 10, 20)).toBe(true);
  });

  it("does not rotate below the cap", () => {
    expect(shouldRotate(MAX_LOG_BYTES - 100, 20)).toBe(false);
  });

  it("does not rotate exactly at the cap", () => {
    expect(shouldRotate(MAX_LOG_BYTES - 20, 20)).toBe(false);
  });

  it("never rotates an empty file, even for an oversized write", () => {
    // Otherwise an entry bigger than the cap would rotate forever and
    // never actually record anything.
    expect(shouldRotate(0, MAX_LOG_BYTES * 3)).toBe(false);
  });

  it("honours a custom cap", () => {
    expect(shouldRotate(90, 20, 100)).toBe(true);
    expect(shouldRotate(50, 20, 100)).toBe(false);
  });
});

describe("maxOnDiskBytes", () => {
  it("is two segments — live plus one rotation", () => {
    expect(maxOnDiskBytes()).toBe(MAX_LOG_BYTES * 2);
    expect(maxOnDiskBytes(100)).toBe(200);
  });
});

describe("slugifyLabel", () => {
  it("makes a tester's free text filesystem-safe", () => {
    expect(slugifyLabel("crash on grab (2nd try)")).toBe("crash-on-grab-2nd-try");
  });

  it("collapses runs and trims edges", () => {
    expect(slugifyLabel("  ...Stuck   at 0%!!  ")).toBe("stuck-at-0");
  });

  it("falls back when the label reduces to nothing", () => {
    expect(slugifyLabel("???")).toBe("log");
    expect(slugifyLabel("")).toBe("log");
  });

  it("caps length without leaving a trailing dash", () => {
    const out = slugifyLabel("a".repeat(80));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("-")).toBe(false);
  });
});

describe("buildLogFilename", () => {
  it("carries label and date, per the sprint's format", () => {
    expect(buildLogFilename("stuck at 0%", AT)).toBe(
      "peardrop-log_stuck-at-0_2026-08-08.txt"
    );
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5).getTime();
    expect(buildLogFilename("x", d)).toBe("peardrop-log_x_2026-01-05.txt");
  });

  it("accepts a Date as well as a timestamp", () => {
    expect(buildLogFilename("x", new Date(AT))).toBe(
      "peardrop-log_x_2026-08-08.txt"
    );
  });
});

describe("buildBundle", () => {
  it("concatenates segments oldest-first so cause precedes effect", () => {
    const out = buildBundle("lbl", AT, ["OLDER\n", "NEWER\n"]);
    expect(out.indexOf("OLDER")).toBeLessThan(out.indexOf("NEWER"));
  });

  it("skips absent segments and reports the real count", () => {
    const out = buildBundle("lbl", AT, ["", "ONLY\n"]);
    expect(out).toContain("segments:  1");
    expect(out).toContain("ONLY");
  });

  it("carries the label, the export time and the raw-content warning", () => {
    const out = buildBundle("my label", AT, ["x\n"]);
    expect(out).toContain("label:     my label");
    expect(out).toContain("2026-08-08 14:03:07.412");
    expect(out).toContain("may contain file paths");
  });

  it("says so explicitly when no label was given", () => {
    expect(buildBundleHeader("  ", AT, 1)).toContain("label:     (none)");
  });
});
