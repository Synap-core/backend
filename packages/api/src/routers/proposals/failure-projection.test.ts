/**
 * `data.failure.detail` NEVER reaches a USER-FACING read door.
 *
 * `detail` is the REDACTED raw executor error. Redaction is best-effort against
 * an arbitrary upstream body — what BOUNDS the audience is this projection.
 * Its one legitimate reader is `render-for-prompt.ts` (server-side prompt path).
 *
 * ## The door census, and how it is established
 *
 * `__tripwires__/proposal-class-reaches-read-doors.test.ts` already enumerates
 * the four proposal read doors. Only TWO of them serialize `data` at all:
 *
 *   | door                          | surfaces                              | projects `data` |
 *   |-------------------------------|---------------------------------------|-----------------|
 *   | `enrichProposalsForDisplay`   | tRPC list/get, Hub REST GET /:id      | YES (`{...row}`)|
 *   | `withProposalClass`           | Hub REST GET /proposals?view=full     | YES (`{...row}`)|
 *   | `toProposalBasic`             | REST view=basic, MCP summary          | NO (by design)  |
 *   | `collapseProposalsToClusters` | tRPC proposals.groups                 | NO              |
 *
 * Plus one door outside that census: MCP `synap_list_proposals` with
 * `detail:"full"`, which answers with raw service rows.
 *
 * The two PURE doors are asserted BEHAVIOURALLY below. The two DB-joined ones
 * (`display.ts`, the MCP handler) are asserted by SOURCE SCAN — the same
 * mechanism, for the same reason, as the projection-parity tripwires.
 *
 * ## STATED LIMITATION
 *
 * The source scan proves the projector is CALLED on the row those files
 * return; it does not prove no future line re-introduces an unprojected copy
 * of `data`. It is paired with the compile-time classification floor in
 * `failure-projection.ts`, which makes a NEW agent-only field a BUILD error
 * rather than a silent leak — the half a scan cannot cover.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  projectProposalDataForViewer,
  PROJECTED_FAILURE_FIELDS,
  AGENT_ONLY_FAILURE_FIELDS,
} from "./failure-projection.js";
import {
  toProposalBasic,
  withProposalClass,
} from "../hub-protocol/rest/_codecs/proposal.js";

const SECRET = "Bearer ohno-this-is-the-raw-upstream-body";

const FAILED_ROW = {
  id: "p1",
  workspaceId: null,
  targetType: "capability",
  targetId: "t1",
  proposalType: "capability.run",
  status: "approval_failed",
  correlationId: null,
  sessionId: null,
  agentUserId: null,
  data: {
    summary: "Run the thing",
    failure: {
      errorClass: "missing_field",
      providerRef: "google",
      missingFields: ["apiKey"],
      detail: SECRET,
    },
  },
} as const;

/** Does this serialized payload contain the agent-only text anywhere? */
const leaks = (value: unknown) => JSON.stringify(value).includes(SECRET);

describe("the classification floor", () => {
  it("classifies every failure field as PROJECTED or AGENT_ONLY", () => {
    // The compile-time floor in the module is the real guard (an unclassified
    // field makes `_Classified` resolve to `never` and the BUILD stops). This
    // asserts the two lists are disjoint and non-empty, so the floor cannot be
    // satisfied by classifying a field as both.
    const projected = new Set<string>(PROJECTED_FAILURE_FIELDS);
    const agentOnly = new Set<string>(AGENT_ONLY_FAILURE_FIELDS);
    expect(projected.size).toBeGreaterThan(0);
    expect(agentOnly.size).toBeGreaterThan(0);
    for (const field of agentOnly) expect(projected.has(field)).toBe(false);
    expect(agentOnly.has("detail")).toBe(true);
  });
});

