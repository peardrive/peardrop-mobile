import {
  normalizeShareLink,
  shouldAttemptResolve,
  isValidShareLink,
  extractKey,
} from "../links";

const KEY = "a".repeat(64);
const URL = `peardrop://${KEY}`;

describe("normalizeShareLink", () => {
  it("returns empty for empty input", () => {
    expect(normalizeShareLink("")).toBe("");
    expect(normalizeShareLink("   ")).toBe("");
  });

  it("passes through a clean peardrop url", () => {
    expect(normalizeShareLink(URL)).toBe(URL);
  });

  it("extracts a peardrop url from surrounding text", () => {
    expect(normalizeShareLink(`grab it: ${URL} now`)).toBe(URL);
  });

  it("adds the scheme to a bare 64-hex key", () => {
    expect(normalizeShareLink(KEY)).toBe(URL);
  });

  it("is case-insensitive on the scheme", () => {
    expect(normalizeShareLink(`PEARDROP://${KEY}`)).toBe(`PEARDROP://${KEY}`);
  });

  it("returns unfamiliar input verbatim (trimmed)", () => {
    expect(normalizeShareLink("  hello  ")).toBe("hello");
  });
});

describe("shouldAttemptResolve", () => {
  it("is false for empty / short garbage", () => {
    expect(shouldAttemptResolve("")).toBe(false);
    expect(shouldAttemptResolve("abc")).toBe(false);
    expect(shouldAttemptResolve("   ")).toBe(false);
  });

  it("is true for peardrop urls or 64-hex keys", () => {
    expect(shouldAttemptResolve(URL)).toBe(true);
    expect(shouldAttemptResolve(KEY)).toBe(true);
  });
});

describe("isValidShareLink", () => {
  it("accepts exactly a 64-hex peardrop url", () => {
    expect(isValidShareLink(URL)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidShareLink(`peardrop://${"a".repeat(63)}`)).toBe(false);
    expect(isValidShareLink(`peardrop://${"z".repeat(64)}`)).toBe(false);
    expect(isValidShareLink(KEY)).toBe(false);
    expect(isValidShareLink("")).toBe(false);
  });
});

describe("extractKey", () => {
  it("pulls the key out of a link and lowercases it", () => {
    expect(extractKey(URL)).toBe(KEY);
    expect(extractKey(`PEARDROP://${KEY.toUpperCase()}`)).toBe(KEY);
  });

  it("returns null on garbage", () => {
    expect(extractKey("")).toBeNull();
    expect(extractKey("peardrop://bad")).toBeNull();
  });
});
