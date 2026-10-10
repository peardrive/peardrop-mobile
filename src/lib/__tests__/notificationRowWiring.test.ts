import fs from "fs";
import path from "path";

/** Source-text probes for the call sites, because a green suite over code
 * nothing calls is not evidence. A content layer once shipped with no caller. */

const BACKEND = path.join(__dirname, "..", "..", "state", "backend.ts");
const SERVICE_KT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "android",
  "app",
  "src",
  "main",
  "java",
  "com",
  "anjouinc",
  "peardrop",
  "TransferService.kt"
);
const MODULE_KT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "android",
  "app",
  "src",
  "main",
  "java",
  "com",
  "anjouinc",
  "peardrop",
  "TransferServiceModule.kt"
);

const FOREGROUND = path.join(__dirname, "..", "foregroundService.ts");

const backendSrc = fs.readFileSync(BACKEND, "utf8");
const foregroundSrc = fs.readFileSync(FOREGROUND, "utf8");
const serviceKt = fs.readFileSync(SERVICE_KT, "utf8");
const moduleKt = fs.readFileSync(MODULE_KT, "utf8");

function contains(src: string, needle: string): { needle: string; present: boolean } {
  return { needle, present: src.includes(needle) };
}
const present = (needle: string) => ({ needle, present: true });
const absent = (needle: string) => ({ needle, present: false });

describe("the two-row builder is actually called", () => {
  it("builds rows from the activity predicate and pushes them", () => {
    for (const needle of [
      "describeNotificationRows(list, now, driveNamesFor)",
      "void updateServiceRows(rows);",
    ]) {
      expect(contains(backendSrc, needle)).toEqual(present(needle));
    }
  });

  /** The superseded single-row path must be gone, not merely unused. */
  it("no longer calls the single-row content layer or bridge", () => {
    for (const dead of [
      "describeTransferNotification(",
      "updateServiceProgress(",
      "classifyNotificationPost(",
    ]) {
      expect(contains(backendSrc, dead)).toEqual(absent(dead));
    }
  });

  /** Content before the start is what makes the first frame the real row. */
  it("pushes content before starting the service", () => {
    const pushAt = backendSrc.indexOf("pushNotification(transfersRef.current);");
    const startAt = backendSrc.indexOf("void startForegroundService(trigger)");
    expect({ pushFound: pushAt >= 0, startFound: startAt >= 0 }).toEqual({
      pushFound: true,
      startFound: true,
    });
    expect(pushAt).toBeLessThan(startAt);
  });

  /** Each row throttles on its own slot. One slot would make them interfere. */
  it("keeps a separate post history per row", () => {
    expect(contains(backendSrc, "classifyRowPost(last.receiving, rows.receiving, now)")).toEqual(
      present("classifyRowPost(last.receiving, rows.receiving, now)")
    );
    expect(contains(backendSrc, "classifyRowPost(last.sharing, rows.sharing, now)")).toEqual(
      present("classifyRowPost(last.sharing, rows.sharing, now)")
    );
    // Every reset clears both slots; a `= null` would not typecheck, but a
    // half-reset would.
    expect(backendSrc.split("{ receiving: null, sharing: null }").length - 1).toBe(4);
  });
});

describe("the split cancel is wired to the split selector", () => {
  it("cancels through selectReceivingCancelTargets and nothing wider", () => {
    expect(contains(backendSrc, "selectReceivingCancelTargets(list, now)")).toEqual(
      present("selectReceivingCancelTargets(list, now)")
    );
    expect(contains(backendSrc, "const cancelReceiving = useCallback(")).toEqual(
      present("const cancelReceiving = useCallback(")
    );
  });

  /** Mapping `activeTransfers` directly would let a receive cancel stop a
   * share, so neither that name nor the unfiltered map may survive. */
  it("has no cancel-all path left", () => {
    for (const dead of [
      "cancelAllActive",
      "const active = activeTransfers(list, now);",
    ]) {
      expect(contains(backendSrc, dead)).toEqual(absent(dead));
    }
  });

  it("subscribes the handler to the receiving-scoped event", () => {
    const needle = "DeviceEventEmitter.addListener(EVENT_CANCEL_RECEIVING, () => {";
    expect(contains(backendSrc, needle)).toEqual(present(needle));
  });
});

