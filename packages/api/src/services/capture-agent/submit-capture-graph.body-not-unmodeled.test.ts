/**
 * A capture entity's `content` is its BODY (a linked document, or inline
 * content), not a property key the caller invented — so the preflight must not
 * report it under `unmodeledProperties` (tickets 7b49aaae / 32d9b7e8).
 *
 * Driven through the real door (`dryRunCaptureGraph` → the shared
 * `preflightCaptureGraphOperations`) with the REAL `PropertyValidationService`;
 * only the profile lookup is stubbed, so the validator's own unmodeled report
 * is what the assertion reads.
 */

import { describe, it, expect, vi } from "vitest";

const { effectiveProps } = vi.hoisted(() => ({
  effectiveProps: new Map<string, unknown[]>(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  ProfileResolutionService: class {
    resolveProfile = async (slug: string) =>
      effectiveProps.has(slug) ? { id: slug, defaultValues: {} } : null;
    getEffectiveProperties = async (profileId: string) =>
      effectiveProps.get(profileId) ?? [];
    getEntityScope = async () => "workspace";
  },
}));

import { dryRunCaptureGraph } from "./submit-capture-graph.js";

const def = (slug: string, required = false) => ({
  slug,
  valueType: "string",
  constraints: null,
  required,
  defaultValue: null,
  displayOrder: 0,
  isLifecycle: false,
});

effectiveProps.set("note", [def("status")]);
effectiveProps.set("article", [def("content", true)]);

const fakeDb = {
  query: { relationDefs: { findMany: async () => [] } },
} as never;

const run = (entities: Parameters<typeof dryRunCaptureGraph>[1]["entities"]) =>
  dryRunCaptureGraph(fakeDb, {
    userId: "u1",
    workspaceId: null,
    entities,
    relations: [],
  });

describe("capture preflight — the body is not an unmodeled property", () => {
  it("does not report `content` for a profile that does not model it, but still reports an invented key", async () => {
    const out = await run([
      {
        ref: "n",
        profileSlug: "note",
        title: "Meeting notes",
        content: "A long body that becomes the linked document.",
        properties: { stauts: "open" },
      },
    ]);
    expect(out.invalidEntities).toEqual([]);
    expect(out.unmodeledProperties).toEqual([
      {
        label: "Meeting notes",
        profileSlug: "note",
        unmodeled: [expect.objectContaining({ key: "stauts" })],
      },
    ]);
  });

  it("a profile that REQUIRES `content` is satisfied by the body", async () => {
    const out = await run([
      { ref: "a", profileSlug: "article", title: "Essay", content: "Body." },
    ]);
    expect(out.invalidEntities).toEqual([]);
    expect(out.unmodeledProperties).toEqual([]);
  });

  it("a `content` key written in `properties` on a profile that does not model it still reports", async () => {
    const out = await run([
      {
        ref: "n",
        profileSlug: "note",
        title: "Inline",
        properties: { content: "x" },
      },
    ]);
    expect(out.unmodeledProperties).toEqual([
      { label: "Inline", profileSlug: "note", unmodeled: [{ key: "content" }] },
    ]);
  });
});
