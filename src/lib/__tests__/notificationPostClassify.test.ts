/**
 * `pushNotification` must leave evidence without doubling the flood it
 * diagnoses. Its two silent exits leave an exported log saying nothing about
 * notification content, and the line that settles it fires per transfer
 * mutation, so it is gated on the same decision it reports. A boolean cannot
 * tell "identical" from "too soon", which are the two cases the log must
 * separate; `classifyNotificationPost` is that decision, named.
 */

import {
  NOTIFICATION_UPDATE_INTERVAL_MS,
  classifyNotificationPost,
  shouldPostNotification,
  type LastPost,
  type NotificationContent,
} from "../notificationProgress";

function content(over: Partial<NotificationContent> = {}): NotificationContent {
  return {
    title: "Receiving report.pdf",
    text: "42% · 4.2 MB of 10 MB",
    percent: 42,
    cancelLabel: "Cancel",
    ...over,
  };
}

describe("classifyNotificationPost names the outcome", () => {
  it("posts the first content of a service window", () => {
    expect(classifyNotificationPost(null, content(), 1000)).toBe("posted");
  });

  it("distinguishes identical content from too-soon content", () => {
    const last: LastPost = { at: 1000, content: content() };

    // Identical — dropped however long it has been.
    expect(
      classifyNotificationPost(last, content(), 1000 + NOTIFICATION_UPDATE_INTERVAL_MS * 10)
    ).toBe("suppressed-identical");

    // Changed, but inside the rate limit.
    expect(classifyNotificationPost(last, content({ percent: 43 }), 1100)).toBe(
      "suppressed-rate"
    );

    // Changed, and the rate limit has elapsed.
    expect(
      classifyNotificationPost(
        last,
        content({ percent: 43 }),
        1000 + NOTIFICATION_UPDATE_INTERVAL_MS
      )
    ).toBe("posted");
  });

  it("treats the Cancel label as content, like shouldPostNotification does", () => {
    const last: LastPost = { at: 1000, content: content() };
    expect(classifyNotificationPost(last, content({ cancelLabel: "Cancel all" }), 1001)).toBe(
      "suppressed-rate"
    );
  });

  it("posts when the clock moved backwards or went non-finite", () => {
    const last: LastPost = { at: 5000, content: content() };
    expect(classifyNotificationPost(last, content({ percent: 43 }), 10)).toBe("posted");
    expect(classifyNotificationPost(last, content({ percent: 43 }), NaN)).toBe("posted");
  });

  it("never disagrees with shouldPostNotification — the two cannot drift", () => {
    const lasts: (LastPost | null)[] = [
      null,
      { at: 1000, content: content() },
      { at: 1000, content: content({ percent: 99, text: "99%" }) },
    ];
    const nexts = [
      content(),
      content({ percent: 43 }),
      content({ title: "Receiving 3 shares", cancelLabel: "Cancel all" }),
    ];
    const times = [10, 1000, 1001, 1999, 2000, 12000, NaN];
    for (const last of lasts) {
      for (const next of nexts) {
        for (const now of times) {
          expect(classifyNotificationPost(last, next, now) === "posted").toBe(
            shouldPostNotification(last, next, now)
          );
        }
      }
    }
  });
});
