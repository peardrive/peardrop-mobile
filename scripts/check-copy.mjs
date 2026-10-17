#!/usr/bin/env node
/** Fail the build on copy asserting what the app cannot know: there is no connectivity detection and links never expire. */
// Scans string literals and element text, not a plain grep; comments are blanked and tests skipped, and the selftest proves both filters still catch a real hit.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * `backend/` was at one point NOT scanned, though a note elsewhere in this file
 * claimed it was.
 *
 * This was not a theoretical gap. The rule is *"no path may ever show
 * 'Drive not found' to a user again"*, and **the only producer of that string
 * was `backend/hyperdrive-engine.mjs`** — the one file the guard could not see.
 * A review planted `Drive not found` plus an offline claim as real string
 * literals in that file and this script reported **"clean, 121 files", exit 0**;
 * the identical strings in `src/lib/errorMessage.ts` produced exit 1.
 *
 * `rpc-commands.mjs` is included too: it is imported by BOTH realms, so a string
 * added there ships in both, and it sits at the repo root where neither `src` nor
 * `backend` would have reached it. It is also a file that was once edited with no
 * snapshot baseline, which is its own argument for coverage.
 *
 * **Engine strings are not all user-facing** — most are `debugLog` arguments, and
 * the `logCallSpans` suppression below already handles that, with a planted
 * offender immediately after a `debugLog` call proving the suppression does not
 * swallow a real hit.
 */
