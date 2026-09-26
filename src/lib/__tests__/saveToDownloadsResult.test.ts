/**
 * What the user is told about where their file went.
 *
 * `saveToDownloads.ts` imports react-native and cannot load under jest; the
 * copy happens in Kotlin against MediaStore. All the wording lives in
 * `saveToDownloadsResult.ts`, which is RN-free.
 *
 * The renamed case is load-bearing: MediaStore disambiguates a collision by
 * appending " (1)" to the display name, so the native side must read the
 * assigned name back out of the store, or the toast names a file that does
 * not exist.
 */

import { describeSaveResult } from "../saveToDownloadsResult";

describe("describeSaveResult", () => {
  it("names the file and the folder on success", () => {
    const msg = describeSaveResult({
      ok: true,
      name: "holiday.mp4",
      uri: "content://media/external/downloads/42",
      path: "Download/PearDrop/holiday.mp4",
      folder: "Download/PearDrop",
    });
    expect(msg).toEqual({
      text: "Saved to Download/PearDrop — holiday.mp4",
      kind: "success",
    });
  });

  // the folder comes from the native side, which is the module
  // that decided it. Reconstructing it here would drift the moment
  // `DOWNLOAD_SUBDIR` in SaveToDownloadsModule.kt changes — and the user
  // would be sent to a folder the file is not in, which for a busy Downloads
  // folder is worse than saying nothing at all.
  it("names whatever folder the native side reports, not a hardcoded one", () => {
    const msg = describeSaveResult({
      ok: true,
      name: "x.bin",
      folder: "Download/SomewhereElse",
    });
    expect(msg.text).toBe("Saved to Download/SomewhereElse — x.bin");
  });

  // An older native half that predates the field must still produce a usable
  // line rather than "Saved to undefined".
  it("falls back to the known subfolder when folder is absent", () => {
    const msg = describeSaveResult({ ok: true, name: "x.bin" });
    expect(msg.text).toBe("Saved to Download/PearDrop — x.bin");
    expect(msg.text).not.toContain("undefined");
  });

  // The regression guard. A save that succeeded under a different name must
  // report the name MediaStore actually used.
  it("reports the name MediaStore assigned, not the one requested", () => {
    const msg = describeSaveResult({
      ok: true,
      name: "holiday (1).mp4",
      uri: "content://media/external/downloads/43",
      path: "Download/PearDrop/holiday (1).mp4",
      folder: "Download/PearDrop",
    });
    expect(msg.text).toContain("holiday (1).mp4");
    expect(msg.kind).toBe("success");
  });

  it("gives the one actionable failure its own line", () => {
    const msg = describeSaveResult({
      ok: false,
      code: "source-missing",
      message: "File no longer exists: /data/.../x.bin",
    });
    expect(msg).toEqual({
      text: "This file is no longer available locally.",
      kind: "error",
    });
  });

  it("collapses device-side failures into one honest line", () => {
    for (const code of [
      "insert-failed",
      "copy-failed",
      "save-threw",
      "bridge-threw",
      "unavailable",
      "source-not-file",
    ]) {
      const msg = describeSaveResult({ ok: false, code, message: "detail" });
      expect(msg).toEqual({
        text: "Couldn't save that one to Downloads.",
        kind: "error",
      });
    }
  });

  // The raw exception text goes to the structured log, never to the toast.
  // A user cannot act on "FileNotFoundException: EACCES", and 9D's field
  // report was that error text reading like a crash is worse than no error.
  it("never leaks the native exception text into the toast", () => {
    const msg = describeSaveResult({
      ok: false,
      code: "copy-failed",
      message: "IOException: ENOSPC: No space left on device",
    });
    expect(msg.text).not.toContain("IOException");
    expect(msg.text).not.toContain("ENOSPC");
  });
});
