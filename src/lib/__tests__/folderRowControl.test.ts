/**
 * No folder-modal row control may stop a share. Every assertion runs against
 * the real module both the screen and the modal delegate the decision to;
 * nothing is reimplemented and nothing is mocked. The suite collects no
 * component tests, so what the modal renders is not asserted here. What is
 * asserted is the guarantee that depends on: the decision has no way to
 * express a stop, and the negative sweep checks none survives in the tree.
 */

import {
  folderRowControl,
  type FolderRowControl,
} from "../folderRowControl";

describe("the per-file control can only ever open a file", () => {
  /**
   * The probe. A control chosen by `isActiveShare: statusTone === "warning"`
   * gives a received child mid-grab — which inherits the drive-level
   * `warning` tone — a red ⊗ labelled `Stop sharing ⟨name⟩`. Stated here as
   * what must hold for every possible row: the decision does not take a tone,
   * and cannot return a stop.
   */
  it("offers only an open control, for every combination of inputs", () => {
    const kinds = new Set<FolderRowControl["kind"]>();
    for (const fileName of ["holiday.jpg", "", "a".repeat(200), "Stop sharing"]) {
      for (const hasLocalCopy of [true, false]) {
        kinds.add(folderRowControl({ fileName, hasLocalCopy }).kind);
      }
    }
    expect(Array.from(kinds).sort()).toEqual(["none", "open"]);
  });

  it("gives a downloading child no control at all, rather than a misleading one", () => {
    // A received child mid-grab has nothing on disk yet. An open icon there
    // falls through to "This file is no longer available locally." — false of
    // a file that is at that moment downloading.
    expect(folderRowControl({ fileName: "holiday.jpg", hasLocalCopy: false })).toEqual({
      kind: "none",
    });
  });

  it("labels the open control with the file it opens", () => {
    expect(folderRowControl({ fileName: "holiday.jpg", hasLocalCopy: true })).toEqual({
      kind: "open",
      accessibilityLabel: "Open holiday.jpg in another app",
    });
  });

  it("never produces a label that offers to stop, share, or re-share anything", () => {
    for (const fileName of ["holiday.jpg", "notes.txt", "clip.mp4"]) {
      for (const hasLocalCopy of [true, false]) {
        const control = folderRowControl({ fileName, hasLocalCopy });
        // Read the label off the value, not off a `kind === "open"`
        // narrowing. Narrowing first makes this vacuous against exactly the
        // control it exists to forbid: a `{ kind: "stop",
        // accessibilityLabel: "Stop sharing …" }` would be skipped.
        const label = String(
          (control as { accessibilityLabel?: unknown }).accessibilityLabel ?? "",
        ).toLowerCase();
        // no control may offer to re-share a received file.
        for (const banned of ["stop", "share", "sharing", "delete", "remove"]) {
          expect([fileName, banned, label.includes(banned)]).toEqual([
            fileName,
            banned,
            false,
          ]);
        }
      }
    }
  });
});
