/**
 * A GOVERNED capture must not lose the user's file.
 *
 * The regression this pins: `stageSourceBlob`/`attachSourceBlob`/
 * `discardSourceBlob` were built as a three-phase substrate and then left with
 * ZERO callers — the propose branch of `capture.execute` returned before any
 * blob handling at all, so choosing "review before saving" silently threw the
 * file away. Two halves have to hold, and each is tested here:
 *
 *   1. DATA — the staged reference actually rides on a proposal this call files,
 *      on the ONE whose approval materializes the entity the file belongs to,
 *      and it round-trips back out through `stagedSourceBlobFrom` (the reader
 *      the approval/rejection sites narrow through). If nothing can carry it,
 *      the caller is told so it can discard rather than orphan the bytes.
 *   2. WIRING — the approval and rejection sites actually CALL the substrate.
 *      A data contract nobody invokes is exactly the defect that produced this
 *      test, and no amount of unit-testing the helpers can see it, so the wiring
 *      is asserted against the source of the four call sites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const checkPermissionOrProposeMock = vi.fn();
vi.mock("../permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) =>
    checkPermissionOrProposeMock(...a),
}));

vi.mock("@synap/governance-policy", () => ({
  deriveGatePairFromOperations: () => ({
    subjectType: "entity",
    action: "create",
  }),
}));

import { fileAnchoredCaptureProposals } from "../capture-propose.js";
import { stagedSourceBlobFrom } from "../store-entity-source-blob.js";

const STAGED = {
  documentId: "doc-9",
  storageKey: "users/u1/entity/cap-1.pdf",
  storageUrl: "https://storage.example/cap-1.pdf",
  size: 1234,
  mimeType: "application/pdf",
  filename: "contract.pdf",
};

const baseParams = {
  userId: "u1",
  workspaceId: "ws-1",
  correlationId: "cap-1",
  relations: [],
  resolveRelationType: (t: string) => t,
};

/** Every `data` object handed to the gate, in call order. */
function filedData(): Array<Record<string, unknown>> {
  return checkPermissionOrProposeMock.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data
  );
}

describe("governed capture carries its source file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    checkPermissionOrProposeMock.mockImplementation(() =>
      Promise.resolve({
        proposalId: `p-${++n}`,
        proposalType: "entity.update",
        reviewUrl: "https://pod/open/p",
      })
    );
  });

  it("puts the reference on the COMPOSITE create when the capture creates new entities", async () => {
    const res = await fileAnchoredCaptureProposals({
      ...baseParams,
      entities: [
        {
          tempId: "anchor",
          profileSlug: "person",
          title: "Ada",
          existingEntityId: "e-anchor",
          properties: { email: "ada@example.com" },
        },
        { tempId: "t1", profileSlug: "note", title: "New note" },
      ],
      sourceFile: STAGED,
    });

    expect(res.sourceFileAttached).toBe(true);
    const composite = filedData().find((d) => Array.isArray(d.operations));
    expect(composite).toBeDefined();
    // Round-trips through the ONE reader the approval path uses.
    expect(stagedSourceBlobFrom(composite)).toEqual(STAGED);

    // …and NOT on the update proposal — a file attached twice would be two
    // entities claiming the same document.
    const update = filedData().find((d) => !Array.isArray(d.operations));
    expect(stagedSourceBlobFrom(update)).toBeUndefined();
  });

  it("puts the reference on the first entity.update when nothing new is created", async () => {
    const res = await fileAnchoredCaptureProposals({
      ...baseParams,
      entities: [
        {
          tempId: "anchor",
          profileSlug: "person",
          title: "Ada",
          existingEntityId: "e-anchor",
          properties: { email: "ada@example.com" },
        },
        {
          tempId: "t2",
          profileSlug: "person",
          title: "Grace",
          existingEntityId: "e-2",
          properties: { email: "grace@example.com" },
        },
      ],
      sourceFile: STAGED,
    });

    expect(res.sourceFileAttached).toBe(true);
    const datas = filedData();
    expect(stagedSourceBlobFrom(datas[0])).toEqual(STAGED);
    // Exactly ONE carrier.
    expect(datas.filter((d) => stagedSourceBlobFrom(d))).toHaveLength(1);
    // `data.id` is what the entity/update executor attaches to.
    expect(datas[0].id).toBe("e-anchor");
  });

  it("reports sourceFileAttached:false when NO proposal could carry it (caller must discard)", async () => {
    const res = await fileAnchoredCaptureProposals({
      ...baseParams,
      // An existing-entity op with no properties and no description files no
      // proposal at all — so there is nothing to hang the file on.
      entities: [
        {
          tempId: "anchor",
          profileSlug: "person",
          title: "Ada",
          existingEntityId: "e-anchor",
        },
      ],
      sourceFile: STAGED,
    });

    expect(res.proposalIds).toHaveLength(0);
    expect(res.sourceFileAttached).toBe(false);
  });

  it("files byte-identical proposals when no file is supplied", async () => {
    const res = await fileAnchoredCaptureProposals({
      ...baseParams,
      entities: [{ tempId: "t1", profileSlug: "note", title: "New note" }],
    });
    expect(res.sourceFileAttached).toBe(false);
    expect(filedData().every((d) => !stagedSourceBlobFrom(d))).toBe(true);
  });
});

