import { describe, expect, it } from "vitest";
import { LIBRARY_READ_STATUSES } from "../imports/library.js";
import {
  IMPORT_STATUS_LABELS,
  LIBRARY_STATUS_LABELS,
  resolveLibraryStatusLabel,
} from "./index.js";

describe("Library marks — the one door", () => {
  it("names every read status of the contract (derived, not hand-listed)", () => {
    expect(LIBRARY_READ_STATUSES.length).toBeGreaterThanOrEqual(6);
    for (const s of LIBRARY_READ_STATUSES) {
      expect(LIBRARY_STATUS_LABELS[s], s).toBeTruthy();
    }
  });

  it("says a not-yet-read item will be read, never that it failed", () => {
    expect(resolveLibraryStatusLabel("not_read")).toBe("Not read yet");
    expect(resolveLibraryStatusLabel("over_budget")).toBe("Read later");
    expect(resolveLibraryStatusLabel("unreadable")).toBe("Unreadable");
    expect(resolveLibraryStatusLabel("archived")).toBe("Archived");
    expect(resolveLibraryStatusLabel("kept")).toBe("Kept");
  });

  it("an item never reads two ways across the import and Library tables", () => {
    for (const s of ["needs_file", "title_only"]) {
      expect(LIBRARY_STATUS_LABELS[s]).toBe(IMPORT_STATUS_LABELS[s]);
    }
  });

  it("an unknown token humanizes, never leaks", () => {
    expect(resolveLibraryStatusLabel("waiting_on_device")).toBe(
      "Waiting on device"
    );
    expect(resolveLibraryStatusLabel(null)).toBe("");
  });
});
