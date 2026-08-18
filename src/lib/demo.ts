import { Asset } from "expo-asset";
import RNFS from "react-native-fs";
import type { DownloadResult, OpenLinkResult } from "../state/types";

/**
 * Offline "demo" share that exercises every preview path without needing
 * a second phone or network. The link `peardrop://demo` bypasses the
 * backend entirely: `ShareLinkFlowContext` intercepts it, returns a fake
 * `OpenLinkResult` here, and on "Grab everything" calls
 * `materializeDemoFiles()` to copy the bundled assets into Documents and
 * append them to the downloaded-files index.
 *
 * The demo driveId is a fixed string so the Receive tab's transfer card
 * can identify it (and for mild Easter-egg value). All sizes match the
 * bundled asset bytes exactly so progress percentages feel real.
 */

export const DEMO_LINK = "peardrop://demo";
export const DEMO_DRIVE_ID = "drive_demo_local";

type DemoFile = {
  /** Entry key (matches `OpenLinkResult.files[].name`). */
  name: string;
  /** Nicer display name for the preview modal. */
  displayName: string;
  size: number;
  /**
   * `require()` of the bundled asset. Using `require` (not `import`) lets
   * Metro pull each file into the APK as a bundled asset; the runtime
   * `Asset` helper then resolves a readable path on device.
   */
  module: number;
};

// Sizes in bytes — hard-coded so `OpenLinkResult.totalBytes` is correct
// before we've actually copied anything. Must match the real bytes at
// `assets/demo/*`. If you regenerate the assets, update these too.
const DEMO_FILES: DemoFile[] = [
  {
    name: "/sunset.jpg",
    displayName: "sunset.jpg",
    size: 629,
    module: require("../../assets/demo/sunset.jpg"),
  },
  {
    name: "/welcome.txt",
    displayName: "welcome.txt",
    size: 458,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    module: require("../../assets/demo/welcome.txt"),
  },
  {
    name: "/notes.md",
    displayName: "notes.md",
    size: 404,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    module: require("../../assets/demo/notes.md"),
  },
  {
    name: "/clip.mp3",
    displayName: "clip.mp3",
    size: 3961,
    module: require("../../assets/demo/clip.mp3"),
  },
  {
    name: "/intro.mp4",
    displayName: "intro.mp4",
    size: 156,
    module: require("../../assets/demo/intro.mp4"),
  },
  {
    name: "/sample.pdf",
    displayName: "sample.pdf",
    size: 540,
    module: require("../../assets/demo/sample.pdf"),
  },
];

const totalBytes = DEMO_FILES.reduce((sum, f) => sum + f.size, 0);

export function isDemoLink(link: string): boolean {
  return String(link || "").trim().toLowerCase() === DEMO_LINK;
}

export function getDemoOpenResult(): OpenLinkResult {
  return {
    ok: true,
    driveId: DEMO_DRIVE_ID,
    files: DEMO_FILES.map((f) => ({
      name: f.name,
      displayName: f.displayName,
      size: f.size,
    })),
    shareName: "PearDrop demo",
    totalBytes,
    hasManifest: true,
  };
}

/**
 * Copies the bundled demo assets into the Documents directory and returns
 * a `DownloadResult` shaped exactly like what the real `startDownload`
 * would produce. Caller is responsible for threading this through
 * `appendDownloadResults` + stats accounting so the demo behaves end-to-end.
 *
 * If `fileNames` is provided, only those entries are materialized. The
 * names must match `OpenLinkResult.files[].name` (leading slash).
 */
export async function materializeDemoFiles(
  fileNames?: string[]
): Promise<DownloadResult> {
  const wanted = fileNames && fileNames.length ? new Set(fileNames) : null;
  const selected = wanted
    ? DEMO_FILES.filter((f) => wanted.has(f.name))
    : DEMO_FILES;
  if (!selected.length) {
    return { ok: false, error: "Nothing selected." };
  }

  const destDir = `${RNFS.DocumentDirectoryPath}/peardrop-demo`;
  await RNFS.mkdir(destDir);

  const start = Date.now();
  const files: { name: string; path: string; size: number }[] = [];
  const failed: { key: string; error: string }[] = [];
  let bytesDownloaded = 0;

  for (const f of selected) {
    try {
      // Resolve the bundled asset to a readable URI, then copy bytes into
      // Documents so the file survives past the expo-asset cache lifetime
      // and shows up in the received-files list like a real download.
      const asset = Asset.fromModule(f.module);
      await asset.downloadAsync();
      const src = asset.localUri ?? asset.uri;
      if (!src) {
        failed.push({ key: f.name, error: "Asset has no local URI" });
        continue;
      }
      const srcPath = src.startsWith("file://") ? src.slice("file://".length) : src;
      const destPath = `${destDir}/${f.displayName}`;
      // RNFS.copyFile refuses to overwrite, so best-effort unlink first.
      try {
        await RNFS.unlink(destPath);
      } catch {
        // fine — the file probably didn't exist
      }
      await RNFS.copyFile(srcPath, destPath);
      files.push({ name: f.displayName, path: destPath, size: f.size });
      bytesDownloaded += f.size;
    } catch (err) {
      failed.push({ key: f.name, error: String((err as Error)?.message || err) });
    }
  }

  return {
    ok: true,
    files,
    failed,
    totalBytes: bytesDownloaded,
    duration: Date.now() - start,
    destDir,
  };
}

/**
 * Wipe the received-files index + the demo-generated files on disk. Used
 * by the Settings → Demo & testing → "Clear everything I've grabbed"
 * affordance. This is intentionally aggressive — it clears all downloads,
 * not just the demo ones, because the RN side can't easily tell which
 * files came from the demo vs a real share.
 */
export async function clearAllDownloads(): Promise<void> {
  const indexPath = `${RNFS.DocumentDirectoryPath}/peardrop-received-files.json`;
  try {
    await RNFS.unlink(indexPath);
  } catch {
    // No index yet — that's fine.
  }
  const demoDir = `${RNFS.DocumentDirectoryPath}/peardrop-demo`;
  try {
    await RNFS.unlink(demoDir);
  } catch {
    // Demo dir didn't exist — fine.
  }
}
