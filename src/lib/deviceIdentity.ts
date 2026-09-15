import { NativeModules, Platform } from "react-native";

import { log as debugLog } from "./debugLog";
import { isXiaomiDevice } from "./openBackgroundSettings";
import { subscribeDebugLogging } from "../state/debugLogStorage";

/**
 * who this device says it is, and what `isXiaomiDevice()` makes
 * of that.
 *
 * ## Why this exists
 *
 * `isXiaomiDevice()` is a `Build.MANUFACTURER` regex, and it is load-bearing:
 * it decides which ladder runs, which Settings row appears, and what the
 * background-restriction prompt says. It has been verified on exactly one
 * device. This readout is how that match gets checked against real hardware —
 * especially rebranded and carrier builds, where MANUFACTURER, BRAND and
 * PRODUCT routinely disagree with each other and with the name on the box.
 *
 * ## MANUFACTURER vs BRAND
 *
 * These are two fields, not two spellings of one, and they are deliberately
 * adjacent and first in the readout. `judemanutd/AutoStarter` — the most
 * maintained OEM autostart library, and the source for most of this sprint's
 * candidates — dispatches on `Build.BRAND.lowercase()`. `isXiaomiDevice()`
 * matches `Build.MANUFACTURER`. On a Redmi both read Xiaomi-ish and the
 * question never comes up; on a carrier or rebranded build it will. Every
 * borrowed device is a data point on which field is the right one, and the
 * readout is worthless for that purpose unless both are recorded verbatim.
 *
 * ## Not in devGate.ts
 *
 * That module is untouchable this sprint and describes the BUILD; this one
 * describes the DEVICE. Keeping them apart also keeps the import graph
 * acyclic: this file may depend on openBackgroundSettings.ts (for the real
 * `isXiaomiDevice`, rather than a copy of its body that could drift from it),
 * and nothing in the logging core depends on this file.
 */

type DeviceConstants = {
  buildDevice?: string;
  buildProduct?: string;
  buildDisplay?: string;
};

const native: DeviceConstants | undefined = (
  NativeModules as { PeardropBuildInfo?: DeviceConstants }
).PeardropBuildInfo;

/** `Platform.constants` is typed loosely per-platform; read it defensively. */
const platformConstants = (Platform.constants ?? {}) as Record<string, unknown>;

function fromPlatform(key: string): string {
  const value = platformConstants[key];
  return value === undefined || value === null || value === ""
    ? "unknown"
    : String(value);
}

function fromNative(key: keyof DeviceConstants): string {
  const value = native?.[key];
  return typeof value === "string" && value !== "" ? value : "unknown";
}

export type DeviceIdentity = {
  /** Build.MANUFACTURER — what isXiaomiDevice() matches on. */
  manufacturer: string;
  /** Build.BRAND — what AutoStarter dispatches on. */
  brand: string;
  model: string;
  device: string;
  product: string;
  /** Build.DISPLAY — the ROM build ID. Names the HyperOS/MIUI/One UI version. */
  display: string;
  release: string;
  sdkInt: string;
  /** The live result of isXiaomiDevice(), not a re-derivation of it. */
  isXiaomi: boolean;
  platform: string;
};

export function deviceIdentity(): DeviceIdentity {
  return {
    manufacturer: fromPlatform("Manufacturer"),
    brand: fromPlatform("Brand"),
    model: fromPlatform("Model"),
    device: fromNative("buildDevice"),
    product: fromNative("buildProduct"),
    display: fromNative("buildDisplay"),
    release: fromPlatform("Release"),
    // RN names Build.VERSION.SDK_INT "Version" on Android.
    sdkInt: fromPlatform("Version"),
    isXiaomi: isXiaomiDevice(),
    platform: Platform.OS,
  };
}

/** The rows of the on-screen block: label + value, in reading order. */
export function deviceIdentityRows(): readonly (readonly [string, string])[] {
  const d = deviceIdentity();
  return [
    ["MANUFACTURER", d.manufacturer],
    ["BRAND", d.brand],
    ["MODEL", d.model],
    ["DEVICE", d.device],
    ["PRODUCT", d.product],
    ["DISPLAY (ROM)", d.display],
    ["ANDROID", `${d.release} (SDK ${d.sdkInt})`],
    ["isXiaomiDevice()", String(d.isXiaomi)],
  ];
}

/** The same block as one log line. */
export function describeDevice(): string {
  const d = deviceIdentity();
  return (
    `manufacturer=${d.manufacturer} brand=${d.brand} model=${d.model} ` +
    `device=${d.device} product=${d.product} display=${d.display} ` +
    `release=${d.release} sdk=${d.sdkInt} platform=${d.platform} ` +
    `isXiaomiDevice=${d.isXiaomi}`
  );
}

// ---------------------------------------------------------------------
// Boot line
// ---------------------------------------------------------------------

let started = false;

/**
 * Write the identity line on the rising edge of debug logging, for every
 * session, in every build.
 *
 * Deliberately NOT gated on `IS_DEBUG_BUILD`: a log from a plain release
 * build still needs to say which device produced it, and the whole point of
 * this line is to be present in any exported log so a borrowed-device session
 * can be read afterwards.
 *
 * The rising edge rather than a boot effect, for the same reason
 * `describeBuild()` uses it: `subscribeDebugLogging` replays the current value
 * on subscribe, so a run that started with the flag already on records the
 * identity at boot, and a run where the operator flips it mid-session records
 * it at that point instead. Either way the line cannot be missing, which a
 * one-shot call at boot could not guarantee.
 *
 * Must be called AFTER `initDebugLog()`. Subscribers fire in registration
 * order and `applyEnabled` sets its `enabled` flag synchronously before its
 * first await, so registering second means `log()` is already live when this
 * runs. Registering first would drop the line silently.
 */
export function initDeviceIdentityLog(): void {
  if (started) return;
  started = true;
  let previous = false;
  subscribeDebugLogging((next) => {
    if (next && !previous) debugLog("warn", "device", describeDevice());
    previous = next;
  });
}
