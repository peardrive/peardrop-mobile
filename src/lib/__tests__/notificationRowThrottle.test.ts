import {
  classifyRowPost,
  PROGRESS_INDETERMINATE,
  PROGRESS_NONE,
  type LastRowPost,
  type NotificationRow,
} from "../notificationContent";
import {
  classifyNotificationPost,
  NOTIFICATION_UPDATE_INTERVAL_MS,
} from "../notificationProgress";

/** The per-row throttle. The field list differs from single-row content; the
 * timing policy must not, and that is the half that can drift silently. */

const NOW = 1_700_000_000_000;

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    title: "Receiving 1 file",
    text: "holiday.jpg",
    subline: "1 MB of 4 MB",
    percent: 25,
    ...over,
  };
}

const last = (r: NotificationRow, at = NOW): LastRowPost => ({ at, row: r });

describe("the first post", () => {
  it("always posts", () => {
    expect(classifyRowPost(null, row(), NOW)).toBe("posted");
  });
});

describe("identical content", () => {
  it("is suppressed however long ago it was posted", () => {
    const r = row();
    expect(classifyRowPost(last(r, NOW - 86_400_000), r, NOW)).toBe(
      "suppressed-identical"
    );
  });

  /** Each of the four fields must be able to break the suppression. */
  it.each([
    ["title", { title: "Receiving 2 files" }],
    ["text", { text: "other.jpg" }],
    ["subline", { subline: "2 MB of 4 MB" }],
    ["percent", { percent: 26 }],
  ])("is broken by a change to %s", (_field, over) => {
    const base = row();
    const next = row(over as Partial<NotificationRow>);
    expect(classifyRowPost(last(base, NOW - 10_000), next, NOW)).toBe("posted");
  });

  /** The sentinels are content: losing a bar is a visible change. */
  it("is broken by a change between progress sentinels", () => {
    const determinate = row({ percent: 0 });
    const sweeping = row({ percent: PROGRESS_INDETERMINATE });
    const none = row({ percent: PROGRESS_NONE });
    expect(classifyRowPost(last(determinate, NOW - 10_000), sweeping, NOW)).toBe(
      "posted"
    );
    expect(classifyRowPost(last(sweeping, NOW - 10_000), none, NOW)).toBe(
      "posted"
    );
  });
});

describe("the rate limit", () => {
  it("suppresses changed content inside the interval", () => {
    expect(
      classifyRowPost(last(row(), NOW - 1), row({ percent: 99 }), NOW)
    ).toBe("suppressed-rate");
  });

  it("posts changed content exactly at the interval", () => {
    expect(
      classifyRowPost(
        last(row(), NOW - NOTIFICATION_UPDATE_INTERVAL_MS),
        row({ percent: 99 }),
        NOW
      )
    ).toBe("posted");
  });

  it("suppresses one millisecond short of the interval", () => {
    expect(
      classifyRowPost(
        last(row(), NOW - (NOTIFICATION_UPDATE_INTERVAL_MS - 1)),
        row({ percent: 99 }),
        NOW
      )
    ).toBe("suppressed-rate");
  });

  /** Posting beats wedging the row at a stale value until reboot. */
  it("posts when the clock moved backwards", () => {
    expect(
      classifyRowPost(last(row(), NOW + 60_000), row({ percent: 99 }), NOW)
    ).toBe("posted");
  });

  it("posts on a non-finite elapsed time", () => {
    expect(
      classifyRowPost(last(row(), Number.NaN), row({ percent: 99 }), NOW)
    ).toBe("posted");
  });
});

describe("agreement with the single-row throttle on the timing arm", () => {
  /** Both are fed changed content, which leaves only the clock in play. */
  const offsets = [
    0,
    1,
    NOTIFICATION_UPDATE_INTERVAL_MS - 1,
    NOTIFICATION_UPDATE_INTERVAL_MS,
    NOTIFICATION_UPDATE_INTERVAL_MS + 1,
    60_000,
    -1,
    -60_000,
  ];

  it.each(offsets)("agrees at an elapsed time of %i ms", (offset) => {
    const rowDecision = classifyRowPost(
      last(row(), NOW - offset),
      row({ title: "changed" }),
      NOW
    );
    const contentDecision = classifyNotificationPost(
      {
        at: NOW - offset,
        content: {
          title: "Receiving 1 file",
          text: "holiday.jpg",
          percent: 25,
          cancelLabel: "Cancel",
        },
      },
      {
        title: "changed",
        text: "holiday.jpg",
        percent: 25,
        cancelLabel: "Cancel",
      },
      NOW
    );
    expect(rowDecision).toBe(contentDecision);
  });
});
