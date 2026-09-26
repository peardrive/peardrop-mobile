/**
 * Runs against the real `src/lib/shareListEmptyState.ts` and the real
 * `src/lib/errorMessage.ts`; nothing is reimplemented or mocked. The
 * cross-realm pin reads the engine's own `MANIFEST_UNAVAILABLE_MESSAGE` out
 * of `backend/hyperdrive-engine.mjs` on disk and compares it to the RN
 * constant: the two realms are packed separately and cannot share a module,
 * so drift in the restated string becomes a test failure.
 */

import fs from "fs";
import path from "path";

import {
  MANIFEST_UNAVAILABLE_MESSAGE,
  shareListEmptyState,
} from "../shareListEmptyState";
import { userFacingError } from "../errorMessage";

const ENGINE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "backend",
  "hyperdrive-engine.mjs",
);
const MAIN_SCREEN_PATH = path.join(
  __dirname,
  "..",
  "..",
  "screens",
  "MainScreen.tsx",
);
const EMPTY_STATE_PATH = path.join(__dirname, "..", "..", "ui", "EmptyState.tsx");

describe("an empty list that is actually an error must not read as 'no shares'", () => {
  /**
   * THE PROBE. Before this, `MainScreen.tsx`'s `ListEmptyComponent` branched on
   * `viewMode` alone, so a manifest the engine could not read rendered
   * "Nothing here yet · Pick files above or paste a link." — the same screen a
   * brand-new install shows, while every share the user owned was still on disk.
   */
  it("reports the failure, not an absence, when the manifest is unavailable", () => {
    const out = shareListEmptyState({
      manifestUnavailable: true,
      viewMode: "all",
    });
    expect(out.kind).toBe("manifest-unavailable");
    expect(out.isError).toBe(true);
    expect(out.title).toBe(MANIFEST_UNAVAILABLE_MESSAGE);
    expect(out.title).not.toBe("Nothing here yet");
  });

  it("wins over the favorites filter — the same trouble in either tab", () => {
    const out = shareListEmptyState({
      manifestUnavailable: true,
      viewMode: "favorites",
    });
    expect(out.kind).toBe("manifest-unavailable");
    expect(out.isError).toBe(true);
    expect(out.title).not.toBe("No favorites yet");
  });

  it("leaves the two ordinary empty states exactly as they were", () => {
    expect(
      shareListEmptyState({ manifestUnavailable: false, viewMode: "favorites" }),
    ).toEqual({
      kind: "favorites",
      icon: "heart-outline",
      title: "No favorites yet",
      subtitle: "Tap the heart on a share to add it.",
      isError: false,
    });
    expect(
      shareListEmptyState({ manifestUnavailable: false, viewMode: "all" }),
    ).toEqual({
      kind: "shares",
      icon: "folder-open-outline",
      title: "Nothing here yet",
      subtitle: "Pick files above or paste a link.",
      isError: false,
    });
  });

  it("flags isError only for the failure, so a calm empty state cannot be an error", () => {
    for (const viewMode of ["all", "favorites"] as const) {
      expect(
        shareListEmptyState({ manifestUnavailable: false, viewMode }).isError,
      ).toBe(false);
      expect(
        shareListEmptyState({ manifestUnavailable: true, viewMode }).isError,
      ).toBe(true);
    }
  });
});

describe("the RN copy is the ENGINE's copy", () => {
  /**
   * The cross-realm pin. Ruling 3 says to show the engine's sentence; the
   * failure mode is someone rewording one side. Reading the engine source is a
   * positive control in its own right — if the regex stops matching, the test
   * fails loudly rather than vacuously passing on an empty match.
   */
  it("matches MANIFEST_UNAVAILABLE_MESSAGE in backend/hyperdrive-engine.mjs", () => {
    const src = fs.readFileSync(ENGINE_PATH, "utf8");
    const m = src.match(
      /const MANIFEST_UNAVAILABLE_MESSAGE\s*=\s*\n?\s*"([^"]+)"/,
    );
    // Positive control: the declaration must be found at all. A null match here
    // means the engine renamed or restructured it, which is itself the drift
    // this test exists to catch.
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(MANIFEST_UNAVAILABLE_MESSAGE);
  });

  it("stays inside the copy bans", () => {
    const BANNED = [
      "check your network",
      "check your internet",
      "check your wi-fi",
      "network",
      "offline",
      "expire",
      "expired",
      "internet",
      "wi-fi",
      "wifi",
    ];
    const strings = [
      MANIFEST_UNAVAILABLE_MESSAGE,
      ...(["all", "favorites"] as const).flatMap((viewMode) =>
        [true, false].flatMap((manifestUnavailable) => {
          const s = shareListEmptyState({ manifestUnavailable, viewMode });
          return [s.title, s.subtitle ?? ""];
        }),
      ),
    ];
    for (const copy of strings) {
      const text = copy.toLowerCase();
      for (const banned of BANNED) {
        expect([copy, banned, text.includes(banned)]).toEqual([
          copy,
          banned,
          false,
        ]);
      }
    }
  });
});

