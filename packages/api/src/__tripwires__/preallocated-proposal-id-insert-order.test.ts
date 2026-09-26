import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a pre-allocated proposal id must be INSERTED before it is handed
 * to any write door.
 *
 * THE CLASS (measured on the live pod 2026-09-12): `entities.source_proposal_id`
 * is a FOREIGN KEY to `proposals(id)` (migration 0107, alongside `documents`,
 * `relations`, `entity_facets`). A caller that mints the receipt id with
 * `randomUUID()` and stamps it onto the rows it is about to write — via
 * `ctx.governanceProposalId`, which `entities.create` / `relations` / facets all
 * read into `sourceProposalId` — has created a reference to a row that does not
 * exist yet. The FIRST insert dies with
 * `entities_source_proposal_id_fkey` and rolls the whole write back. That is
 * what took down every structured MCP `synap_capture` create.
 *
 * THE RULE, therefore: in any file that declares `const X = randomUUID()` and
 * later hands `X` to a write door as a proposal id, a proposal-INSERT call
 * carrying `id: X` must appear LEXICALLY EARLIER than that hand-off.
 *
 * DERIVED, NOT HAND-LISTED: the file set comes from a recursive walk of the API
 * source and the id variables come from the declarations themselves, so a new
 * caller joins this scan by EXISTING. A hand-written list is exactly how the
 * sibling guards in this repo went blind.
 *
 * COVERAGE BOUNDARY (stated, measured):
 *   - LEXICAL, single-file. It cannot see an id pre-allocated in one module and
 *     stamped in another, nor a runtime branch that skips the insert. The unit
 *     guard `submit-capture-graph.receipt-order.test.ts` covers the runtime
 *     order for the one caller that exists today.
 *   - It only recognises pre-allocation written as `const X = randomUUID();`.
 *     An id from a helper call is invisible here.
 *   - A file that stamps an id it received as a PARAMETER (the proposal-approval
 *     path passing `proposal.id`) is correctly out of scope: that row exists.
 */

const API_SRC = join(__dirname, "..");

/** Doors that read a caller-supplied proposal id onto a FK column. */
const STAMP_FIELDS = ["governanceProposalId", "sourceProposalId"];
/** Calls that actually INSERT a proposals row with a caller-chosen id. */
const INSERT_CALLS = [
  "createAutoApprovedProposal",
  "createEventBackedProposal",
  "createPendingProposal",
];

interface Finding {
  file: string;
  variable: string;
  stampIndex: number;
  insertIndex: number;
}

/** Recursive walk — a new file joins this scan by EXISTING, never by a list. */
function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tripwires__")
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      acc.push(full);
  }
  return acc;
}

function scan(): { findings: Finding[]; filesScanned: number } {
  const files = tsFiles(API_SRC).map((f) =>
    relative(API_SRC, f).split("\\").join("/")
  );

  const findings: Finding[] = [];
  for (const rel of files) {
    const src = readFileSync(join(API_SRC, rel), "utf8");
    if (!src.includes("randomUUID()")) continue;

    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*randomUUID\(\);/g)) {
      const variable = m[1]!;
      // Where is this id handed to a write door that puts it on a FK column?
      let stampIndex = -1;
      for (const field of STAMP_FIELDS) {
        const at = src.indexOf(`${field}: ${variable}`);
        if (at >= 0 && (stampIndex < 0 || at < stampIndex)) stampIndex = at;
      }
      if (stampIndex < 0) continue;

      // Where is the proposals row carrying this id inserted? The insert call
      // and its `id:` argument are matched TOGETHER so an unrelated `id: X`
      // elsewhere cannot satisfy the ordering.
      let insertIndex = -1;
      for (const call of INSERT_CALLS) {
        const re = new RegExp(
          `${call}\\(\\{[\\s\\S]{0,400}?\\bid:\\s*${variable}\\b`,
          "g"
        );
        for (const hit of src.matchAll(re)) {
          const at = hit.index ?? -1;
          if (at >= 0 && (insertIndex < 0 || at < insertIndex))
            insertIndex = at;
        }
      }
      findings.push({ file: rel, variable, stampIndex, insertIndex });
    }
  }
  return { findings, filesScanned: files.length };
}