describe("projectProposalDataForViewer", () => {
  it("strips `detail` and KEEPS every projected field", () => {
    const out = projectProposalDataForViewer(FAILED_ROW.data) as {
      summary: string;
      failure: Record<string, unknown>;
    };
    expect(leaks(out)).toBe(false);
    expect(out.failure).not.toHaveProperty("detail");
    // The affordance the client derives must survive — a strip that took the
    // class with it would trade a leak for a dead end.
    expect(out.failure.errorClass).toBe("missing_field");
    expect(out.failure.providerRef).toBe("google");
    expect(out.failure.missingFields).toEqual(["apiKey"]);
    expect(out.summary).toBe("Run the thing");
  });

  it("never mutates its input", () => {
    const data = structuredClone(FAILED_ROW.data) as {
      failure: { detail?: string };
    };
    projectProposalDataForViewer(data);
    expect(data.failure.detail).toBe(SECRET);
  });

  it("returns the SAME reference when there is nothing to strip", () => {
    const clean = { summary: "x" };
    expect(projectProposalDataForViewer(clean)).toBe(clean);
    const noDetail = { failure: { errorClass: "auth" } };
    expect(projectProposalDataForViewer(noDetail)).toBe(noDetail);
  });

  it("tolerates every non-object shape `data` can hold", () => {
    expect(projectProposalDataForViewer(null)).toBeNull();
    expect(projectProposalDataForViewer(undefined)).toBeUndefined();
    expect(projectProposalDataForViewer("str")).toBe("str");
    const arr = [1, 2];
    expect(projectProposalDataForViewer(arr)).toBe(arr);
    const weird = { failure: "not an object" };
    expect(projectProposalDataForViewer(weird)).toBe(weird);
  });
});

describe("door — withProposalClass (Hub REST view=full)", () => {
  it("does not leak `detail`", () => {
    const out = withProposalClass({ ...FAILED_ROW });
    expect(leaks(out)).toBe(false);
    expect(
      (out.data as { failure: Record<string, unknown> }).failure
    ).not.toHaveProperty("detail");
  });

  it("still stamps the class (the strip did not break its own contract)", () => {
    const out = withProposalClass({ ...FAILED_ROW });
    expect(out.class).toBe("ephemeral");
  });

  /**
   * NEGATIVE CONTROL, in-file: the very same row, projected by the pre-fix
   * spread, DOES leak. Without this the two assertions above would also pass
   * against a row that never carried a detail in the first place.
   */
  it("NEGATIVE CONTROL — the unprojected spread leaks it", () => {
    const unprojected = { ...FAILED_ROW, class: "ephemeral" };
    expect(leaks(unprojected)).toBe(true);
  });
});

