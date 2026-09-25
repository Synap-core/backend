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

const h = vi.hoisted(() => ({ type: "markdown" }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    EntityBodyService: class {
      getBytes = async () => ({ kind: "bytes", buffer: Buffer.from(BODY) });
    },
  };
});

vi.mock("../utils/document-edit-access.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadReadableDocument: vi.fn(async () => ({ id: "doc-1", type: h.type })),
    canEditDocument: vi.fn(async () => true),
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