describe("stagedSourceBlobFrom", () => {
  it("ignores data with no sourceFile, and refuses a ref missing its identifiers", () => {
    expect(stagedSourceBlobFrom(undefined)).toBeUndefined();
    expect(stagedSourceBlobFrom({ operations: [] })).toBeUndefined();
    // A ref with no storageKey cannot be discarded, so it must not be trusted
    // as one — reporting it would promise a cleanup that cannot happen.
    expect(
      stagedSourceBlobFrom({ sourceFile: { documentId: "d" } })
    ).toBeUndefined();
    expect(
      stagedSourceBlobFrom({ sourceFile: { storageKey: "k" } })
    ).toBeUndefined();
  });
});

/**
 * Source-scan tripwire. The substrate shipped once with zero callers; a helper
 * test suite cannot see that, because the helpers pass either way. This reads
 * the four real call sites and asserts each names the function it must call.
 */
describe("the staging substrate is WIRED, not just built", () => {
  const SRC = join(__dirname, "../..");
  const read = (p: string) => readFileSync(join(SRC, p), "utf-8");

  it("capture.execute's propose branch stages the blob", () => {
    const s = read("routers/capture.ts");
    expect(s).toContain("stageSourceBlob({");
    // …and hands it to the propose door rather than dropping it.
    expect(s).toContain("sourceFile: stagedCaptureFile");
    // …and discards it when no proposal took it.
    expect(s).toContain("discardSourceBlob({");
  });

  it("the composite approval branch attaches it", () => {
    const s = read("routers/proposals/apply-approval.ts");
    expect(s).toContain("stagedSourceBlobFrom(payload)");
    expect(s).toContain("attachSourceBlob({");
  });

  it("the entity/update executor attaches it", () => {
    const s = read("routers/proposals/executors/entity.ts");
    expect(s).toContain("stagedSourceBlobFrom(innerData)");
    expect(s).toContain("attachSourceBlob({");
  });

  it("every terminal door in proposals.ts discards it", () => {
    const s = read("routers/proposals.ts");
    // DERIVED, not a literal count. `toBe(2)` used to live here, and it pinned
    // the miss: `withdraw` sets WITHDRAWN (pending-only, so no reject can ever
    // follow) and leaked its blob, while adding the third discard would have
    // turned this test RED for doing the right thing.
    //
    // The floor is the number of TERMINAL status writes this file makes — a new
    // door that ends a proposal without discarding drops the ratio below 1.
    // The authoritative, per-occurrence version of this invariant (across every
    // file, derived from the `ProposalStatus` enum itself) lives in
    // `__tripwires__/source-blob-ownership-and-terminal-discard.test.ts`.
    const terminalWrites = (
      s.match(/status: ProposalStatus\.(REJECTED|WITHDRAWN|EXPIRED)/g) ?? []
    ).length;
    const discards = s.split("discardProposalSourceBlob({").length - 1;
    expect(
      terminalWrites,
      "no terminal writes found — scan is blind"
    ).toBeGreaterThan(0);
    expect(discards).toBeGreaterThanOrEqual(terminalWrites);
  });
});