describe("the JS/Kotlin literal pairs", () => {
  /** Matched literal pairs across the boundary; a mismatch is silent. */
  it("agree on the cancel event name", () => {
    const js = `export const EVENT_CANCEL_RECEIVING = "PeardropCancelReceiving";`;
    const kt = `const val EVENT_CANCEL_RECEIVING = "PeardropCancelReceiving"`;
    expect(contains(foregroundSrc, js)).toEqual(present(js));
    expect(contains(serviceKt, kt)).toEqual(present(kt));
    // Probes the declaration, not the word: both files name the superseded
    // string in a comment about the rename.
    expect(contains(foregroundSrc, "export const EVENT_CANCEL_ALL")).toEqual(
      absent("export const EVENT_CANCEL_ALL")
    );
    expect(contains(serviceKt, "const val EVENT_CANCEL_ALL")).toEqual(
      absent("const val EVENT_CANCEL_ALL")
    );
    expect(contains(serviceKt, "const val ACTION_CANCEL =")).toEqual(
      absent("const val ACTION_CANCEL =")
    );
  });

  /** The progress sentinels are a three-way contract. */
  it("agree on the progress sentinels", () => {
    expect(contains(serviceKt, "private const val PROGRESS_INDETERMINATE = -1")).toEqual(
      present("private const val PROGRESS_INDETERMINATE = -1")
    );
    expect(contains(serviceKt, "private const val PROGRESS_NONE = -2")).toEqual(
      present("private const val PROGRESS_NONE = -2")
    );
  });

  it("agree on the service-row names", () => {
    expect(contains(serviceKt, `const val ROW_RECEIVING = "receiving"`)).toEqual(
      present(`const val ROW_RECEIVING = "receiving"`)
    );
    expect(contains(serviceKt, `const val ROW_SHARING = "sharing"`)).toEqual(
      present(`const val ROW_SHARING = "sharing"`)
    );
  });

  it("agree on the bridge method name and its arity", () => {
    expect(contains(backendSrc, "updateServiceRows")).toEqual(
      present("updateServiceRows")
    );
    expect(contains(moduleKt, "fun updateRows(")).toEqual(
      present("fun updateRows(")
    );
    // 11 content parameters plus the promise.
    expect(contains(moduleKt, "serviceRow: String,")).toEqual(
      present("serviceRow: String,")
    );
  });
});

describe("Kotlin: two channels, two ids, and rows that cannot outlive the service", () => {
  it("gives each row its own channel and id", () => {
    for (const needle of [
      `const val CHANNEL_RECEIVING = "transfer-receiving"`,
      `const val CHANNEL_SHARING = "transfer-sharing"`,
      "const val RECEIVING_NOTIFICATION_ID = 4714",
      "const val SHARING_NOTIFICATION_ID = 4715",
    ]) {
      expect(contains(serviceKt, needle)).toEqual(present(needle));
    }
  });

  /** Both channels low-importance and badge-free, like the one they replace. */
  it("creates both channels at IMPORTANCE_LOW with no badge", () => {
    expect(serviceKt.split("NotificationManager.IMPORTANCE_LOW").length - 1).toBe(2);
    expect(serviceKt.split("channel.setShowBadge(false)").length - 1).toBe(2);
  });

  /** Every ending path clears both rows; `onDestroy` is the backstop. */
  it("clears both rows on every ending path", () => {
    expect(serviceKt.split("clearRows(this)").length - 1).toBe(3);
    expect(contains(serviceKt, "manager.cancel(RECEIVING_NOTIFICATION_ID)")).toEqual(
      present("manager.cancel(RECEIVING_NOTIFICATION_ID)")
    );
    expect(contains(serviceKt, "manager.cancel(SHARING_NOTIFICATION_ID)")).toEqual(
      present("manager.cancel(SHARING_NOTIFICATION_ID)")
    );
    expect(contains(moduleKt, "TransferService.clearRows(context)")).toEqual(
      present("TransferService.clearRows(context)")
    );
  });

  /** Only the Receiving row carries an action. */
  it("adds the Cancel action to the Receiving row alone", () => {
    expect(contains(serviceKt, "withCancel = true")).toEqual(
      present("withCancel = true")
    );
    expect(contains(serviceKt, "withCancel = false")).toEqual(
      present("withCancel = false")
    );
    expect(serviceKt.split("builder.addAction(").length - 1).toBe(1);
  });

  /** The legacy single-row channel is removed, not left controlling nothing. */
  it("deletes the superseded channel", () => {
    expect(contains(serviceKt, "manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)")).toEqual(
      present("manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)")
    );
  });

  /** The `transfers` completion channel is out of scope, so this probes the
   * quoted id rather than the word, which appears all over both files. */
  it("never names the completion channel id", () => {
    expect(contains(serviceKt, `"transfers"`)).toEqual(absent(`"transfers"`));
    expect(contains(moduleKt, `"transfers"`)).toEqual(absent(`"transfers"`));
  });
});
