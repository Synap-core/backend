import { describe, expect, it } from "vitest";
import {
  isPermanentLibraryMediaFailure,
  readLibraryItemMedia,
  readLibraryItemRead,
} from "./library.js";

const STAMP = {
  id: "builtin:article",
  name: "Article",
  billed: false,
  readAt: "2026-10-15T00:00:00.000Z",
};

describe("readLibraryItemRead — the reader stamp arrives", () => {
  it("passes a stored reader stamp through", () => {
    const read = readLibraryItemRead({
      importRead: {
        status: "read",
        suggestedActions: [],
        reader: { ...STAMP, verbId: "capture_social_post", junk: 1 },
      },
    });
    expect(read.reader).toEqual({ ...STAMP, verbId: "capture_social_post" });
  });

  it("drops a malformed stamp, keeps the read", () => {
    const read = readLibraryItemRead({
      importRead: { status: "read", suggestedActions: [], reader: { id: "x" } },
    });
    expect(read.status).toBe("read");
    expect(read.reader).toBeUndefined();
  });
});

describe("readLibraryItemRead — why a link was not read, and a transcript", () => {
  it("passes a blocked reason and a transcript source through", () => {
    const read = readLibraryItemRead({
      importRead: {
        status: "unreadable",
        suggestedActions: [],
        blocked: {
          reason: "login_wall",
          nextStep: "open_in_my_browser",
          detail: "Sign in",
        },
        transcript: { source: "stt", lang: "en" },
      },
    });
    expect(read.blocked).toEqual({
      reason: "login_wall",
      nextStep: "open_in_my_browser",
      detail: "Sign in",
    });
    expect(read.transcript).toEqual({ source: "stt", lang: "en" });
  });

  it("drops an unknown reason / next step / source, keeps the read", () => {
    const read = readLibraryItemRead({
      importRead: {
        status: "needs_file",
        suggestedActions: [],
        blocked: { reason: "nope" },
        transcript: { source: "guess" },
      },
    });
    expect(read.status).toBe("needs_file");
    expect(read.blocked).toBeUndefined();
    expect(read.transcript).toBeUndefined();
    expect(
      readLibraryItemRead({
        importRead: {
          status: "needs_file",
          suggestedActions: [],
          blocked: { reason: "needs_reader", nextStep: "teleport" },
        },
      }).blocked
    ).toEqual({ reason: "needs_reader" });
  });
});

describe("readLibraryItemMedia", () => {
  const copy = (order: number, kind = "image") => ({
    documentId: `d${order}`,
    mime: kind === "video" ? "video/mp4" : "image/jpeg",
    bytes: 10,
    sourceUrl: `https://cdn.test/${order}`,
    copiedAt: "2026-10-15T00:00:00.000Z",
    kind,
    order,
  });

  it("reads the copies in order and the failed count", () => {
    const r = readLibraryItemMedia({
      importMedia: [
        copy(2, "video"),
        copy(0),
        { documentId: 3 },
        copy(1, "audio"),
      ],
      importMediaFailed: 2,
    });
    expect(r.media.map((m) => m.documentId)).toEqual(["d0", "d2"]);
    expect(r.failed).toBe(2);
  });

  it("failedAt is the newest failed attempt — the moment a retry moves", () => {
    const r = readLibraryItemMedia({
      importMediaFailed: 2,
      importMediaFailures: [
        {
          sourceUrl: "https://cdn.test/a",
          lastAttemptAt: "2026-10-14T08:00:00.000Z",
        },
        {
          sourceUrl: "https://cdn.test/b",
          lastAttemptAt: "2026-10-15T09:30:00.000Z",
        },
        { sourceUrl: "https://cdn.test/c" },
      ],
    });
    expect(r.failedAt).toBe("2026-10-15T09:30:00.000Z");
    // Nothing failed: no time to move.
    expect(
      readLibraryItemMedia({
        importMediaFailed: 0,
        importMediaFailures: [{ lastAttemptAt: "2026-10-15T09:30:00.000Z" }],
      }).failedAt
    ).toBeUndefined();
  });

  it("absent → empty, zero (never throws)", () => {
    expect(readLibraryItemMedia(null)).toEqual({
      media: [],
      failed: 0,
      failedReasons: [],
    });
    expect(
      readLibraryItemMedia({ importMedia: "x", importMediaFailed: -1 })
    ).toEqual({
      media: [],
      failed: 0,
      failedReasons: [],
    });
  });

  it("names each known failure reason once; permanence is the shared rule", () => {
    const got = readLibraryItemMedia({
      importMediaFailed: 3,
      importMediaFailures: [
        { sourceUrl: "a", reason: "timeout", attempts: 1 },
        { sourceUrl: "b", reason: "expired", attempts: 1 },
        { sourceUrl: "c", reason: "expired", attempts: 2 },
        { sourceUrl: "d", reason: "made_up", attempts: 1 },
      ],
    });
    expect(got.failedReasons).toEqual(["expired", "timeout"]);
    expect(isPermanentLibraryMediaFailure("expired")).toBe(true);
    expect(isPermanentLibraryMediaFailure("timeout")).toBe(false);
    expect(isPermanentLibraryMediaFailure("made_up")).toBe(false);
  });

  it("a stored read failure: class kept, `transient` derived (never trusted), a malformed next try dropped", () => {
    const meta = (failure: unknown) => ({
      importRead: { status: "not_read", suggestedActions: [], failure },
    });
    expect(
      readLibraryItemRead(
        meta({
          class: "unavailable",
          transient: false,
          nextAttemptAt: "2026-10-16T10:00:00.000Z",
        })
      ).failure
    ).toEqual({
      class: "unavailable",
      transient: true,
      nextAttemptAt: "2026-10-16T10:00:00.000Z",
    });
    expect(
      readLibraryItemRead(
        meta({ class: "refused", transient: true, nextAttemptAt: "x" })
      ).failure
    ).toEqual({ class: "refused", transient: false });
    expect(
      readLibraryItemRead(
        meta({ class: "refused", nextAttemptAt: "2026-10-16T10:00:00.000Z" })
      ).failure
    ).toEqual({
      class: "refused",
      transient: false,
      nextAttemptAt: "2026-10-16T10:00:00.000Z",
    });
    expect(
      readLibraryItemRead(meta({ class: "nope" })).failure
    ).toBeUndefined();
  });
});
