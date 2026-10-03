import {
  ALREADY_HELD_MESSAGE,
  linkNotice,
  linkNoticeToneFor,
  noticeForResolveFailure,
  RESOLVE_TIMEOUT_MESSAGE,
  STILL_RESOLVING_MESSAGE,
} from "../resolveNotice";
import { RESOLVE_NO_MANIFEST_MESSAGE } from "../resolveDisposition";

/**
 * the tone rule.
 *
 * Exactly two triggers are a normal wait ("wait", rendered muted): the
 * no-manifest rejection and the 30 s resolve timeout. Every real failure
 * stays "error" (red). One test per trigger.
 */
describe("linkNoticeToneFor — one assertion per trigger", () => {
  it("no-manifest is a normal wait", () => {
    expect(linkNoticeToneFor("no-manifest")).toBe("wait");
  });

  it("the 30 s resolve timeout is a normal wait", () => {
    expect(linkNoticeToneFor("timeout")).toBe("wait");
  });

  it("a malformed link is an error", () => {
    expect(linkNoticeToneFor("malformed")).toBe("error");
  });

  it("ok-without-driveId is an error", () => {
    expect(linkNoticeToneFor("missing-drive-id")).toBe("error");
  });

  it("an engine failure is an error", () => {
    expect(linkNoticeToneFor("engine-error")).toBe("error");
  });

  it("a failed grab is an error", () => {
    expect(linkNoticeToneFor("grab-failure")).toBe("error");
  });

  it("a generic throw is an error", () => {
    expect(linkNoticeToneFor("generic-throw")).toBe("error");
  });
});

describe("linkNotice — carries the text through unchanged", () => {
  it("pairs the tone with the exact text it was given", () => {
    expect(linkNotice("malformed", "That doesn't look like a PearDrop link.")).toEqual({
      text: "That doesn't look like a PearDrop link.",
      tone: "error",
      trigger: "malformed",
    });
    expect(linkNotice("no-manifest", RESOLVE_NO_MANIFEST_MESSAGE)).toEqual({
      text: RESOLVE_NO_MANIFEST_MESSAGE,
      tone: "wait",
      trigger: "no-manifest",
    });
  });
});

describe("noticeForResolveFailure — the onFailure route", () => {
  it("gives the engine's no-manifest sentence the wait tone (two routes, one sentence, one tone)", () => {
    expect(noticeForResolveFailure(RESOLVE_NO_MANIFEST_MESSAGE)).toEqual({
      text: RESOLVE_NO_MANIFEST_MESSAGE,
      tone: "wait",
      trigger: "no-manifest",
    });
  });

  it("keeps every other failure message an error", () => {
    expect(noticeForResolveFailure("Could not open link.")).toEqual({
      text: "Could not open link.",
      tone: "error",
      trigger: "engine-error",
    });
    expect(noticeForResolveFailure("").tone).toBe("error");
  });
});

describe("the in-preview notices", () => {
  it("tones both as a wait, never an error — neither is a failure", () => {
    expect([
      linkNoticeToneFor("still-resolving"),
      linkNoticeToneFor("already-held"),
    ]).toEqual(["wait", "wait"]);
  });

  it("has copy to check", () => {
    // an empty constant would make the bans below vacuous.
    expect([
      typeof STILL_RESOLVING_MESSAGE,
      typeof ALREADY_HELD_MESSAGE,
    ]).toEqual(["string", "string"]);
    expect(STILL_RESOLVING_MESSAGE.length).toBeGreaterThan(10);
    expect(ALREADY_HELD_MESSAGE.length).toBeGreaterThan(10);
  });

  it("fits the banner and obeys the §B deny-list", () => {
    for (const s of [STILL_RESOLVING_MESSAGE, ALREADY_HELD_MESSAGE]) {
      expect(s.length).toBeLessThanOrEqual(100);
      expect(s).not.toMatch(/check your/i);
      expect(s).not.toMatch(/wi-?fi/i);
      expect(s).not.toMatch(/internet/i);
      expect(s).not.toMatch(/mobile data/i);
      expect(s).not.toMatch(/\bnetwork\b/i);
      expect(s).not.toMatch(/\boffline\b/i);
      expect(s).not.toMatch(/expir/i);
      expect(s).not.toMatch(/timed? out/i);
    }
  });
});

describe("the timeout copy obeys the §B deny-list", () => {
  const s = RESOLVE_TIMEOUT_MESSAGE;

  it("has copy to check, and it fits the sheet (≤ 100 chars)", () => {
    // Positive control first — an empty string would make everything below
    // vacuous (evidence.md).
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(10);
    expect(s.length).toBeLessThanOrEqual(100);
  });

  it("never points the user at a network the app has never looked at", () => {
    // Same bans resolveHint.test.ts enforces: PearDrop has no connectivity
    // detection, so the copy may not say "offline" or blame a network.
    expect(s).not.toMatch(/check your/i);
    expect(s).not.toMatch(/wi-?fi/i);
    expect(s).not.toMatch(/internet/i);
    expect(s).not.toMatch(/mobile data/i);
    expect(s).not.toMatch(/\bnetwork\b/i);
    expect(s).not.toMatch(/\boffline\b/i);
  });

  it("never says or implies a link expires or timed out", () => {
    expect(s).not.toMatch(/expir/i);
    expect(s).not.toMatch(/no longer valid/i);
    expect(s).not.toMatch(/timed? out/i);
  });

  it("makes no claim about how many files the share holds", () => {
    expect(s).not.toMatch(/\bno files\b/i);
    expect(s).not.toMatch(/any files/i);
    expect(s).not.toMatch(/\bempty\b/i);
  });
});
