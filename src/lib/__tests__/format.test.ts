import {
  formatBytes,
  formatEta,
  formatRate,
  clampPercent,
  formatRelativeOrDate,
} from "../format";

describe("formatBytes", () => {
  it("returns 0 B for falsy / non-positive inputs", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });

  it("rounds bytes to whole units and uses decimals for KB+", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("steps through MB / GB / TB", () => {
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });
});

describe("formatRate", () => {
  it("falls back to zero for bad inputs", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(NaN)).toBe("0 B/s");
    expect(formatRate(-100)).toBe("0 B/s");
  });

  it("appends /s to byte formatting", () => {
    expect(formatRate(1024)).toBe("1.0 KB/s");
  });
});

describe("formatEta", () => {
  it("handles invalid inputs", () => {
    expect(formatEta(0)).toBe("—");
    expect(formatEta(-1)).toBe("—");
    expect(formatEta(NaN)).toBe("—");
  });

  it("formats sub-second as <1s", () => {
    expect(formatEta(0.4)).toBe("<1s");
  });

  it("formats seconds, minutes, hours", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(90)).toBe("1m 30s");
    expect(formatEta(120)).toBe("2m");
    expect(formatEta(3600)).toBe("1h");
    expect(formatEta(3660)).toBe("1h 1m");
  });
});

describe("clampPercent", () => {
  it("clamps to [0, 100] and handles nullish / NaN", () => {
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(NaN)).toBe(0);
    expect(clampPercent(-50)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42.5)).toBe(42.5);
  });
});

describe("formatRelativeOrDate", () => {
  const NOW = 1_700_000_000_000;

  it("returns null for missing or non-finite input", () => {
    expect(formatRelativeOrDate(undefined, NOW)).toBeNull();
    expect(formatRelativeOrDate(0, NOW)).toBeNull();
    expect(formatRelativeOrDate(NaN, NOW)).toBeNull();
  });

  it('reads sub-minute as "Just now"', () => {
    expect(formatRelativeOrDate(NOW, NOW)).toBe("Just now");
    expect(formatRelativeOrDate(NOW - 30_000, NOW)).toBe("Just now");
  });

  it("collapses to minutes / hours / days within a week", () => {
    expect(formatRelativeOrDate(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelativeOrDate(NOW - 2 * 60 * 60_000, NOW)).toBe("2h ago");
    expect(formatRelativeOrDate(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3d ago");
    expect(formatRelativeOrDate(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe("6d ago");
  });

  it("falls back to an absolute date past one week", () => {
    const result = formatRelativeOrDate(NOW - 30 * 24 * 60 * 60_000, NOW);
    expect(result).not.toBeNull();
    expect(result).not.toMatch(/ago$/);
    expect(result).not.toBe("Just now");
  });

  it("clamps negative diffs (future-stamp clock skew) to 'Just now'", () => {
    expect(formatRelativeOrDate(NOW + 5_000, NOW)).toBe("Just now");
  });
});
