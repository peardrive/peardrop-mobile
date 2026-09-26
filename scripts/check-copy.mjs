#!/usr/bin/env node
/**
 * Fail the build on user-facing copy asserting what this app cannot know:
 * there is no connectivity detection, a share link never expires, and the
 * literal `Drive not found` is raw engine text no user may see. A text search
 * is useless here since most hits are comments about the ban, so this reads
 * only string literals and JSX text nodes. Comments are blanked and test files
 * skipped, so `--selftest` proves on every scan that neither filter hides a hit.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * `backend/` has to be here: the only producer of `Drive not found` is
 * `backend/hyperdrive-engine.mjs`, so a guard that cannot see it reports a clean
 * tree over a real offender. `rpc-commands.mjs` is imported by both realms and
 * sits at the repo root, where neither `src` nor `backend` reaches it. Engine
 * strings are not all user-facing — most are `debugLog` arguments, which the
 * `logCallSpans` suppression below handles.
 */
const SCAN_ROOTS = ["src", "app", "backend", "rpc-commands.mjs"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * `[^a-z]network[^a-z]` is a deliberate hand-rolled word boundary: it must not
 * fire on `networkPolicy` or `sceneNetwork`. The subject text is padded with a
 * space on each side before testing (see `violationsIn`), which restores the
 * boundaries the regex would otherwise lose at start/end of the text.
 */
const BANNED = /offline|no internet|check your|slow network|[^a-z]network[^a-z]|expired?/i;

/** "No path may ever show 'Drive not found' to a user again." */
const RAW_ENGINE_TEXT = /drive not found/i;

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

/**
 * An exclusion must rest on the file not being built, not on nobody currently
 * calling it. A registered route is compiled in, so one `navigate` call
 * anywhere ships its copy with no further change and no warning.
 */

const EXCLUDED_FILES = new Set(EXCLUSIONS.map((e) => e.file));

/** Test files assert *about* banned copy, so they quote it by necessity. */
function isTestFile(rel) {
  return (
    rel.includes("__tests__") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

/**
 * Walk `src` once, returning `masked` — the same length as `src`, with every
 * comment and string body replaced by spaces so offsets and line numbers
 * survive — and `strings`, one `{ text, index }` per string literal body and
 * per literal chunk of a template literal. Regex literals are recognised with
 * the previous-significant-token heuristic so that a quote inside `/["']/`
 * cannot desynchronise the scan.
 */
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

/**
 * JSX text nodes: the prose between a `>` and the next `</`. Requiring the run
 * to end at a closing tag is what keeps `a > b && c < d` and TypeScript
 * generics out. Any `{ … }` expression inside the run is deleted first — its
 * own strings were already captured by `scan`.
 */
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

/**
 * Token-shaped strings are never prose: Ionicons names (`cloud-offline-outline`),
 * enum values, style keys, import paths. They have no whitespace and carry a
 * separator or a slash. A bare word with no separator is not skipped, because
 * that shape can be a user-facing label.
 */
function isTokenNotProse(text) {
  if (/\s/.test(text)) return false;
  return /^[A-Za-z0-9_$]*[-./:@][A-Za-z0-9_$\-./:@]*$/.test(text);
}

/**
 * Argument spans of diagnostic-logging calls. `debugLog`, `appendErrorLog` and
 * `console.*` text goes to logcat and to the exported `peardrop-debug.log`,
 * never to a screen, so the ban does not reach it. Suppression is by span, not
 * by filename — a user-facing string sitting next to a log call is still
 * scanned. Computed over the masked source, where string bodies are already
 * blanked, so a `(` or `)` inside a string cannot throw the paren match off.
 */
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
    const rule = BANNED.test(padded)
      ? "banned-claim"
      : RAW_ENGINE_TEXT.test(padded)
        ? "raw-engine-text"
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

const FIXTURE = [
  "// A comment naming offline, expired and 'Drive not found' — must be ignored.",
  "/* Block comment: check your Wi-Fi. Also ignored. */",
  'const icon = "cloud-offline-outline";',
  'const bad = "The peer is offline.";',
  "const tpl = `The link has expired after ${n} days`;",
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

  // Extractor control: the fixture holds one string-literal, one
  // template-literal and one JSX-text offender, plus two comments and an
  // Ionicons token carrying the same words that must not be found.
  const found = violationsIn("<fixture>", FIXTURE);
  const kinds = found.map((h) => `${h.kind}:${h.text}`).sort();
  const expected = [
    "jsx-text:The other side seems to be offline. The download might not work.",
    "string:The link has expired after",
    "string:The peer is offline.",
    "string:Your link has expired.",
  ];
  if (JSON.stringify(kinds) === JSON.stringify(expected)) {
    ok.push(
      "extractor: found exactly the 4 planted offenders (string, template, " +
        "JSX text, and one sitting right after a debugLog call) and skipped " +
        "the 2 comments, the Ionicons token, the regex literal and the " +
        "debugLog argument",
    );
  } else {
    failures.push(
      `extractor: expected\n    ${expected.join("\n    ")}\n  got\n    ${kinds.join("\n    ") || "(nothing)"}`,
    );
  }

  for (const line of ok) console.log(`  ok    ${line}`);
  for (const line of failures) console.log(`  FAIL  ${line}`);
  console.log(
    `\nselftest: ${ok.length} ok, ${failures.length} failed ` +
      `(${KNOWN_OFFENDERS.length} offenders, ${KNOWN_CLEAN.length} clean strings, 1 extractor control)`,
  );
  return failures.length === 0 ? 0 : 2;
}

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
    // A root may be a single file (`rpc-commands.mjs`), and `walk` expects a
    // directory: it would yield nothing, which looks exactly like clean.
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
      "\nmay not claim either. 'Drive not found' is raw engine text (ADD-2).",
  );
  process.exit(1);
}

main();