describe("a pre-allocated proposal id is inserted before it is stamped onto FK rows", () => {
  const { findings, filesScanned } = scan();

  // NON-VACUITY. A glob that matched nothing, or a regex that stopped seeing
  // the pattern, would make every assertion below pass silently.
  it("the scan actually read the API source and found the known caller", () => {
    expect(filesScanned).toBeGreaterThan(200);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.file)).toContain(
      "services/capture-agent/submit-capture-graph.ts"
    );
    // Self-check: the scanner can still see its own hunted shape.
    const sample = "const zz = randomUUID();\ngovernanceProposalId: zz";
    expect(/const\s+(\w+)\s*=\s*randomUUID\(\);/.test(sample)).toBe(true);
  });

  /**
   * THE SHARPER HALF — guard the PRODUCERS, not just the ordering.
   *
   * `routers/entities/create.ts:1179` writes `sourceProposalId:
   * ctx.governanceProposalId` straight onto the entities row, and
   * `relations.ts` (×3) and `entities/facets.ts` do the same for their tables.
   * So EVERY producer of `governanceProposalId` is a producer of a
   * `source_proposal_id` FK value. Migration 0107 adds
   * `<t>_source_proposal_id_fkey` for EACH of `['entities','documents',
   * 'relations']` with no DEFERRABLE clause (checked immediately), and
   * `entity_facets` gets the same FK in 0174 — so documents and relations
   * written during the same materialization are at identical risk, and the
   * receipt insert must precede all of them, not just the first entity.
   *
   * There are exactly FOUR producers today and they differ in the ONE way that
   * matters: whether the row exists yet. This asserts the set, so a FIFTH
   * producer repeating the 2026-09-12 bug cannot land silently — it goes red by
   * EXISTING, with no list to forget to update.
   *
   * (2026-09-13, run-scoped reversibility: the text-lane capture receipt and
   * the two import apply paths became producers, so the rows they write carry
   * lineage a revert can check. Each reason below is asserted, not narrated.)
   */
  const KNOWN_PRODUCERS: Record<string, string> = {
    "routers/proposals/apply-approval.ts":
      "approval path — stamps `proposal.id`, a row loaded from the DB, so the FK target already exists.",
    "services/capture-agent/submit-capture-graph.ts":
      "pre-allocates the id, so it MUST insert the proposals row before building the ctx (the lexical case above enforces that).",
    "routers/capture.ts":
      "text-lane capture receipt — pre-allocates the id and inserts the row before building the materialize ctx (the lexical case enforces that).",
    "services/import-orchestrator.ts":
      "import apply / applyLarge — stamps `input.proposalId`, the analyze-time proposal `resolveApplyOperations` just loaded as PENDING, so the FK target exists.",
    "services/forms/direct-materialize.ts":
      "guest form DIRECT mode (Sites W4) — stamps `input.receiptId`, the gate's `autoApprovedProposalId`, which the gate returns only AFTER its receipt insert succeeded (absent when that insert failed), so the FK target exists.",
  };

  function producers(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const rel of tsFiles(API_SRC).map((f) =>
      relative(API_SRC, f).split("\\").join("/")
    )) {
      const src = readFileSync(join(API_SRC, rel), "utf8");
      const values: string[] = [];
      for (const m of src.matchAll(/governanceProposalId:\s*([\w.$]+)/g)) {
        const value = m[1]!;
        // Type positions (`governanceProposalId: string;`) are declarations,
        // not producers. Everything else assigns a real id onto a ctx.
        if (
          ["string", "undefined", "null", "number", "boolean"].includes(value)
        )
          continue;
        values.push(value);
      }
      if (values.length) found.set(rel, values);
    }
    return found;
  }

  it("governanceProposalId has exactly the known producers, each with a checkable reason", () => {
    const found = producers();
    // Non-vacuity: the scan still sees producers at all.
    expect(found.size).toBeGreaterThan(0);
    expect([...found.keys()].sort()).toEqual(
      Object.keys(KNOWN_PRODUCERS).sort()
    );

    // The approval producer's reason is CHECKABLE, not asserted in prose: the
    // value it stamps must be a property of an already-loaded row, never a
    // freshly minted uuid.
    expect(found.get("routers/proposals/apply-approval.ts")).toEqual([
      "proposal.id",
      "proposal.id",
    ]);

    // The capture producer's reason is checked by the lexical case below, which
    // requires its insert to precede the stamp.
    expect(
      found.get("services/capture-agent/submit-capture-graph.ts")
    ).toContain("captureProposalId");

    // Same for the text-lane receipt: a pre-allocated id the lexical case holds
    // to insert-before-stamp.
    expect(found.get("routers/capture.ts")).toEqual(["captureReceiptId"]);
    expect(
      findings.some(
        (f) =>
          f.file === "routers/capture.ts" && f.variable === "captureReceiptId"
      )
    ).toBe(true);

    // The import producer stamps the id of a proposal it READ, never a minted one.
    expect(found.get("services/import-orchestrator.ts")).toEqual([
      "input.proposalId",
      "input.proposalId",
    ]);

    // The guest-form producer stamps the gate's receipt id, never a minted one.
    expect(found.get("services/forms/direct-materialize.ts")).toEqual([
      "input.receiptId",
    ]);
  });

  it("every pre-allocated id has a proposals insert LEXICALLY BEFORE its first stamp", () => {
    const violations = findings.filter(
      (f) => f.insertIndex < 0 || f.insertIndex > f.stampIndex
    );
    expect(
      violations.map(
        (v) =>
          `${v.file}: '${v.variable}' is stamped onto a source_proposal_id FK at char ${v.stampIndex} but ` +
          (v.insertIndex < 0
            ? "NO proposals insert carries that id"
            : `its proposals insert is at char ${v.insertIndex} (after)`)
      )
    ).toEqual([]);
  });
});
