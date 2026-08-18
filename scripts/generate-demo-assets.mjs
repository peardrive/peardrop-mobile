// One-shot generator for the bundled demo assets. Produces valid-but-tiny
// files for every preview path (image, text, markdown, audio, video, PDF).
// Run with: `node scripts/generate-demo-assets.mjs`. Idempotent.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(here, "..", "assets", "demo");

await mkdir(DEMO_DIR, { recursive: true });

const fromHex = (hex) => Buffer.from(hex.replace(/\s+/g, ""), "hex");

// ─── welcome.txt ────────────────────────────────────────────────────────
await writeFile(
  path.join(DEMO_DIR, "welcome.txt"),
  [
    "Hey! This is a sample text file from your PearDrop demo.",
    "You can preview text files right inside the app — tap Preview.",
    "",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do",
    "eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim",
    "ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut",
    "aliquip ex ea commodo consequat.",
    "",
    "Swap this out for anything you like — PearDrop doesn't care what's",
    "inside, it just moves the bytes.",
    "",
  ].join("\n"),
  "utf8"
);

// ─── notes.md ───────────────────────────────────────────────────────────
await writeFile(
  path.join(DEMO_DIR, "notes.md"),
  [
    "# PearDrop notes",
    "",
    "A tiny markdown sample shipped with the demo. In-app preview treats",
    "markdown as plain text today — no rendering yet.",
    "",
    "## Things to try",
    "",
    "- Preview an image (sunset.jpg)",
    "- Preview a text file (this one)",
    "- Preview audio (clip.mp3)",
    "- Preview video (intro.mp4)",
    "- Open a PDF externally (sample.pdf)",
    "",
    "## Heading three",
    "",
    "> A blockquote, just because.",
    "",
    "Code block:",
    "",
    "```",
    "peardrop://<64-hex>",
    "```",
    "",
  ].join("\n"),
  "utf8"
);

// ─── sunset.jpg ─────────────────────────────────────────────────────────
// Minimal valid 1x1 JPEG encoding a single dark-orange pixel (hand-crafted
// baseline JPEG; ~125 bytes). Produces a solid color block in-preview —
// close enough to a "sunset" for a placeholder.
await writeFile(
  path.join(DEMO_DIR, "sunset.jpg"),
  fromHex(
    "FFD8FFE000104A46494600010100000100010000" +
      "FFDB004300080606070605080707070909080A0C140D0C0B0B0C1912130F141D1A1F1E1D1A1C1C20242E2720222C231C1C2837292C30313434341F27393D38323C2E333432" +
      "FFDB0043010909090C0B0C180D0D1832211C213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232" +
      "FFC000110800010001030122000211010311010011" +
      "FFC4001F0000010501010101010100000000000000000102030405060708090A0B" +
      "FFC400B5100002010303020403050504040000017D01020300041105122131410613516107227114328191A1082342B1C11552D1F02433627282090A161718191A25262728292A3435363738393A434445464748494A535455565758595A636465666768696A737475767778797A838485868788898A92939495969798999AA2A3A4A5A6A7A8A9AAB2B3B4B5B6B7B8B9BAC2C3C4C5C6C7C8C9CAD2D3D4D5D6D7D8D9DAE1E2E3E4E5E6E7E8E9EAF1F2F3F4F5F6F7F8F9FA" +
      "FFC4001F0100030101010101010101010000000000000102030405060708090A0B" +
      "FFC400B51100020102040403040705040400010277000102031104052131061241510761711322328108144291A1B1C109233352F0156272D10A162434E125F11718191A262728292A35363738393A434445464748494A535455565758595A636465666768696A737475767778797A82838485868788898A92939495969798999AA2A3A4A5A6A7A8A9AAB2B3B4B5B6B7B8B9BAC2C3C4C5C6C7C8C9CAD2D3D4D5D6D7D8D9DAE2E3E4E5E6E7E8E9EAF2F3F4F5F6F7F8F9FA" +
      "FFDA000C03010002110311003F00FB23FFD9"
  )
);

// ─── clip.mp3 ───────────────────────────────────────────────────────────
// 1 s of silence at 44.1 kHz stereo, encoded as a single MPEG-1 Layer III
// frame of silence repeated 38 times (~1 s). Minimal but decodable. If the
// in-app audio player chokes, the "Open in another app" fallback still
// works since the file is a valid MP3 container.
{
  const id3 = fromHex("494433040000000000"); // ID3v2.4 tag, empty
  id3.writeUInt32BE(0, 5); // size = 0 (syncsafe zero)
  // Minimal silent MPEG-1 Layer III frame, 32 kbps / 44.1 kHz / stereo,
  // 104 bytes total including the 4-byte header. Just 0x00 after header.
  const frameHeader = fromHex("FFFB3064");
  const framePayload = Buffer.alloc(100, 0);
  const frame = Buffer.concat([frameHeader, framePayload]);
  const frameCount = 38; // ~1 s
  const frames = Buffer.concat(Array(frameCount).fill(frame));
  await writeFile(path.join(DEMO_DIR, "clip.mp3"), Buffer.concat([id3, frames]));
}

// ─── intro.mp4 ──────────────────────────────────────────────────────────
// Hand-crafted "empty" ISO BMFF / MP4 container: ftyp box + minimal moov
// with a zero-duration track + empty mdat. Valid enough to identify as a
// video file but too small to show frames. In-app `<VideoView>` may render
// black; the "Open in another app" button is the real path.
{
  const box = (type, payload) => {
    const size = 8 + payload.length;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(size, 0);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, payload]);
  };

  const ftyp = box(
    "ftyp",
    Buffer.concat([
      Buffer.from("isom", "ascii"),
      fromHex("00000200"),
      Buffer.from("isomiso2avc1mp41", "ascii"),
    ])
  );

  const mvhd = box(
    "mvhd",
    fromHex(
      "00000000" + // version/flags
        "00000000" + // creation_time
        "00000000" + // modification_time
        "00000001" + // timescale
        "00000001" + // duration
        "00010000" + // rate 1.0
        "0100" + // volume
        "0000" + // reserved
        "00000000" + "00000000" + // reserved[2]
        "00010000 00000000 00000000" + // matrix
        "00000000 00010000 00000000" +
        "00000000 00000000 40000000" +
        "00000000 00000000 00000000 00000000 00000000 00000000" + // pre_defined[6]
        "00000002" // next_track_ID
    )
  );

  const moov = box("moov", mvhd);
  const mdat = box("mdat", Buffer.alloc(0));
  await writeFile(
    path.join(DEMO_DIR, "intro.mp4"),
    Buffer.concat([ftyp, moov, mdat])
  );
}

// ─── sample.pdf ─────────────────────────────────────────────────────────
// Minimal valid single-page PDF, ~620 bytes. Shows "PearDrop demo" when
// rendered. The app today has no in-app PDF viewer, so this opens via
// the system PDF reader through "Open in another app".
{
  const pdfBody =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 60>>stream\nBT /F1 24 Tf 40 50 Td (PearDrop demo) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000109 00000 n \n0000000212 00000 n \n0000000305 00000 n \n" +
    "trailer<</Size 6/Root 1 0 R>>\nstartxref\n366\n%%EOF\n";
  await writeFile(path.join(DEMO_DIR, "sample.pdf"), pdfBody, "binary");
}

console.log("Demo assets written to", DEMO_DIR);
