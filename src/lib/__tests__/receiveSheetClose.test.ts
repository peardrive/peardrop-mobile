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
    closeReceiveSheet({ hide, abortResolving });
    expect(abortResolving).toHaveBeenCalledTimes(1);
  });

  it("also hides the sheet, and aborts before hiding", () => {
    const calls: string[] = [];
    closeReceiveSheet({
      hide: () => calls.push("hide"),
      abortResolving: () => calls.push("abort"),
    });
    expect(calls).toEqual(["abort", "hide"]);
  });
});
