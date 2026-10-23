/**
 * `planImportIdentities` — the four shapes measured on the live pod
 * (2026-10-23), invented names. Rows chosen to rule out wrong rules:
 *  - same LinkedIn URL → linked by SIGNAL, filled only where empty;
 *  - pod person with a name only → linked, flagged "matched by name";
 *  - pod person with an email only, row with a LinkedIn URL → no conflicting
 *    value of the row's type → linked by name (rules out "any strong signal
 *    on the candidate makes it a different person");
 *  - pod person with a DIFFERENT LinkedIn URL → created, `separate`;
 *  - one name twice in the file with two URLs → both created, the second
 *    `separate` (rules out "fold every same-name row");
 *  - a row with no strong signal is never `separate`.
 */
import { describe, it, expect } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  planImportIdentities,
  type PodIdentityCandidate,
} from "./import-identities.js";

const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;
const person = (
  ref: string,
  title: string,
  properties: Record<string, unknown>
): CompositeProposalOperation => ({
  op: "create_entity",
  profileSlug: "person",
  ref,
  title,
  properties,
  facets: [{ profileSlug: "contact" }],
});
const pod = (
  id: string,
  title: string,
  properties: Record<string, unknown>
): PodIdentityCandidate => ({ id, type: "person", title, properties });

const P_SAME = "11111111-1111-4111-8111-111111111111";
const P_NAME = "22222222-2222-4222-8222-222222222222";
const P_EMAIL = "33333333-3333-4333-8333-333333333333";
const P_OTHER = "44444444-4444-4444-8444-444444444444";

const OPS: CompositeProposalOperation[] = [
  person("t1", "Ada Quill", { linkedinUrl: li("ada-quill"), role: "CTO" }),
  person("t2", "Bram Oko", { linkedinUrl: li("bram-oko"), role: "Founder" }),
  person("t3", "Cyra Dell", { linkedinUrl: li("cyra-dell") }),
  person("t4", "Dov Ash", { linkedinUrl: li("dov-ash-2") }),
  person("t5", "Eli Twin", { linkedinUrl: li("eli-twin-1") }),
  person("t6", "Eli Twin", { linkedinUrl: li("eli-twin-2") }),
  person("t7", "Fay Name", { role: "Analyst" }),
  { op: "create_relation", type: "works_at", sourceRef: "t1", targetRef: "c1" },
];
const POD = new Map<string, PodIdentityCandidate[]>([
  [
    "person|ada quill",
    [pod(P_SAME, "Ada Quill", { linkedinUrl: li("ada-quill") })],
  ],
  ["person|bram oko", [pod(P_NAME, "Bram Oko", { phone: "" })]],
  [
    "person|cyra dell",
    [pod(P_EMAIL, "Cyra Dell", { email: "cyra@example.org" })],
  ],
  [
    "person|dov ash",
    [pod(P_OTHER, "Dov Ash", { linkedinUrl: li("dov-ash-1") })],
  ],
]);

const run = () =>
  planImportIdentities({
    operations: OPS,
    podCandidates: POD,
    signalHits: new Map(),
  });

const entityOp = (ops: CompositeProposalOperation[], ref: string) =>
  ops.find((o) => o.op === "create_entity" && o.ref === ref) as Extract<
    CompositeProposalOperation,
    { op: "create_entity" }
  >;

describe("planImportIdentities", () => {
  it("links a same-URL person by signal and fills only what it lacks", () => {
    const plan = run();
    expect(entityOp(plan.operations, "t1").existingEntityId).toBe(P_SAME);
    expect(plan.linkedBySignal.map((d) => d.ref)).toContain("t1");
    const fill = plan.operations.find(
      (o) => o.op === "update_entity" && o.entityId === P_SAME
    ) as Extract<CompositeProposalOperation, { op: "update_entity" }>;
    expect(fill.patch.properties).toEqual({ role: "CTO" });
  });

  it("links a name-only person and an email-only person by NAME, flagged", () => {
    const plan = run();
    expect(entityOp(plan.operations, "t2").existingEntityId).toBe(P_NAME);
    expect(entityOp(plan.operations, "t3").existingEntityId).toBe(P_EMAIL);
    expect(plan.matchedByName.map((d) => d.ref).sort()).toEqual(["t2", "t3"]);
    const fill = plan.operations.find(
      (o) => o.op === "update_entity" && o.entityId === P_EMAIL
    ) as Extract<CompositeProposalOperation, { op: "update_entity" }>;
    expect(fill.patch.properties).toEqual({ linkedinUrl: li("cyra-dell") });
  });

  it("a different LinkedIn URL, or a second same-name row with its own URL, is a separate person", () => {
    const plan = run();
    expect(entityOp(plan.operations, "t4").existingEntityId).toBeUndefined();
    expect(entityOp(plan.operations, "t5").existingEntityId).toBeUndefined();
    expect(entityOp(plan.operations, "t6").existingEntityId).toBeUndefined();
    expect(plan.identityResolutionByRef).toEqual({
      t4: { verb: "separate" },
      t6: { verb: "separate" },
    });
  });

  it("a row with no strong signal is never separate", () => {
    const plan = planImportIdentities({
      operations: [
        person("t1", "Gil Same", { linkedinUrl: li("gil-1") }),
        person("t2", "Gil Same", { role: "x" }),
      ],
      podCandidates: new Map(),
      signalHits: new Map(),
    });
    expect(plan.identityResolutionByRef).toEqual({});
    // Folded into the first row: one subject, one op.
    expect(
      plan.operations.filter((o) => o.op === "create_entity")
    ).toHaveLength(1);
  });
});