describe("ruling 5 · isError has a reader", () => {
  /**
   * These read the real `MainScreen.tsx` and `EmptyState.tsx` off disk and
   * assert on their source text. No `.tsx` can be imported by a test here, so
   * the wiring is provable but the rendered palette is not. Each test carries
   * a positive control so a rename cannot turn it into a vacuous pass.
   */
  it("MainScreen's empty-state memo passes isError to EmptyState", () => {
    const src = fs.readFileSync(MAIN_SCREEN_PATH, "utf8");
    const memo = src.match(
      /const emptyState = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/,
    );
    // Positive control: the memo must exist. A null match means it was renamed
    // or restructured, which is itself the drift this test exists to catch.
    expect(memo).not.toBeNull();
    const body = memo?.[0] ?? "";

    expect(body).toContain("shareListEmptyState(");
    // The contract itself: isError reaches the presentational component.
    expect(body).toMatch(/isError=\{state\.isError\}/);
    // And the styling is NOT keyed off `kind`, which is what the comment bans.
    expect(body).not.toMatch(/state\.kind/);
  });

  /**
   * Asking whether a string appears anywhere in the file passes over a
   * neutralised palette. Each claim is bounded to its own declaration: the
   * props type accepts `isError`, both error styles are applied off it, and
   * each error style's body names `theme.danger` and none of the calm colours.
   */

  /** The calm palette. An error style resolving to any of these is the defect. */
  const CALM_COLOURS = [
    "theme.muted",
    "theme.border",
    "theme.text",
    "theme.surfaceSubtle",
  ];

  /**
   * One entry's body out of `createStyles`'s style object, bounded to that
   * entry. `\b` keeps `iconBadge` from matching `iconBadgeError`, and the
   * closing `\n    },` is the entry's own dedent, so a neighbouring entry
   * cannot leak in and supply a `theme.danger` this one does not have.
   *
   * Positive control: the entry must be found at all. A rename fails here
   * rather than yielding an empty body that trivially satisfies the bans.
   */
  function styleEntryBody(src: string, name: string): string {
    const m = src.match(new RegExp(`\\b${name}: \\{([\\s\\S]*?)\\n {4}\\},`));
    expect({ entry: name, found: m !== null }).toEqual({
      entry: name,
      found: true,
    });
    return m?.[1] ?? "";
  }

  it("EmptyState accepts isError and uses the theme's error colour for it", () => {
    const src = fs.readFileSync(EMPTY_STATE_PATH, "utf8");
    const props = src.match(/export type EmptyStateProps = \{[\s\S]*?\n\};/);
    // Positive control: the props type must exist.
    expect(props).not.toBeNull();
    expect(props?.[0]).toMatch(/isError\??:\s*boolean/);

    // THE PROBE. Each error style is checked in its own bounded body, so a
    // `theme.danger` surviving somewhere else in the file cannot stand in for
    // a palette that has been neutralised.
    for (const entry of ["iconBadgeError", "titleError"]) {
      const body = styleEntryBody(src, entry);
      expect([entry, "theme.danger", body.includes("theme.danger")]).toEqual([
        entry,
        "theme.danger",
        true,
      ]);
      for (const calm of CALM_COLOURS) {
        expect([entry, calm, body.includes(calm)]).toEqual([entry, calm, false]);
      }
    }

    // And the calm path must survive: the muted colour is still referenced.
    expect(src).toMatch(/theme\.muted/);
  });

  it("applies both error styles off isError, not off kind or a literal", () => {
    const src = fs.readFileSync(EMPTY_STATE_PATH, "utf8");
    // Both conditional style applications, verbatim. Dropping either one is
    // the defect in miniature — the prop read, the style unused.
    expect(src).toContain("isError && styles.iconBadgeError");
    expect(src).toContain("isError && styles.titleError");
    // Neither may be keyed off a `kind` string, which is what the
    // shareListEmptyState.ts contract bans. (`kind` appears in this file's doc
    // comments, so the ban is on a *branch*, not on the word.)
    expect(src).not.toMatch(/styles\.\w*Error\b[^\n]*\bkind\b/);
  });

  it("tints the icon glyph itself off isError, with danger on the true branch", () => {
    const src = fs.readFileSync(EMPTY_STATE_PATH, "utf8");
    const icon = src.match(/<Ionicons[\s\S]*?\/>/);
    // Positive control: the element must exist.
    expect(icon).not.toBeNull();
    // The ternary, both arms. `theme.danger : theme.muted` reversed, or either
    // arm collapsed to a constant, fails here.
    expect(icon?.[0]).toMatch(
      /color=\{isError \? theme\.danger : theme\.muted\}/,
    );
  });
});

describe("a rejected create or receive says what actually happened", () => {
  /** Exactly what the engine sends back while the state holds. */
  const REJECTION = {
    category: "manifest.unavailable",
    cause: "manifest-unavailable",
    message: MANIFEST_UNAVAILABLE_MESSAGE,
  };

  /**
   * THE SECOND PROBE, and the one that fails against the pre-fix module.
   *
   * made the caller's fallback win by default, with an empty
   * `CURATED_BY_CAUSE`. Correct for errno text — and wrong here: the generic
   * fallbacks all end "give it another go?", which invites a retry that is
   * GUARANTEED to fail for as long as the manifest is unavailable. Ruling 3's
   * sentence is the one thing that is both true and actionable.
   */
  it("shows the manifest message, not a retry-me fallback", () => {
    expect(
      userFacingError(REJECTION, "Couldn't share those — give it another go?"),
    ).toBe(MANIFEST_UNAVAILABLE_MESSAGE);
    expect(
      userFacingError(
        REJECTION,
        "Couldn't grab those files — give it another go?",
      ),
    ).toBe(MANIFEST_UNAVAILABLE_MESSAGE);
  });

  it("still refuses raw engine text for every other cause", () => {
    // Curation is per-cause and opt-in.
    expect(
      userFacingError(
        {
          category: "share.activate-fail",
          cause: "engine-not-initialized",
          message: "Engine not initialized.",
        },
        "Couldn't activate that one.",
      ),
    ).toBe("Couldn't activate that one.");
    expect(userFacingError({ cause: "anything-at-all" }, "FALLBACK")).toBe(
      "FALLBACK",
    );
  });
});