const SCAN_ROOTS = ["src", "app", "backend", "rpc-commands.mjs"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** The hand-rolled word boundary is deliberate: it must not fire on an identifier that merely contains the word. */
// The subject text is padded with a space on each side before testing, which restores the boundaries the pattern would otherwise lose at the ends.
const BANNED = /offline|no internet|check your|slow network|[^a-z]network[^a-z]|expired?/i;

/** The exact strings allowed to say the sender is offline, and nothing else. */
// An exact-string list, not a loosened pattern, so any new wording containing the word still fails.
const OFFLINE_CLAIM_ALLOWED = new Set([
  "Sender offline. Files appear when they're back.",
  "Sender offline. Choose files now; they download when the sender is back.",
  "Queued · sender offline",
  // The row and header line are assembled, so the literal in the source is the
  // conditional's own arm rather than the finished sentence.
  '"retrying" : "sender offline"}',
  // The picker's accessibility label for the sender dot.
  "Sender offline",
  "Sender online",
  /** The row line as the scanner sees it: the extractor drops the template holes, so what it tests is the trailing chunk with the percentage already removed. */
  "% · sender offline",
]);

/** Bare union-member tokens that happen to spell a banned word; the copy they drive is on the allow-list above. */
// An exact-string set, because a lowercase-word rule would exempt a real one-word label too.
const NON_PROSE_TOKENS = new Set(["expired", "senderOffline"]);

/** No path may ever show 'Drive not found' to a user again. */
const RAW_ENGINE_TEXT = /drive not found/i;

/** No emoji in product copy. Stops short of the em-dash, middot and ellipsis this app uses on purpose. */
// Neither emoji-only nor exhaustive: widen it when a real offender appears rather than pre-emptively.
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

/** Prose above this cap truncates in the tightest wrapping container, so a scanned literal over it fails. */
// Deliberately not applied to element text, where existing paragraphs exceed it in containers that cannot truncate.
const MAX_PROSE_LENGTH = 120;

/**
 * Files deliberately not scanned. **Every entry names a reason.** A silent
 * skip list is how a banned string survives a check that reports green.
 */
const EXCLUSIONS = [
  {
    file: "app/app.bundle.mjs",
    reason:
      "BUILD ARTIFACT, not source — the packed Bare worklet bundle emitted by " +
      "`npm run bundle:backend`. CLAUDE.md forbids hand-editing it, and it is " +
      "already in eslint.config.js's ignore list. Its copy is governed by " +
      "backend/*.mjs, which is scanned there, not here.",
  },
  {
    file: "src/screens/ReceiveScreen.tsx",
    reason:
      "DEAD — zero importers anywhere in src/ or app/ (verified FIX-2026-09 " +
      "Phase 2h). Carries two banned strings at :1047. Deletion is deferred " +
      "to PUBLISHIT.md Appendix D, after the tester build; editing a file " +
      "that is about to be deleted is churn.",
  },
];

/** An exclusion must rest on the file not being built, never on nobody currently calling it. */
// A file that is compiled and route-registered would ship its copy on one navigate call with no warning, so it is scanned.

const EXCLUDED_FILES = new Set(EXCLUSIONS.map((e) => e.file));

/** Test files assert *about* banned copy, so they quote it by necessity. */
function isTestFile(rel) {
  return (
    rel.includes("__tests__") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** Walks the source once, returning the same text with comments and string bodies blanked so offsets survive, plus each string literal and template chunk. */
// Regex literals are recognised by the previous-significant-token heuristic, so a quote inside a character class cannot desynchronise the scan.
function scan(src) {
  const masked = new Array(src.length).fill(null);
  const strings = [];
  let i = 0;
  let prevSignificant = "";

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      masked[k] = src[k] === "\n" ? "\n" : " ";
    }
  };

  const regexCanStart = () =>
    prevSignificant === "" ||
    "(,=:[!&|?{};+-*%~^<>".includes(prevSignificant);

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // ---- comments ----------------------------------------------------
    if (c === "/" && next === "/") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      let end = src.indexOf("*/", i + 2);
      end = end === -1 ? src.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }

    // ---- regex literal -----------------------------------------------
    if (c === "/" && regexCanStart()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        blank(i, j);
        prevSignificant = "/";
        i = j;
        continue;
      }
      // Not a regex after all — fall through and treat as an operator.
    }

    // ---- quoted strings ----------------------------------------------
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let body = "";
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          body += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === quote || d === "\n") break;
        body += d;
        j += 1;
      }
      const end = src[j] === quote ? j + 1 : j;
      masked[i] = quote;
      blank(i + 1, end - 1 < i + 1 ? i + 1 : end - 1);
      if (end - 1 >= i + 1) masked[end - 1] = quote;
      strings.push({ text: body, index: i + 1 });
      prevSignificant = quote;
      i = end;
      continue;
    }

    // ---- template literals -------------------------------------------
    if (c === "`") {
      const chunkStart = i + 1;
      let j = i + 1;
      let body = "";
      let bodyStart = chunkStart;
      masked[i] = "`";
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          body += src[j + 1] ?? "";
          masked[j] = " ";
          masked[j + 1] = " ";
          j += 2;
          continue;
        }
        if (d === "`") {
          masked[j] = "`";
          j += 1;
          break;
        }
        if (d === "$" && src[j + 1] === "{") {
          if (body.trim()) strings.push({ text: body, index: bodyStart });
          body = "";
          // Hand the `${ … }` hole back to the main loop by scanning it
          // recursively: find its matching `}` with a nested scan.
          const holeStart = j;
          let depth = 0;
          let k = j + 1;
          for (; k < src.length; k += 1) {
            const e = src[k];
            if (e === "{") depth += 1;
            else if (e === "}") {
              depth -= 1;
              if (depth === 0) {
                k += 1;
                break;
              }
            } else if (e === "'" || e === '"' || e === "`") {
              // Re-scan the hole's own content so nested strings are captured.
              break;
            }
          }
          const holeSrc = src.slice(holeStart + 2, Math.max(k - 1, holeStart + 2));
          const inner = scan(holeSrc);
          for (const s of inner.strings) {
            strings.push({ text: s.text, index: holeStart + 2 + s.index });
          }
          for (let m = holeStart; m < k; m += 1) {
            masked[m] = src[m] === "\n" ? "\n" : " ";
          }
          j = k;
          bodyStart = j;
          continue;
        }
        masked[j] = d === "\n" ? "\n" : " ";
        body += d;
        j += 1;
      }
      if (body.trim()) strings.push({ text: body, index: bodyStart });
      prevSignificant = "`";
      i = j;
      continue;
    }

    // ---- ordinary code ------------------------------------------------
    masked[i] = c;
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }

  for (let k = 0; k < masked.length; k += 1) {
    if (masked[k] === null) masked[k] = src[k] === "\n" ? "\n" : " ";
  }
  return { masked: masked.join(""), strings };
}