describe("SEAM — the Hub `view=full` chain as the router actually composes it", () => {
  /**
   * `hub-protocol/proposals.ts` wraps my projection in ANOTHER `data` rewriter
   * (`withProposalSetup`, which strips secret install params). Two projections
   * over one payload is precisely where one can reinstate what the other
   * removed — if the outer one re-read the ORIGINAL row instead of the
   * projected object, the detail would come back and both unit tests would
   * still pass. So the SEAM is driven, not the ends.
   */
  it("composes without reinstating the agent-only detail", async () => {
    const { withProposalSetup, resolveProposalSetups } =
      await import("../../services/proposals/proposal-setup.js");
    const row = { ...FAILED_ROW } as unknown as Record<string, unknown>;
    const setups = await resolveProposalSetups([row], "user-1");
    const out = withProposalSetup(
      withProposalClass(row) as unknown as Record<string, unknown>,
      setups
    );
    expect(leaks(out)).toBe(false);
    // NON-VACUITY: the chain really did produce a row with a failure on it.
    expect(
      (out.data as { failure?: Record<string, unknown> }).failure?.errorClass
    ).toBe("missing_field");
  });

  it("SOURCE: the outer wrapper is fed the PROJECTED row, not the raw one", () => {
    const src = readSrc("../hub-protocol/proposals.ts");
    expect(src).toContain("withProposalSetup(");
    expect(src).toContain("withProposalClass(row)");
    // The failure mode: `withProposalSetup(row, setups)` — the raw row.
    expect(src).not.toMatch(/withProposalSetup\(\s*row\s*,/);
  });
});

describe("door — toProposalBasic (REST view=basic, MCP summary)", () => {
  it("carries no `data` at all, so it cannot leak", () => {
    const basic = toProposalBasic({ ...FAILED_ROW });
    expect(leaks(basic)).toBe(false);
    expect(basic).not.toHaveProperty("data");
  });
});

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("door — enrichProposalsForDisplay (tRPC list/get, REST GET /:id)", () => {
  const src = readSrc("./display.ts");

  it("NON-VACUITY: the scan can see the spread it is judging", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("return rows.map((row, idx) => {");
  });

  it("spreads the PROJECTED row, never the raw one", () => {
    expect(src).toContain("...projectProposalRowForViewer(row),");
    // The pre-fix spread must be gone from the returned object.
    expect(src).not.toMatch(/return \{\s*\.\.\.row,/);
  });

  it("projects the `request.data` copy it also answers with", () => {
    expect(src).toContain(
      "let enrichedData = projectProposalDataForViewer(request.data);"
    );
  });
});

describe("door — MCP synap_list_proposals detail:'full'", () => {
  const src = readSrc("../mcp/handlers/read.ts");

  it("NON-VACUITY: the scan can see the handler it is judging", () => {
    expect(src).toContain("synap_list_proposals:");
    expect(src).toContain('(args.detail as string) === "full"');
  });

  it("projects before answering, and no longer returns the raw result", () => {
    expect(src).toContain("projectProposalRowForViewer");
    // The pre-fix line was a bare passthrough.
    expect(src).not.toContain(
      'if ((args.detail as string) === "full") return ok(result);'
    );
  });
});

describe("the ONE legitimate reader keeps it", () => {
  const src = readSrc("./render-for-prompt.ts");

  it("render-for-prompt renders the detail (agent-only prompt path)", () => {
    expect(src).toContain("failure.detail");
    // …and says so, so the next reader does not "helpfully" strip it.
    expect(src).toContain("redacted");
  });

  it("it does NOT go through the viewer projection (it is not a client answer)", () => {
    expect(src).not.toContain("projectProposalDataForViewer");
    expect(src).not.toContain("projectProposalRowForViewer");
  });
});

describe("the classifier narrows the setup contract DUCK-TYPED, never by class", () => {
  /**
   * This guard used to assert the classifier imported NOTHING from
   * `setup-required-error.ts`, and that mechanism is what caused a real leak:
   * forbidden from importing `isSetupRequiredLike`, the classifier wrote its
   * own wider copy that accepted ALL ten failure classes, so any error carrying
   * `failureClass` + `missingFields` had its RAW message shown verbatim.
   *
   * The invariant was never "do not import". It is "do not narrow with
   * `instanceof`" — the error may have crossed a serialization hop (pg-boss
   * payload, Hub REST body, `structuredClone`), after which `instanceof`
   * silently answers `false` and the classifier falls back to a raw sentence.
   * Importing the PREDICATE is what keeps one rule; importing the CLASS to test
   * against is what breaks across the hop.
   */
  const CLASSIFIER = "./failure-classification.ts";

  it("never uses `instanceof` against the error class", () => {
    const src = readSrc(CLASSIFIER);
    expect(src).not.toMatch(/instanceof\s+SetupRequiredError/);
    // NON-VACUITY: the file DOES use `instanceof` elsewhere (TRPCError), so a
    // scan that saw nothing at all would be the bug, not the proof.
    expect(src).toMatch(/instanceof\s+TRPCError/);
  });

  it("imports only the duck-typed PREDICATE, not the class", () => {
    const imports = readSrc(CLASSIFIER)
      .split("\n")
      .filter((line) =>
        /^\s*import\b|^\s*(const|let)\s+.*\brequire\(|from\s+["']/.test(line)
      )
      .join("\n");
    // Scan the IMPORT STATEMENTS, not the prose: the docblock names the class
    // on purpose, and a whole-file `toContain` would trip on that comment —
    // the comment-scanning trap `.claude/rules/guards-and-tests.md` documents.
    expect(imports).toContain("isSetupRequiredLike");
    expect(imports).not.toContain("SetupRequiredError");
    // NON-VACUITY: the import scan is not empty and DOES see other real imports.
    expect(imports.split("\n").length).toBeGreaterThan(2);
    expect(imports).toContain("@synap-core/types/failures");
  });

  it("still reads the contract's field names", () => {
    const src = readSrc(CLASSIFIER);
    expect(src).toContain("failureClass");
    expect(src).toContain("missingFields");
    expect(src).toContain("connection");
  });
});
