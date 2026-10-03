import { closeReceiveSheet } from "../receiveSheetClose";

/**
 * closing the Receive sheet must abort the in-flight
 * resolve, not just hide the sheet. This is the gap in MainScreen's
 * `onClose`: without the abort, the resolve and its 30 s rejection timer
 * keep running with no surface to report to.
 *
 * Written so that deleting the `abortResolving()` invocation from
 * `closeReceiveSheet` fails the first test.
 */
describe("closeReceiveSheet", () => {
  it("calls abortResolving — hiding the sheet alone is not enough", () => {
    const hide = jest.fn();
    const abortResolving = jest.fn();
    const clearDraft = jest.fn();
    closeReceiveSheet({ hide, abortResolving, clearDraft });
    expect(abortResolving).toHaveBeenCalledTimes(1);
  });

  it("clears the draft — a closed sheet must not reopen holding the old link", () => {
    const clearDraft = jest.fn();
    closeReceiveSheet({ hide: jest.fn(), abortResolving: jest.fn(), clearDraft });
    expect(clearDraft).toHaveBeenCalledTimes(1);
  });

  it("aborts before clearing, and clears before hiding", () => {
    const calls: string[] = [];
    closeReceiveSheet({
      hide: () => calls.push("hide"),
      abortResolving: () => calls.push("abort"),
      clearDraft: () => calls.push("clear"),
    });
    expect(calls).toEqual(["abort", "clear", "hide"]);
  });
});