/** Element text nodes: the prose between a tag close and the next closing tag. */
// Requiring the run to end at a closing tag is what keeps comparisons and generics out; brace expressions are deleted first, their strings having already been captured.
function jsxTextNodes(masked) {
  const out = [];
  const re = />([^<>]*)<\//g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const raw = m[1];
    const start = m.index + 1;
    // Drop `{ … }` expression holes, preserving offsets with spaces.
    let cleaned = "";
    let depth = 0;
    for (const ch of raw) {
      if (ch === "{") depth += 1;
      if (depth > 0) cleaned += ch === "\n" ? "\n" : " ";
      else cleaned += ch;
      if (ch === "}") depth = Math.max(0, depth - 1);
    }
    if (!/[A-Za-z]{2}/.test(cleaned)) continue;
    out.push({ text: cleaned, index: start });
  }
  return out;
}

/** Token-shaped strings are never prose: they carry a separator or a slash and no whitespace. A bare capitalised word is not skipped, because that shape can be a user-facing label. */
function isTokenNotProse(text) {
  if (/\s/.test(text)) return false;
  return /^[A-Za-z0-9_$]*[-./:@][A-Za-z0-9_$\-./:@]*$/.test(text);
}

/** Argument spans of logging calls, which reach the log and never a screen. */
// Suppressed by span, not by filename, so a user-facing string beside a log call is still scanned.
function logCallSpans(masked) {
  const spans = [];
  const re =
    /(?:^|[^\w.$])(?:debugLog|appendErrorLog|appendDebugLog|console\s*\.\s*(?:log|warn|error|info|debug|trace))\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let k = open;
    for (; k < masked.length; k += 1) {
      if (masked[k] === "(") depth += 1;
      else if (masked[k] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([open, k]);
  }
  return spans;
}

/**
 * The body of `src/lib/files.ts`'s `fileIcon`, exempt from the emoji rule.
 *
 * `fileIcon` is a deprecated glyph helper — its own header says *"Prefer
 * `fileIconName` (Ionicons) for new rendering"* — and its six returns are the
 * only emoji literals left under `src`, `app` or `backend` outside test files.
 * Retiring it app-wide is deferred to `PUBLISHIT.md` Appendix D, so the rule
 * carves out the one function rather than the whole file: a new emoji string
 * anywhere else in `files.ts` is still reported.
 *
 * NOTE what this rule does and does not buy. It cannot catch a component that
 * RENDERS an emoji by calling a helper — `SharePreviewModal` held no emoji
 * literal, it called `fileIcon(name)` — so this guards against new emoji copy,
 * not against new call sites of the helper. Those need the helper deleted.
 *
 * Span-based, like `logCallSpans`, and computed over the masked source so a
 * brace inside a string cannot throw the match off.
 */
function emojiExemptSpans(rel, masked) {
  if (rel.split("\\").join("/") !== "src/lib/files.ts") return [];
  const sig = /export function fileIcon\s*\([^)]*\)\s*:\s*string\s*\{/g;
  const spans = [];
  let m;
  while ((m = sig.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let k = open;
    for (; k < masked.length; k += 1) {
      if (masked[k] === "{") depth += 1;
      else if (masked[k] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([open, k]);
  }
  // A carve-out that silently matches nothing is how an exemption outlives the
  // thing it exempted. If `fileIcon` is deleted or renamed, say so loudly.
  if (spans.length !== 1) {
    console.error(
      `check-copy: the fileIcon emoji carve-out matched ${spans.length} spans ` +
        `in ${rel}, expected 1. If fileIcon was retired, delete emojiExemptSpans.`,
    );
    process.exit(2);
  }
  return spans;
}

function inAnySpan(spans, index) {
  return spans.some(([a, b]) => index > a && index < b);
}

function lineOf(src, index) {
  let line = 1;
  for (let k = 0; k < index && k < src.length; k += 1) {
    if (src[k] === "\n") line += 1;
  }
  return line;
}

/** Every banned-copy hit in one file's source text. */
function violationsIn(rel, src) {
  const { masked, strings } = scan(src);
  const logSpans = logCallSpans(masked);
  const emojiExempt = emojiExemptSpans(rel, masked);
  const candidates = [
    ...strings.map((s) => ({ ...s, kind: "string" })),
    ...jsxTextNodes(masked).map((s) => ({ ...s, kind: "jsx-text" })),
  ];
  const hits = [];
  for (const cand of candidates) {
    const text = cand.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (cand.kind === "string" && isTokenNotProse(cand.text)) continue;
    if (cand.kind === "string" && inAnySpan(logSpans, cand.index)) continue;
    // Padding restores the word boundaries `[^a-z]network[^a-z]` loses at the
    // start and end of the subject.
    const padded = ` ${text} `;
    if (cand.kind === "string" && NON_PROSE_TOKENS.has(text)) continue;
    const rule = BANNED.test(padded) && !OFFLINE_CLAIM_ALLOWED.has(text)
      ? "banned-claim"
      : RAW_ENGINE_TEXT.test(padded)
        ? "raw-engine-text"
        : EMOJI.test(text) && !inAnySpan(emojiExempt, cand.index)
          ? "emoji"
          : cand.kind === "string" && text.length > MAX_PROSE_LENGTH
            ? "too-long"
            : null;
    if (!rule) continue;
    hits.push({
      file: rel,
      line: lineOf(src, cand.index),
      kind: cand.kind,
      rule,
      text: text.length > 140 ? `${text.slice(0, 137)}…` : text,
    });
  }
  return hits;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// --selftest
// ---------------------------------------------------------------------------

/** Verbatim, as they shipped. If the pattern stops matching these, it is broken. */
const KNOWN_OFFENDERS = [
  "The other side seems to be offline. The download might not work.",
  "PearDrop needs a network to find peers. Check your Wi-Fi or mobile data.",
  "The sender may be offline or the link has expired. Ask them to share a new link.",
  "Still looking… the other pear might be offline or on a slow network.",
  "Drive not found",
];

/** Must stay clean. The replacement copy, and the empty states around it. */
const KNOWN_CLEAN = [
  "Still looking for the sender — this can take a moment. Their phone needs to be awake with PearDrop open.",
  "Couldn't load your shares — close and reopen PearDrop.",
  "Nothing here yet",
  "Pick files above or paste a link.",
  "No favorites yet",
  "Tap the heart on a share to add it.",
];

// The planted too-long positive control: over the cap, under the display truncation, and free of banned words so only the length rule can catch it.
const TOO_LONG_CONTROL =
  "This sentence is the planted too-long positive control for the length cap and it rambles on well past the hundred and twenty mark.";

/** Emoji positive control, carrying none of the banned words, so a report of it can only have come from the emoji rule. */
const EMOJI_CONTROL = "Sending your files \u{1F680}";

const FIXTURE = [
  "// A comment naming offline, expired and 'Drive not found' — must be ignored.",
  "/* Block comment: check your Wi-Fi. Also ignored. */",
  'const icon = "cloud-offline-outline";',
  'const bad = "The peer is offline.";',
  `const cap = "${TOO_LONG_CONTROL}";`,
  "const tpl = `The link has expired after ${n} days`;",
  // Emoji positive control, plus the typography that must not be flagged: em-dash, middot and ellipsis are deliberate house style.
  `const emoji = "${EMOJI_CONTROL}";`,
  'const typography = "Saved 3 of 4 — one didn\'t make it · hold on…";',
  "const re = /offline|expired/;",
  'debugLog("warn", "rn.x", "peer went offline (diagnostic, not a screen)");',
  'const stillScanned = "Your link has expired.";',
  "export function View() {",
  "  return (",
  "    <Text style={styles.x}>",
  "      The other side seems to be offline. The download might not work.",
  "    </Text>",
  "  );",
  "}",
  "const cmp = a > b && c < d;",
].join("\n");

function selftest() {
  const failures = [];
  const ok = [];

  for (const s of KNOWN_OFFENDERS) {
    const padded = ` ${s} `;
    const matched = BANNED.test(padded) || RAW_ENGINE_TEXT.test(padded);
    (matched ? ok : failures).push(
      `${matched ? "matches" : "MISSED"}  offender: ${s}`,
    );
  }
  for (const s of KNOWN_CLEAN) {
    const padded = ` ${s} `;
    const matched = BANNED.test(padded) || RAW_ENGINE_TEXT.test(padded);
    (matched ? failures : ok).push(
      `${matched ? "FALSE POSITIVE" : "clean  "}  clean: ${s}`,
    );
  }

  /** The two narrowings, each with its own control, because a narrowed guard that nothing probes quietly becomes a loophole. */
  // Both assert the same thing in two directions: the exact strings pass, and everything adjacent to them still fails.
  for (const s of OFFLINE_CLAIM_ALLOWED) {
    const hits = violationsIn("<allow>", `const x = ${JSON.stringify(s)};`);
    const banned = hits.some((h) => h.rule === "banned-claim");
    (banned ? failures : ok).push(
      `${banned ? "ALLOW-LIST BROKEN" : "allowed"}  allowed offline claim: ${s}`,
    );
  }
  // Refused through the allow-list rather than the regex: a variation on an allowed string is still refused.
  for (const s of [
    ...KNOWN_OFFENDERS.filter((o) => /offline/i.test(o)),
    "Sender offline. Files appear when they are back.",
    "The sender is offline.",
  ]) {
    const hits = violationsIn("<allow>", `const x = ${JSON.stringify(s)};`);
    const banned = hits.some((h) => h.rule === "banned-claim");
    (banned ? ok : failures).push(
      `${banned ? "still refused" : "ALLOW-LIST TOO WIDE"}  near-miss: ${s}`,
    );
  }
  // The status token passes; a sentence with the same word does not.
  for (const [text, shouldPass] of [
    ['"expired"', true],
    ['"Your share has expired."', false],
    ['"expired share"', false],
    ['"senderOffline"', true],
    // A near-miss identifier is not admitted, because the set is exact strings.
    ['"senderOfflineNow"', false],
    ['"The sender is senderOffline."', false],
  ]) {
    const hits = violationsIn("<token>", `const x = ${text};`);
    const banned = hits.some((h) => h.rule === "banned-claim");
    const good = shouldPass ? !banned : banned;
    (good ? ok : failures).push(
      `${good ? "token rule ok" : "TOKEN RULE WRONG"}  ${text} -> banned=${banned}`,
    );
  }

  // Extractor control: the fixture holds one string-literal, one template-literal and one element-text offender, plus two comments and a token carrying the same words that must not be found.
  const found = violationsIn("<fixture>", FIXTURE);
  const kinds = found.map((h) => `${h.kind}:${h.text}`).sort();
  const expected = [
    `string:${EMOJI_CONTROL}`,
    "jsx-text:The other side seems to be offline. The download might not work.",
    "string:The link has expired after",
    "string:The peer is offline.",
    `string:${TOO_LONG_CONTROL}`,
    "string:Your link has expired.",
  ].sort();
  if (JSON.stringify(kinds) === JSON.stringify(expected)) {
    ok.push(
      "extractor: found exactly the 6 planted offenders (string, template, " +
        "JSX text, one sitting right after a debugLog call, the too-long " +
        "control and the emoji control) and skipped the 2 comments, the " +
        "Ionicons token, the regex literal, the debugLog argument and the " +
        "em-dash/middot/ellipsis typography line",
    );
  } else {
    failures.push(
      `extractor: expected\n    ${expected.join("\n    ")}\n  got\n    ${kinds.join("\n    ") || "(nothing)"}`,
    );
  }

  // The planted long string must fail, and specifically under the length rule: caught by a banned-word match instead, the length rule would be untested.
  const tooLongHits = found.filter((h) => h.rule === "too-long");
  if (
    tooLongHits.length === 1 &&
    tooLongHits[0].text === TOO_LONG_CONTROL &&
    TOO_LONG_CONTROL.length > MAX_PROSE_LENGTH
  ) {
    ok.push(
      `too-long: the ${TOO_LONG_CONTROL.length}-char planted control fails under rule "too-long" (cap ${MAX_PROSE_LENGTH})`,
    );
  } else {
    failures.push(
      `too-long: expected exactly 1 "too-long" hit matching the planted ${TOO_LONG_CONTROL.length}-char control, got ${JSON.stringify(tooLongHits)}`,
    );
  }

  // The planted rocket must fail under the emoji rule specifically, or that rule is untested.
  const emojiHits = found.filter((h) => h.rule === "emoji");
  if (emojiHits.length === 1 && emojiHits[0].text === EMOJI_CONTROL) {
    ok.push(
      'emoji: the planted control fails under rule "emoji", and the ' +
        "em-dash / middot / ellipsis line is NOT flagged",
    );
  } else {
    failures.push(
      `emoji: expected exactly 1 "emoji" hit matching the planted control, got ${JSON.stringify(emojiHits)}`,
    );
  }

  for (const line of ok) console.log(`  ok    ${line}`);
  for (const line of failures) console.log(`  FAIL  ${line}`);
  console.log(
    `\nselftest: ${ok.length} ok, ${failures.length} failed ` +
      `(${KNOWN_OFFENDERS.length} offenders, ${KNOWN_CLEAN.length} clean strings, ` +
      `1 extractor control, 1 too-long control, 1 emoji control)`,
  );
  return failures.length === 0 ? 0 : 2;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    process.exit(selftest());
  }
  if (args.length > 0) {
    console.error(`check-copy: unknown argument(s): ${args.join(" ")}`);
    console.error("usage: node scripts/check-copy.mjs [--selftest]");
    process.exit(2);
  }

  // The selftest runs on every scan. A scan that reports a clean tree while
  // its own pattern has stopped matching is the exact failure this guards.
  const selftestCode = selftest();
  console.log("");
  if (selftestCode !== 0) {
    console.error("check-copy: selftest failed — the scan below cannot be trusted.");
    process.exit(2);
  }

  const violations = [];
  let scanned = 0;
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    // A root may be a single file; `walk` yields nothing for one, which would look exactly like scanned-and-clean.
    const roots = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const file of roots) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (EXCLUDED_FILES.has(rel)) continue;
      if (isTestFile(rel)) continue;
      scanned += 1;
      violations.push(...violationsIn(rel, fs.readFileSync(file, "utf8")));
    }
  }

  console.log("check-copy: excluded files (each with its reason)");
  for (const e of EXCLUSIONS) {
    console.log(`  - ${e.file}\n      ${e.reason}`);
  }
  console.log(`\ncheck-copy: scanned ${scanned} file(s) under ${SCAN_ROOTS.join(", ")}`);

  if (violations.length === 0) {
    console.log("check-copy: clean.");
    process.exit(0);
  }

  console.error(`\ncheck-copy: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule} / ${v.kind}]`);
    console.error(`    ${v.text}`);
  }
  console.error(
    "\nPearDrop has no connectivity detection and links never expire, so copy" +
      "\nmay not claim either. 'Drive not found' is raw engine text (ADD-2)." +
      `\nProse over ${MAX_PROSE_LENGTH} chars truncates with "…" on screen (I-7).`,
  );
  process.exit(1);
}

main();
