/**
 * fb1020: a capture's dry run says what each kind DOES model, not only which
 * keys it does not. Driven through the real door (`dryRunCaptureGraph` → the
 * shared `preflightCaptureGraphOperations`) with the REAL
 * `PropertyValidationService`; only the profile lookup is stubbed, so the
 * fields read here are the validator's own `modeled` list.
 *
 * Shapes from the live pod (2026-10-20): `offer` prefixes every field, so
 * `price` / `description` came back unmodeled with no suggestion; `decision`
 * caps `summary` at 500 characters, which rejected a whole 8-entity capture.
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

const def = (
  slug: string,
  valueType: string,
  constraints: Record<string, unknown> | null = null
) => ({
  slug,
  valueType,
  constraints,
  required: false,
  defaultValue: null,
  displayOrder: 0,
  isLifecycle: false,
});

effectiveProps.set("offer", [
  def("offer-status", "string", { enum: ["draft", "active"] }),
  def("offer-summary", "string"),
]);
effectiveProps.set("decision", [def("summary", "string", { maxLength: 500 })]);
effectiveProps.set("finding", []);

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

describe("capture dry run — what each kind models", () => {
  it("lists every resolved kind's fields beside the unmodeled keys, with a suggestion for a bare key", async () => {
    const out = await run([
      {
        ref: "o",
        profileSlug: "offer",
        title: "Audit",
        properties: { summary: "x", price: 900 },
      },
      {
        ref: "f",
        profileSlug: "finding",
        title: "No severity",
        properties: { severity: "high" },
      },
    ]);

    expect(out.unmodeledProperties).toEqual([
      {
        label: "Audit",
        profileSlug: "offer",
        unmodeled: [
          { key: "summary", didYouMean: "offer-summary" },
          { key: "price" },
        ],
      },
      {
        label: "No severity",
        profileSlug: "finding",
        unmodeled: [{ key: "severity" }],
      },
    ]);
    expect(out.modeledFields).toEqual({
      offer: [
        { key: "offer-status", type: "string", options: ["draft", "active"] },
        { key: "offer-summary", type: "string" },
      ],
      // A kind with no fields says so — an empty list, never an absent key.
      finding: [],
    });
  });

  it("shows a limit before the write, and names the key when the value breaks it", async () => {
    const out = await run([
      {
        ref: "d",
        profileSlug: "decision",
        title: "Ship it",
        properties: { summary: "y".repeat(612) },
      },
    ]);
    expect(out.modeledFields.decision).toEqual([
      { key: "summary", type: "string", maxLength: 500 },
    ]);
    expect(out.invalidEntities).toEqual([
      {
        label: "Ship it",
        profileSlug: "decision",
        errors: [
          "Property 'summary': String length 612 is greater than maximum 500",
        ],
      },
    ]);
  });
});
