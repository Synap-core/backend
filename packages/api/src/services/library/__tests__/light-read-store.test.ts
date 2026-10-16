/**
 * `readStoredLibraryRead` — THE pod-side reader of `importRead`: the contract
 * fields validated by `readLibraryItemRead`, the bookkeeping kept only with
 * its own type, and `exists` false only when the light read wrote nothing.
 */
import { describe, expect, it } from "vitest";
import { readStoredLibraryRead } from "../light-read-store.js";

describe("readStoredLibraryRead", () => {
  it("never written → exists false, the content-status fallback", () => {
    expect(readStoredLibraryRead({ importItem: {} }, "needs_file")).toEqual({
      exists: false,
      read: { status: "needs_file", suggestedActions: [] },
    });
  });

  it("keeps the bookkeeping with its own type only; the contract is validated", () => {
    const { exists, read } = readStoredLibraryRead({
      importRead: {
        status: "not_read",
        suggestedActions: [{ id: "x", kind: "nope" }],
        textKey: "k",
        aiAt: 7,
        attempts: 2,
        transientFailures: "3",
        requestedReader: "capture_social_post",
        readCheckpoint: { readerId: "r" },
        lastError: "",
      },
    });
    expect(exists).toBe(true);
    expect(read).toEqual({
      status: "not_read",
      suggestedActions: [],
      textKey: "k",
      attempts: 2,
      requestedReader: "capture_social_post",
      readCheckpoint: { readerId: "r" },
    });
  });

  it("a budget stamp alone (no status yet) exists, and reads not_read", () => {
    const { exists, read } = readStoredLibraryRead({
      importRead: { aiAt: "2026-10-16T00:00:00.000Z" },
    });
    expect(exists).toBe(true);
    expect(read.status).toBe("not_read");
    expect(read.aiAt).toBe("2026-10-16T00:00:00.000Z");
  });
});
