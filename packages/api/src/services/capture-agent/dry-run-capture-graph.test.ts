/**
 * `validate: true` runs the SAME preflight a real submit runs.
 *
 * Behaviour: `dryRunCaptureGraph` reports an invalid property (via the shared
 * `preflightCaptureGraphOperations`), an unresolved profile, and an unknown
 * relation slug — writing nothing.
 *
 * One implementation: `submitCaptureGraph` must reach the property validator
 * ONLY through the exported preflight. Asserted on source: exactly ONE
 * `validateEntityCreateForProposal(` call in the file, and submit's body calls
 * `preflightCaptureGraphOperations(` and `buildCaptureGraphOperations(`. (This
 * cannot see a second validator in ANOTHER file; that is the dry-run test above.)
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const { resolveProfile, validateEntityCreateForProposal } = vi.hoisted(() => ({
  resolveProfile: vi.fn(async (slug: string) =>
    slug === "file" ? { id: "prof-file", defaultValues: {} } : null
  ),
  validateEntityCreateForProposal: vi.fn(async () => ({
    valid: false,
    errors: ["'storageKey' is required"],
  })),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  ProfileResolutionService: class {
    resolveProfile = resolveProfile;
    getEntityScope = async () => "workspace";
  },
  PropertyValidationService: class {
    validateEntityCreateForProposal = validateEntityCreateForProposal;
  },
}));

import { dryRunCaptureGraph } from "./submit-capture-graph.js";

const fakeDb = {
  query: {
    relationDefs: {
      findMany: async () => [
        {
          slug: "works_at",
          displayName: "Works at",
          description: null,
          workspaceId: null,
          uiHints: {},
          isDirectional: true,
        },
      ],
    },
  },
} as never;

describe("dryRunCaptureGraph", () => {
  it("reports an invalid property, an unresolved profile and an unknown slug — every problem at once", async () => {
    const out = await dryRunCaptureGraph(fakeDb, {
      userId: "u1",
      workspaceId: null,
      entities: [
        { ref: "f", profileSlug: "file", title: "Contract", properties: {} },
        { ref: "g", profileSlug: "ghost", title: "Nobody" },
      ],
      relations: [{ sourceRef: "f", targetRef: "g", type: "related_to" }],
    });

    expect(out.invalidEntities).toEqual([
      {
        label: "Contract",
        profileSlug: "file",
        errors: ["'storageKey' is required"],
      },
    ]);
    expect(out.unresolvedProfiles).toEqual([
      { label: "Nobody", profileSlug: "ghost" },
    ]);
    expect(out.relationsFailed).toHaveLength(1);
    expect(out.relationsFailed[0].reason).toMatch(
      /Unknown relation type: "related_to".*works_at/
    );
  });
});

describe("submitCaptureGraph and the dry run share ONE preflight", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "submit-capture-graph.ts"),
    "utf8"
  );

  it("has exactly one property-validator call site, reached through the export", () => {
    expect(src.match(/validateEntityCreateForProposal\(/g) ?? []).toHaveLength(
      1
    );
    const submitBody = src.slice(
      src.indexOf("export async function submitCaptureGraph(")
    );
    expect(submitBody.length).toBeGreaterThan(1000);
    expect(submitBody).toContain("await preflightCaptureGraphOperations(");
    expect(submitBody).toContain("await buildCaptureGraphOperations(");
  });
});
