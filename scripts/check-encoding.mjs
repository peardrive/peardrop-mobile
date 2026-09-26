#!/usr/bin/env node
/**
 * Fail the build on source that is not clean text: a stray NUL byte compiles
 * and passes tests while ripgrep silently skips the file, putting a hole in
 * every search sweep. Rejects invalid UTF-8, caught by a decode-then-encode
 * round trip rather than by hunting U+FFFD, which is a legitimate character;
 * C0 control bytes other than TAB, LF and CR; and a UTF-8 BOM. Exit 2 if a
 * root does not exist, since a silently empty scan always passes.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Scanned when no roots are given on the command line. */
const DEFAULT_ROOTS = ['src', 'backend'];

/** Extensions treated as source text. Anything else is skipped. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.kt',
  '.java',
  '.gradle',
  '.xml',
  '.yml',
  '.yaml',
]);

/** Never descended into. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  '.expo',
  '.gradle',
  'graphify-out',
]);

/** TAB, LF, CR are the three C0 bytes that legitimately appear in source. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

/**
 * Byte offset → 1-based line and column, counting LF. Only called on a file
 * that already has a violation, so the O(n) rescan is not on the hot path.
 */
function locate(buf, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (buf[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function describeControl(byte) {
  if (byte === 0x00) return 'NUL (this is the D-48 byte: rg skips the file silently on a directory traversal)';
  const names = {
    0x07: 'BEL',
    0x08: 'BS',
    0x0b: 'VT',
    0x0c: 'FF',
    0x1a: 'SUB',
    0x1b: 'ESC',
    0x1f: 'US',
  };
  const name = names[byte] ? ` (${names[byte]})` : '';
  return `control byte 0x${byte.toString(16).padStart(2, '0')}${name} — write it as an escape sequence instead`;
}

/** @returns {Array<{offset:number, line:number, column:number, reason:string}>} */
function checkFile(file) {
  const buf = fs.readFileSync(file);
  const problems = [];

  // Rule 3 — BOM. Reported first because it is at offset 0.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push({ offset: 0, line: 1, column: 1, reason: 'UTF-8 BOM' });
  }

  // Rule 2 — C0 control bytes. Byte-level, so it is unaffected by whatever
  // the decode in rule 1 makes of the rest of the file.
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x20 && !ALLOWED_CONTROL.has(b)) {
      const { line, column } = locate(buf, i);
      problems.push({ offset: i, line, column, reason: describeControl(b) });
    }
  }

  // Rule 1 — UTF-8 validity, by round-trip rather than by U+FFFD hunting.
  const decoded = buf.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buf)) {
    const reencoded = Buffer.from(decoded, 'utf8');
    let offset = 0;
    while (offset < buf.length && offset < reencoded.length && buf[offset] === reencoded[offset]) {
      offset++;
    }
    const { line, column } = locate(buf, offset);
    problems.push({
      offset,
      line,
      column,
      reason: 'invalid UTF-8 (byte sequence does not survive a decode/encode round trip)',
    });
  }

  return problems;
}

function* walk(root) {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    yield root;
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function main() {
  const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS;

  const missing = roots.filter((r) => !fs.existsSync(r));
  if (missing.length > 0) {
    // Not a soft warning. A check that scans nothing and exits 0 is worse
    // than no check, because it reports success forever.
    console.error(`check-encoding: root does not exist: ${missing.join(', ')}`);
    console.error(`check-encoding: cwd is ${process.cwd()}`);
    process.exit(2);
  }

  let scanned = 0;
  let failedFiles = 0;
  let violations = 0;

  for (const root of roots) {
    for (const file of walk(root)) {
      // An explicit file argument is always checked; a discovered file must
      // look like source.
      const explicit = roots.includes(file);
      if (!explicit && !TEXT_EXTENSIONS.has(path.extname(file))) continue;
      scanned++;
      const problems = checkFile(file);
      if (problems.length === 0) continue;
      failedFiles++;
      violations += problems.length;
      const shown = problems.slice(0, 5);
      for (const p of shown) {
        console.error(
          `${file.split(path.sep).join('/')}:${p.line}:${p.column}: byte offset ${p.offset}: ${p.reason}`,
        );
      }
      if (problems.length > shown.length) {
        console.error(`  … and ${problems.length - shown.length} more in this file`);
      }
    }
  }

  if (scanned === 0) {
    console.error(`check-encoding: scanned 0 files under ${roots.join(', ')} — refusing to report success`);
    process.exit(2);
  }

  if (violations > 0) {
    console.error('');
    console.error(
      `check-encoding: FAIL — ${violations} violation(s) in ${failedFiles} file(s) of ${scanned} scanned`,
    );
    process.exit(1);
  }

  console.log(`check-encoding: OK — ${scanned} files scanned under ${roots.join(', ')}, no violations`);
}

main();
