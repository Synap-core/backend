/**
 * The USER read door `documents.get` takes `format` (W7a): `readable` returns
 * the body with every embed replaced by its fallback — the SAME markdown-core
 * rule the agent read uses — so a person's "Export ▸ Markdown" and an agent's
 * `format: readable` can never disagree.
 *
 * Driven through the real router; the access helpers and the body reader are
 * stubbed (they have their own suites). What this pins is the seam: the stored
 * body reaches `readableMarkdown` and the result reaches the caller.
 */

import { describe, it, expect, vi } from "vitest";

const BODY = [
  "Intro.",
  "",
  ':::synap-cell{cellKey="chart-bar"}',
  "```json",
  '{"profileSlug":"task"}',
  "```",
  "",
  "Tasks pile up in **Review**.",
  ":::",
  "",
  ':::synap-entity{id="11111111-1111-4111-8111-111111111111"}',
  ":::",
].join("\n");

const h = vi.hoisted(() => ({
  type: "markdown",
  mimeType: null as string | null,
  storageKey: null as string | null,
  /** Every body read the door asked for (3 Nov 2026: a 126 MB video each). */
  bodyReads: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    EntityBodyService: class {
      getBytes = async () => {
        h.bodyReads += 1;
        return { kind: "bytes", buffer: Buffer.from(BODY) };
      };
    },
  };
});

vi.mock("../utils/document-edit-access.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadReadableDocument: vi.fn(async () => ({
      id: "doc-1",
      type: h.type,
      mimeType: h.mimeType,
      storageKey: h.storageKey,
      contentRevision: 3,
      workingState: "AAEC//8=",
      workingStateRevision: 3,
    })),
    canEditDocument: vi.fn(async () => ({ allowed: true, reason: null })),
  };
});

const { documentsRouter } = await import("./documents.js");
const caller = documentsRouter.createCaller({
  userId: "user-1",
  authenticated: true,
  workspaceId: null,
} as never);

describe("documents.get — format", () => {
  it("raw (default) returns the stored body byte-for-byte", async () => {
    const out = await caller.get({ documentId: "doc-1" });
    expect(out.content).toBe(BODY);
    expect(out.format).toBe("raw");
  });

  it("readable replaces each embed by its fallback, else its catalog/noun label", async () => {
    const out = await caller.get({ documentId: "doc-1", format: "readable" });
    expect(out.format).toBe("readable");
    expect(out.content).not.toContain(":::");
    expect(out.content).not.toContain("profileSlug");
    expect(out.content).toContain("Intro.");
    expect(out.content).toContain("Tasks pile up in **Review**.");
    expect(out.content).toMatch(/\*Entity\*$/);
  });

  it("a binary body has no readable form: refused, never returned raw", async () => {
    h.type = "pdf";
    await expect(
      caller.get({ documentId: "doc-1", format: "readable" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    h.type = "markdown";
  });
});

describe("documents.get — the row it returns", () => {
  it("never carries the Yjs working-state dump: no reader needs it", async () => {
    const out = await caller.get({ documentId: "doc-1" });
    expect(out.document).not.toHaveProperty("workingState");
    expect(out.document).toMatchObject({ id: "doc-1", contentRevision: 3 });
  });
});

describe("documents.get — stored bytes that are not text are never downloaded", () => {
  function stored(type: string, mimeType: string | null) {
    h.type = type;
    h.mimeType = mimeType;
    h.storageKey = "files/ws/blob";
    h.bodyReads = 0;
  }
  function reset() {
    h.type = "markdown";
    h.mimeType = null;
    h.storageKey = null;
  }

  it("a video: no download, content left out on purpose, the file door named", async () => {
    stored("file", "video/mp4");
    const out = await caller.get({ documentId: "doc-1" });
    expect(h.bodyReads).toBe(0);
    expect(out.content).toBe("");
    expect(out).toMatchObject({
      contentOmitted: "binary",
      fileUrlPath: "/api/files/documents/doc-1/url",
    });
    // Its metadata still arrives.
    expect(out.document).toMatchObject({ id: "doc-1", mimeType: "video/mp4" });
    reset();
  });

  it("a video asked `readable` is refused, still without a download", async () => {
    stored("file", "video/mp4");
    await expect(
      caller.get({ documentId: "doc-1", format: "readable" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.bodyReads).toBe(0);
    reset();
  });

  it("a text file and a PDF are read as today", async () => {
    stored("file", "text/csv");
    const csv = await caller.get({ documentId: "doc-1" });
    expect(h.bodyReads).toBe(1);
    expect(csv.content).toBe(BODY);
    expect(csv).not.toHaveProperty("contentOmitted");

    stored("pdf", "application/pdf");
    const pdf = await caller.get({ documentId: "doc-1" });
    expect(h.bodyReads).toBe(1);
    expect(pdf.content).toBe(Buffer.from(BODY).toString("base64"));
    expect(pdf).not.toHaveProperty("contentOmitted");
    reset();
  });
});
