import { scanHandoff } from "../scanHandoff";

/**
 * An accepted QR scan used to hide the Receive sheet before starting the
 * resolve, which dropped the user on the list with no spinner, no Cancel and
 * no surface for a failure to report to. The sheet now stays and shows the
 * looking state instead.
 *
 * This file pins the RECORD. It does not gate the wiring: only `.resolves` is
 * read in production, so re-adding the hide fails
 * `receiveSheetWiring.test.ts` ("no longer hides the sheet on an accepted
 * scan"), not any assertion here.
 */
describe("scanHandoff", () => {
  it("does NOT hide the sheet — the looking state needs a surface to draw on", () => {
    expect(scanHandoff().hidesReceiveSheet).toBe(false);
  });

  it("resolves the scanned link", () => {
    expect(scanHandoff().resolves).toBe(true);
  });

  it("does NOT abort — the resolve it starts is the one we want", () => {
    // Routing a scan through closeReceiveSheet would bump the resolve
    // generation and kill the resolve started on the next line.
    expect(scanHandoff().aborts).toBe(false);
  });

  it("DOES write the draft — the input, the × and the retry icon all key on it", () => {
    // Writing it re-arms the 450 ms debounce, which would resolve a second
    // time; a one-shot ref in the provider skips exactly that value. The
    // ordering that makes it safe is pinned in receiveSheetWiring.test.ts.
    expect(scanHandoff().writesDraft).toBe(true);
  });

  it("clears the scan latch, so a failed scan can be retried on the same camera", () => {
    expect(scanHandoff().clearsScanLatch).toBe(true);
  });
});
