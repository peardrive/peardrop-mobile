import {
  normalizeShareLink,
  shouldAttemptResolve,
  isValidShareLink,
  extractKey,
  parseIncomingShareLink,
  MAX_INCOMING_LINK_LENGTH,
  DEMO_SHARE_LINK,
} from "../links";
import {
  buildShareKeyDriveIndex,
  resolveReceivedTransfer,
} from "../receiveProgress";

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

  /**
   * The record is keyed by the canonical link, so two spellings of one link
   * must not produce two records.
   */
  it("canonicalises the scheme to lowercase", () => {
    expect(normalizeShareLink(`PEARDROP://${KEY}`)).toBe(URL);
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

// The strict boundary parser for externally-supplied links. A pasted link
// came from a human; an intent-filter link carrying BROWSABLE can come from
// any web page, so this one gets no slack.
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

    /**
     * The allowlist entry goes through the same query/fragment strip as a
     * real key, because a messenger mangles it the same way. A path segment
     * is still malformed and the scheme is still required.
     */
    it("stays subject to the structural rules", () => {
      expect(parseIncomingShareLink("peardrop://demo/extra")).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(parseIncomingShareLink("demo")).toEqual({
        ok: false,
        reason: "not-a-peardrop-link",
      });
      // The strip applies; the allowlist itself has not widened.
      for (const stripped of ["peardrop://demo?x=1", "peardrop://demo#frag"]) {
        expect(parseIncomingShareLink(stripped)).toEqual({
          ok: true,
          kind: "demo",
          link: DEMO_SHARE_LINK,
        });
      }
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

    /**
     * A query string and a fragment are stripped rather than rejected; only
     * an extra path segment is malformed, because `peardrop://host/<key>`
     * must never resolve as `<key>`. Stripping is not a loosening: the query
     * is discarded, nothing downstream reads it, and the key is still
     * validated as exactly 64 hex characters, so a BROWSABLE page gains
     * nothing it did not already have by firing `peardrop://<key>` directly.
     */
    it("an extra path segment, but not a query string or fragment", () => {
      for (const bad of [`${URL}/extra`, `peardrop://host/${KEY}`]) {
        expect(parseIncomingShareLink(bad)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
      for (const stripped of [`${URL}?next=evil`, `${URL}#frag`]) {
        expect(parseIncomingShareLink(stripped)).toEqual({
          ok: true,
          kind: "share",
          link: URL,
          key: KEY,
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

// One canonical parser for every entry path: a mangled link still downloads,
// but nothing keyed on `extractKey` persists, so no row and no completion.

describe("every messenger-mangled shape canonicalises", () => {
  const MIXED = "AbCdEf0123456789".repeat(4);
  const MIXED_URL = `PearDrop://${MIXED}`;

  /** [label, what arrives, the key it must yield] */
  const shapes: [string, string, string][] = [
    ["a clean link", URL, KEY],
    ["a query string", `${URL}?utm_source=whatsapp&fbclid=abc`, KEY],
    ["a bare question mark", `${URL}?`, KEY],
    ["a fragment", `${URL}#preview`, KEY],
    ["a fragment and a query", `${URL}?a=1#b`, KEY],
    ["a trailing full stop", `${URL}.`, KEY],
    ["a trailing slash", `${URL}/`, KEY],
    ["a trailing slash then a full stop", `${URL}/.`, KEY],
    ["a full stop after a query", `${URL}?utm=1.`, KEY],
    ["surrounding whitespace", `   ${URL}\n`, KEY],
    ["mixed case, scheme and key", MIXED_URL, MIXED.toLowerCase()],
    ["mixed case with a query", `${MIXED_URL}?utm=1`, MIXED.toLowerCase()],
  ];

  describe("the deep-link / scan path (parseIncomingShareLink)", () => {
    it.each(shapes)("%s", (_label, input, key) => {
      expect(parseIncomingShareLink(input)).toEqual({
        ok: true,
        kind: "share",
        link: `peardrop://${key}`,
        key,
      });
    });
  });

  describe("the paste path (normalizeShareLink)", () => {
    it.each(shapes)("%s", (_label, input, key) => {
      expect(normalizeShareLink(input)).toBe(`peardrop://${key}`);
    });
  });

  describe("the record key (extractKey)", () => {
    it.each(shapes)("%s", (_label, input, key) => {
      expect(extractKey(input)).toBe(key);
    });
  });

  /**
   * The join. `reconcileShareRecord` persists under `extractKey(link)` and
   * `buildShareKeyDriveIndex` looks the transfer up under the same value. If
   * those agree only for an already-clean link, every shape above yields
   * `null` on one side and a live download on the other — a share that
   * downloads and is recorded nowhere.
   */
  it("every entry path yields byte-identical output, so the record joins", () => {
    for (const [label, input, key] of shapes) {
      const viaPaste = normalizeShareLink(input);
      const viaStrict = parseIncomingShareLink(input);
      const strictLink = viaStrict.ok ? viaStrict.link : "REJECTED";
      expect([label, viaPaste, strictLink]).toEqual([
        label,
        `peardrop://${key}`,
        `peardrop://${key}`,
      ]);
      // The key the record is stored under, derived from each path's output.
      expect([label, extractKey(viaPaste), extractKey(strictLink)]).toEqual([
        label,
        key,
        key,
      ]);
    }
  });

  /**
   * The demo link goes through the same strip: a messenger mangles it the
   * same way, and it is the only end-to-end proof that needs no second
   * device.
   */
  it("canonicalises the demo link through the same strip", () => {
    for (const variant of [
      "peardrop://demo?x=1",
      "peardrop://demo#frag",
      "peardrop://demo.",
      "  PEARDROP://Demo/  ",
    ]) {
      expect(parseIncomingShareLink(variant)).toEqual({
        ok: true,
        kind: "demo",
        link: DEMO_SHARE_LINK,
      });
      expect(normalizeShareLink(variant)).toBe(DEMO_SHARE_LINK);
    }
  });

  /**
   * The downstream join, against the real modules on both sides. The record
   * and the transfer are joined on the 64-hex key: the record is written
   * under `extractKey(normalizedLink)`, the transfer is found under the same
   * value via `buildShareKeyDriveIndex` / `resolveReceivedTransfer`, and the
   * engine's own `drive.key` is the lowercase hex it minted.
   *
   * Both sides here are the real `src/lib` functions; nothing is
   * reimplemented and nothing is mocked. `MainScreen.tsx` is `.tsx` and
   * unreachable from this suite, so what is proved is that the two keys agree
   * for every mangled shape.
   */
  it("joins the record to its transfer for every mangled shape", () => {
    const ENGINE_DRIVE_ID = "drive_7";
    // What the engine reports for a drive opened from this share: it
    // lowercases the key on parse, so this is the canonical key.
    const drives = [
      { id: ENGINE_DRIVE_ID, key: KEY, origin: "received" as const },
    ];
    const transferByDriveId = new Map([[ENGINE_DRIVE_ID, { bytes: 123 }]]);

    for (const [label, input] of shapes.map(
      ([l, i]) => [l, i] as [string, string],
    )) {
      // The paste / scan / deep-link path produces the canonical link…
      const normalizedLink = normalizeShareLink(input);
      // …the record is stored under this key…
      const recordKey = extractKey(normalizedLink);
      // …and the progress index is built with the same value as `live`.
      const index = buildShareKeyDriveIndex(drives, {
        shareKey: recordKey,
        driveId: ENGINE_DRIVE_ID,
      });
      const joined = resolveReceivedTransfer(
        recordKey,
        index,
        transferByDriveId,
      );
      expect([label, recordKey !== null, joined]).toEqual([
        label,
        true,
        { bytes: 123 },
      ]);
    }
  });

  /**
   * The positive control for the case above. A key that genuinely is not
   * this share's must still miss, or the join test would pass on any input
   * at all and prove nothing.
   */
  it("does not join a different share's key", () => {
    const index = buildShareKeyDriveIndex([
      { id: "drive_7", key: KEY, origin: "received" as const },
    ]);
    expect(
      resolveReceivedTransfer(
        "b".repeat(64),
        index,
        new Map([["drive_7", { bytes: 123 }]]),
      ),
    ).toBeUndefined();
    // And a null key joins to nothing, which is the whole defect: a mangled
    // shape that yields no key is recorded nowhere.
    expect(
      resolveReceivedTransfer(null, index, new Map([["drive_7", { bytes: 1 }]])),
    ).toBeUndefined();
  });

  it("still rejects everything that is not unambiguously a key", () => {
    const rejected: [string, string][] = [
      [`${URL}/extra`, "malformed"],
      [`peardrop://host/${KEY}`, "malformed"],
      ["peardrop://", "malformed"],
      ["peardrop:///", "malformed"],
      ["peardrop://?utm=1", "malformed"],
      ["peardrop://demo/extra", "malformed"],
      ["peardrop://demo2", "bad-key-charset"],
      [`peardrop://${"z".repeat(64)}?utm=1`, "bad-key-charset"],
      [`peardrop://${"a".repeat(63)}?utm=1`, "bad-key-length"],
      [`https://example.com/${KEY}`, "not-a-peardrop-link"],
      [`peardrop.mobile://${KEY}`, "not-a-peardrop-link"],
      [KEY, "not-a-peardrop-link"],
      [`grab it: ${URL}`, "not-a-peardrop-link"],
    ];
    for (const [input, reason] of rejected) {
      expect([input, parseIncomingShareLink(input)]).toEqual([
        input,
        { ok: false, reason },
      ]);
    }
  });
});

describe("the paste scrape must not narrow", () => {
  /**
   * The scrape must be `[^\s]+`, not `[^\s]*`: `*` matches zero characters,
   * so a bare `peardrop://` token appearing before the real link wins the
   * scrape and the whole paste comes back `malformed`. A widened parser must
   * reject no previously-accepted shape.
   */
  const shadowed: [string, string][] = [
    ["a bare scheme token before the link", `see peardrop:// then ${URL}`],
    ["two bare scheme tokens before it", `peardrop:// peardrop:// ${URL}`],
    ["a bare scheme token at the very start", `peardrop:// ${URL}`],
    ["a bare scheme token after the link", `${URL} peardrop://`],
    ["a scheme token with a newline between", `peardrop://\n${URL}`],
  ];

  it.each(shadowed)("%s does not shadow the real link", (_label, input) => {
    expect(normalizeShareLink(input)).toBe(URL);
    expect(extractKey(input)).toBe(KEY);
  });

  /**
   * Positive control for the same scrape: a paste whose only `peardrop://`
   * token is bare has nothing after the scheme and is still rejected, so
   * accepting the shadowed link does not make an empty body mean anything.
   */
  it("a paste with nothing but bare scheme tokens is still rejected", () => {
    for (const input of ["peardrop://", "look: peardrop:// ok?", "peardrop:// peardrop://"]) {
      expect([input, extractKey(input)]).toEqual([input, null]);
    }
  });

  /**
   * Second control, for the load-bearing property: the scheme never reaches
   * across a line break to a bare key. `[^\s]` excludes the newline, so the
   * token on line 1 is empty and the bare key on line 2 is not a token at
   * all. A line 2 carrying its own scheme is a normal multi-line paste and
   * resolves.
   */
  it("a scheme never reaches across a newline to a bare key", () => {
    expect(extractKey(`peardrop://\n${KEY}`)).toBeNull();
    expect(extractKey(`peardrop://\n${URL}`)).toBe(KEY);
  });

  it("the first non-empty token still wins, exactly as the old `+` did", () => {
    const other = "b".repeat(64);
    expect(extractKey(`${URL} and peardrop://${other}`)).toBe(KEY);
    // A junk first token is still preferred over a good later one.
    expect(extractKey(`peardrop://zz and ${URL}`)).toBeNull();
  });
});

describe("the bare word `demo` is not a share link", () => {
  /**
   * If `normalizeShareLink("demo")` yields `peardrop://demo`, typing `demo`
   * and submitting opens the bundled demo share: `shouldAttemptResolve` is
   * false so the debounce never fires, but explicit submit calls
   * `runResolve(linkDraft)` directly and ungated. The bare-token fallback
   * exists for a bare 64-hex key, and an English word is not one, so the
   * fallback is gated on the scheme.
   */
  it("a bare `demo` is handed back untouched, as it was before D-22", () => {
    expect(normalizeShareLink("demo")).toBe("demo");
    expect(normalizeShareLink("  DEMO  ")).toBe("DEMO");
    expect(extractKey("demo")).toBeNull();
    expect(parseIncomingShareLink("demo")).toEqual({
      ok: false,
      reason: "not-a-peardrop-link",
    });
  });

  /** POSITIVE CONTROL: the allowlist entry itself is untouched. */
  it("the scheme-carrying demo link still resolves on every path", () => {
    for (const variant of [
      "peardrop://demo",
      "peardrop://demo?x=1",
      "peardrop://demo#frag",
      "peardrop://demo.",
      "  PEARDROP://Demo/  ",
      "here you go: peardrop://demo thanks",
    ]) {
      expect([variant, normalizeShareLink(variant)]).toEqual([
        variant,
        DEMO_SHARE_LINK,
      ]);
    }
  });
});

describe("the trailing strip is linear", () => {
  /**
   * `body.replace(/[./]+$/, "")` backtracks quadratically over a long run of
   * `.`/`/` that is not at end-of-string — seconds at n=80,000. Only a human
   * paste reaches it, since an external payload hits `too-long` first.
   *
   * The bound is deliberately loose: far above anything a linear scan takes
   * and far under the quadratic cost, so it discriminates the algorithm
   * without being a benchmark.
   */
  it("an 80,000-character interior run of ./ finishes fast and still rejects", () => {
    const pathological = `peardrop://${".".repeat(80_000)}x`;
    const started = Date.now();
    const result = extractKey(pathological);
    const elapsedMs = Date.now() - started;
    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("still strips every trailing . and / in any order", () => {
    for (const suffix of ["", ".", "/", "//", "..", "/.", "./", "//.././"]) {
      expect([suffix, extractKey(`${URL}${suffix}`)]).toEqual([suffix, KEY]);
    }
  });
});
