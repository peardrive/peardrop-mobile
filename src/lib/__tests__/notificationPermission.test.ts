/**
 * The notification permission must be asked for in the foreground, and the
 * backgrounded backstop must never prompt. Only the platform boundary is
 * mocked; the decision, the memo and the log lines are the shipping code's.
 * Asking after the foreground early return means the only prompt a
 * receive-only user sees fires over another app, and the outcome has to reach
 * the log or an export cannot settle whether a prompt was shown. Each test
 * re-requires the module because the memo's poisoning is under test.
 */

type PermState = { granted: boolean; canAskAgain: boolean };

const mockCalls: string[] = [];
const mockScheduled: { content?: { title?: string }; trigger?: unknown }[] = [];
const mockLogs: { level: string; tag: string; msg: string }[] = [];
const mockPerm: PermState = { granted: false, canAskAgain: true };
const mockRequestResult: { granted: boolean } = { granted: false };
const mockAppState: { currentState: string } = { currentState: "background" };

jest.mock("react-native", () => ({
  AppState: mockAppState,
  Platform: { OS: "android" },
}));

jest.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationHandler: () => {},
  setNotificationChannelAsync: async () => null,
  getPermissionsAsync: async () => {
    mockCalls.push("get");
    return { ...mockPerm };
  },
  requestPermissionsAsync: async () => {
    mockCalls.push("request");
    return { ...mockRequestResult };
  },
  scheduleNotificationAsync: async (n: { content?: { title?: string } }) => {
    mockCalls.push("schedule");
    mockScheduled.push(n);
  },
}));

jest.mock("../debugLog", () => ({
  log: (level: string, tag: string, msg: string) => {
    mockLogs.push({ level, tag, msg });
  },
}));

type NotificationsModule = typeof import("../notifications");

function load(): NotificationsModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../notifications") as NotificationsModule;
}

beforeEach(() => {
  mockCalls.length = 0;
  mockScheduled.length = 0;
  mockLogs.length = 0;
  mockPerm.granted = false;
  mockPerm.canAskAgain = true;
  mockRequestResult.granted = false;
  mockAppState.currentState = "background";
});

describe("the backgrounded backstop must not prompt", () => {
  it("never calls requestPermissionsAsync from a backgrounded completion", async () => {
    const mod = load();
    await mod.notifyTransferComplete({ title: "Download complete", body: "b" });
    expect(mockCalls).toContain("get");
    expect(mockCalls).not.toContain("request");
  });

  it("leaves a debugLog line naming the suppression (console.warn would not reach the export)", async () => {
    const mod = load();
    await mod.notifyTransferComplete({ title: "Download complete", body: "b" });
    const notifyLogs = mockLogs.filter((l) => l.tag === "rn.notify");
    expect(notifyLogs.length).toBeGreaterThan(0);
    expect(notifyLogs.map((l) => l.msg).join(" | ")).toMatch(
      /POST_NOTIFICATIONS|permission/i,
    );
  });

  it("does not poison the memo: a later foreground ask still prompts", async () => {
    const mod = load();
    // A backgrounded completion arrives first and finds no permission.
    await mod.notifyTransferComplete({ title: "Download complete", body: "b" });
    mockCalls.length = 0;
    // The user then taps Grab in the foreground. This ask must reach the OS.
    mockAppState.currentState = "active";
    mockRequestResult.granted = true;
    const granted = await mod.ensurePermission();
    expect(mockCalls).toContain("request");
    expect(granted).toBe(true);
  });
});

describe("controls", () => {
  it("still posts on the transfer channel when permission is already granted", async () => {
    mockPerm.granted = true;
    const mod = load();
    await mod.notifyTransferComplete({ title: "Download complete", body: "b" });
    expect(mockCalls).toContain("schedule");
    expect(mockScheduled[0]?.trigger).toEqual({
      channelId: mod.TRANSFER_CHANNEL_ID,
    });
  });

  it("still returns early and posts nothing while the app is foreground", async () => {
    mockPerm.granted = true;
    mockAppState.currentState = "active";
    const mod = load();
    await mod.notifyTransferComplete({ title: "Download complete", body: "b" });
    expect(mockCalls).toEqual([]);
  });
});

describe("the foreground ask is diagnosable", () => {
  it("records the OS prompt and its outcome through debugLog", async () => {
    mockAppState.currentState = "active";
    mockRequestResult.granted = false;
    const mod = load();
    const granted = await mod.ensurePermission();
    expect(granted).toBe(false);
    const line = mockLogs.find(
      (l) => l.tag === "rn.notify" && /prompt/i.test(l.msg),
    );
    expect(line).toBeDefined();
    expect(line?.msg).toMatch(/granted=false/);
  });
});
