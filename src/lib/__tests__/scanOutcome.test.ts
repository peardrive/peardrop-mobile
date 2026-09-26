/**
 * A scanned QR must never report success for something the app cannot open.
 *
 * This is not a mirror test: it runs against the real `src/lib/scanOutcome.ts`
 * and the real `parseIncomingShareLink` in `src/lib/links.ts`.
 *
 * `src/ui/ReceiveSheet.tsx` is `.tsx` and the suite collects only `*.test.ts`,
 * so the haptic, the badge and the non-latching retry are device items. The
 * classification every one of them branches on is asserted here in full.
 */

import { parseIncomingShareLink, normalizeShareLink } from "../links";
import { classifyScan } from "../scanOutcome";

const KEY = "a".repeat(64);
const LINK = `peardrop://${KEY}`;

describe("the input-shape table, built from source", () => {
  /**
   * The rows below are the scan column — `parseIncomingShareLink` — which is
   * also the deep-link and paste column: all three reach the single
   * `canonicalizeShareLink`. Accept and normalise rather than reject, because
   * a link is valid if a key can be extracted from it unambiguously.
   */
  const rows: [label: string, input: string, accepted: boolean][] = [
    ["bare link", LINK, true],
    ["uppercase hex", `peardrop://${"A".repeat(64)}`, true],
    ["uppercase scheme", `PEARDROP://${KEY}`, true],
    ["one trailing slash", `${LINK}/`, true],
    ["surrounding whitespace", `  ${LINK}  `, true],
    ["demo link", "peardrop://demo", true],
    ["demo with trailing slash", "peardrop://demo/", true],
    // ── flipped by ruling 1 ──────────────────────────────────────────
    ["trailing full stop", `${LINK}.`, true],
    ["query string", `${LINK}?utm=1`, true],
    ["fragment", `${LINK}#x`, true],
    ["demo with query", "peardrop://demo?x=1", true],
    ["two trailing slashes", `${LINK}//`, true],
    // ── still rejected: no key can be extracted unambiguously ────────
    ["extra path segment", `${LINK}/extra`, false],
    ["key behind a host", `peardrop://host/${KEY}`, false],
    ["short key", "peardrop://abc123", false],
    ["non-hex key", `peardrop://${"z".repeat(64)}`, false],
    ["bare key, no scheme", KEY, false],
    ["a plain https URL", "https://example.com/thing", false],
    ["arbitrary text", "WIFI:S=cafe;T=WPA;P=hunter2;;", false],
    ["empty", "", false],
  ];

  it.each(rows)("%s", (_label, input, accepted) => {
    expect(classifyScan(input).kind).toBe(accepted ? "accepted" : "rejected");
  });

  /**
   * The trailing full stop and the trailing slash both normalise, and they
   * normalise identically on the tap, paste and scan paths. That agreement is
   * what makes the downstream record join.
   */
  it("full stop and slash both normalise, identically on every path", () => {
    for (const mangled of [`${LINK}.`, `${LINK}/`, `${LINK}?utm=1`]) {
      const strict = parseIncomingShareLink(mangled);
      expect([mangled, strict.ok && strict.link]).toEqual([mangled, LINK]);
      expect([mangled, normalizeShareLink(mangled)]).toEqual([mangled, LINK]);
      const scan = classifyScan(mangled);
      expect([mangled, scan.kind === "accepted" && scan.link]).toEqual([
        mangled,
        LINK,
      ]);
    }
  });

  it("normalizes what it accepts, so the caller never re-parses", () => {
    const out = classifyScan(`PEARDROP://${"A".repeat(64)}/`);
    expect(out).toEqual({ kind: "accepted", link: LINK });
  });

  it("rejects a non-string payload without throwing", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(classifyScan(bad).kind).toBe("rejected");
    }
  });
});

describe("what a rejected scan is allowed to say", () => {
  /**
   * THE PROBE. Pre-fix `onBarcode` did no validation at all: every QR flashed
   * the frame, fired the SUCCESS haptic, said "Got it — opening…" and handed
   * the payload on. Expressed here as the classification the badge branches on.
   */
  it("never reports success for a code that is not a PearDrop link", () => {
    for (const notALink of [
      "https://example.com",
      "WIFI:S=cafe;T=WPA;P=hunter2;;",
      "BEGIN:VCARD\nEND:VCARD",
      "just some text",
      // `${LINK}?utm=1` used to sit in this list. It is a
      // PearDrop link with a tracking parameter on it, so it now belongs on
      // the accept side — see the shape table. A damaged one takes its place
      // here, so the case still has something to prove.
      `${LINK.slice(0, -1)}?utm=1`,
    ]) {
      expect([notALink, classifyScan(notALink).kind]).toEqual([notALink, "rejected"]);
    }
  });

  it("separates 'not a PearDrop code' from 'damaged', and collapses everything else", () => {
    expect(classifyScan("https://example.com")).toEqual({
      kind: "rejected",
      title: "That's not a PearDrop code",
      message: "Point the camera at the QR code PearDrop showed the sender.",
    });
    // Every damaged class gets ONE message — the deep-link path's rule, reused.
    // a truncated key carrying a query, not `${LINK}?utm=1`,
    // which is now accepted and normalised.
    const damaged = [
      `${LINK.slice(0, -1)}?utm=1`,
      "peardrop://abc123",
      `peardrop://${"z".repeat(64)}`,
      `${LINK}/extra`,
    ];
    const messages = new Set(
      damaged.map((d) => {
        const o = classifyScan(d);
        return o.kind === "rejected" ? o.message : "ACCEPTED";
      }),
    );
    expect(Array.from(messages)).toEqual(["Ask whoever sent it to share the link again."]);
  });

  it("leaks no parser internals to the user", () => {
    for (const input of ["peardrop://abc123", `peardrop://${"z".repeat(64)}`, `${LINK}#x`]) {
      const o = classifyScan(input);
      const text = o.kind === "rejected" ? `${o.title} ${o.message}`.toLowerCase() : "";
      for (const leak of ["charset", "malformed", "hex", "parse", "reason", "length"]) {
        expect([input, leak, text.includes(leak)]).toEqual([input, leak, false]);
      }
    }
  });

  it("carries none of the banned copy", () => {
    for (const input of ["https://example.com", "peardrop://abc123", ""]) {
      const o = classifyScan(input);
      const text = o.kind === "rejected" ? `${o.title} ${o.message}`.toLowerCase() : "";
      // No connectivity claims, and links do not expire.
      for (const banned of [
        "network",
        "offline",
        "internet",
        "wi-fi",
        "wifi",
        "expire",
        "expired",
      ]) {
        expect([input, banned, text.includes(banned)]).toEqual([input, banned, false]);
      }
    }
  });
});
