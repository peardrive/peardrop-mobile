import { NativeModules, Platform } from "react-native";

import { log as debugLog } from "./debugLog";
import { isXiaomiDevice } from "./openBackgroundSettings";
import { subscribeDebugLogging } from "../state/debugLogStorage";

/**
 * Who this device says it is, and what `isXiaomiDevice()` makes of that.
 * That match is a `Build.MANUFACTURER` regex and decides which ladder runs,
 * which Settings row appears and what the prompt says, so MANUFACTURER and
 * BRAND are recorded verbatim and adjacent: autostart libraries dispatch on
 * `Build.BRAND.lowercase()`, and on rebranded builds the two disagree.
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

// Boot line

let started = false;

/** Write the identity line on the rising edge of debug logging, in every
 *  build. Deliberately not gated on `IS_DEBUG_BUILD`: a release-build log
 *  still needs to say which device produced it. Must be called after
 *  `initDebugLog()`, or subscriber order drops the line silently. */
export function initDeviceIdentityLog(): void {
  if (started) return;
  started = true;
  let previous = false;
  subscribeDebugLogging((next) => {
    if (next && !previous) debugLog("warn", "device", describeDevice());
    previous = next;
  });
}
