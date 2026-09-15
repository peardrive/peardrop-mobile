import {
  normalizeShareLink,
  shouldAttemptResolve,
  isValidShareLink,
  extractKey,
  parseIncomingShareLink,
  MAX_INCOMING_LINK_LENGTH,
  DEMO_SHARE_LINK,
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

// the strict boundary parser for externally-supplied links.
// A pasted link came from a human; an intent-filter link carrying
// BROWSABLE can come from any web page, so this one gets no slack.
describe("parseIncomingShareLink", () => {
  // Mixed-case hex so the lowercase-canonicalization is actually exercised.
  const MIXED = "AbCdEf0123456789".repeat(4);

  describe("accepts", () => {
    it("a clean engine-minted link", () => {
      expect(parseIncomingShareLink(URL)).toEqual({
        ok: true,
        kind: "share",
        link: URL,
        key: KEY,
      });
    });

    it("an uppercase scheme, canonicalizing it to lowercase", () => {
      expect(parseIncomingShareLink(`PEARDROP://${KEY}`)).toEqual({
        ok: true,
        kind: "share",
        link: URL,
        key: KEY,
      });
    });

    it("mixed-case hex, canonicalizing the key to lowercase", () => {
      const parsed = parseIncomingShareLink(`peardrop://${MIXED}`);
      expect(parsed).toEqual({
        ok: true,
        kind: "share",
        link: `peardrop://${MIXED.toLowerCase()}`,
        key: MIXED.toLowerCase(),
      });
    });

    it("one trailing slash, as browsers and launchers append", () => {
      expect(parseIncomingShareLink(`${URL}/`)).toEqual({
        ok: true,
        kind: "share",
        link: URL,
        key: KEY,
      });
    });

    it("surrounding whitespace", () => {
      expect(parseIncomingShareLink(`  ${URL}  `)).toEqual({
        ok: true,
        kind: "share",
        link: URL,
        key: KEY,
      });
    });

    it("a link exactly at the length ceiling", () => {
      expect(URL.length).toBeLessThan(MAX_INCOMING_LINK_LENGTH);
      const padded = URL.padEnd(MAX_INCOMING_LINK_LENGTH, " ");
      expect(padded.length).toBe(MAX_INCOMING_LINK_LENGTH);
      expect(parseIncomingShareLink(padded).ok).toBe(true);
    });
  });

  // one explicit allowlist entry, so the whole incoming-link
  // chain has an end-to-end proof that needs no network.
  describe("the demo allowlist entry", () => {
    it("pins the literal that lib/demo.ts DEMO_LINK must match", () => {
      // links.ts can't import demo.ts (it pulls in RNFS/expo-asset and
      // would break this suite), so the coupling is pinned here instead.
      expect(DEMO_SHARE_LINK).toBe("peardrop://demo");
    });

    it("accepts peardrop://demo, tagged so the caller can route it", () => {
      expect(parseIncomingShareLink(DEMO_SHARE_LINK)).toEqual({
        ok: true,
        kind: "demo",
        link: DEMO_SHARE_LINK,
      });
    });

    it("accepts every case variant, canonicalized", () => {
      for (const variant of [
        "PEARDROP://DEMO",
        "peardrop://DEMO",
        "PearDrop://Demo",
        "  peardrop://Demo  ",
        "peardrop://demo/",
      ]) {
        expect(parseIncomingShareLink(variant)).toEqual({
          ok: true,
          kind: "demo",
          link: DEMO_SHARE_LINK,
        });
      }
    });

    it("carries no key — it is not an engine-minted share", () => {
      const parsed = parseIncomingShareLink(DEMO_SHARE_LINK);
      expect(parsed.ok).toBe(true);
      expect(parsed).not.toHaveProperty("key");
    });

    it("still rejects near-misses — this is an allowlist, not a loosening", () => {
      for (const near of [
        "peardrop://demo2",
        "peardrop://demos",
        "peardrop://ademo",
        "peardrop://de-mo",
        "peardrop://dem",
      ]) {
        expect(parseIncomingShareLink(near)).toEqual({
          ok: false,
          reason: "bad-key-charset",
        });
      }
    });

    it("stays subject to the structural rules", () => {
      for (const bad of [
        "peardrop://demo?x=1",
        "peardrop://demo#frag",
        "peardrop://demo/extra",
      ]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
      expect(parseIncomingShareLink("demo")).toEqual({
        ok: false,
        reason: "not-a-peardrop-link",
      });
    });
  });

  describe("rejects", () => {
    it("empty, whitespace-only, and non-string input", () => {
      for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "empty",
        });
      }
    });

    it("anything over the length ceiling, before parsing", () => {
      const huge = `peardrop://${"a".repeat(MAX_INCOMING_LINK_LENGTH)}`;
      expect(parseIncomingShareLink(huge)).toEqual({
        ok: false,
        reason: "too-long",
      });
    });

    it("a different scheme", () => {
      for (const bad of [
        `peardrop.mobile://${KEY}`,
        `https://example.com/${KEY}`,
        `javascript:alert(1)`,
        `peardropx://${KEY}`,
      ]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "not-a-peardrop-link",
        });
      }
    });

    it("a link buried in surrounding text (unlike the paste path)", () => {
      // normalizeShareLink scrapes this out; the boundary parser must not.
      expect(normalizeShareLink(`grab it: ${URL}`)).toBe(URL);
      expect(parseIncomingShareLink(`grab it: ${URL}`)).toEqual({
        ok: false,
        reason: "not-a-peardrop-link",
      });
    });

    it("a bare key with no scheme", () => {
      expect(parseIncomingShareLink(KEY)).toEqual({
        ok: false,
        reason: "not-a-peardrop-link",
      });
    });

    it("the scheme with nothing after it", () => {
      expect(parseIncomingShareLink("peardrop://")).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(parseIncomingShareLink("peardrop:///")).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it("a query string, fragment, or extra path segment", () => {
      for (const bad of [
        `${URL}?next=evil`,
        `${URL}#frag`,
        `${URL}/extra`,
        `peardrop://host/${KEY}`,
      ]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
    });

    it("non-hex characters in the key", () => {
      for (const bad of [
        `peardrop://${"z".repeat(64)}`,
        `peardrop://${"a".repeat(63)}z`,
        `peardrop://${"a".repeat(62)}_z`,
      ]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "bad-key-charset",
        });
      }
    });

    it("hex of the wrong length", () => {
      for (const bad of [
        `peardrop://${"a".repeat(63)}`,
        `peardrop://${"a".repeat(65)}`,
        `peardrop://ab`,
      ]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "bad-key-length",
        });
      }
    });
  });

  it("never throws, whatever it is handed", () => {
    const nasty: unknown[] = [
      null,
      undefined,
      NaN,
      Symbol("x"),
      () => URL,
      { toString: () => URL },
      `peardrop://${"%00".repeat(20)}`,
      "peardrop://\n" + KEY,
    ];
    for (const input of nasty) {
      expect(() => parseIncomingShareLink(input)).not.toThrow();
      expect(parseIncomingShareLink(input).ok).toBe(false);
    }
  });
});
