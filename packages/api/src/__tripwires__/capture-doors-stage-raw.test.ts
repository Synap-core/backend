/**
 * TRIPWIRE — every capture door keeps its RAW input through the one raw door
 * (founder decision 2026-09-14: the raw capture is always stored; a redo never
 * removes it). A truncated `proposal.data.rawSource` is NOT the raw.
 *
 * THE SET IS DERIVED, never hand-listed: every non-test source file under
 * `src/` that CALLS a capture materialization door —
 *   `submitCaptureGraph(`        (hub graph, MCP graph lane, webhooks, verbs, rerun)
 *   `fileAnchoredCaptureProposals(` (capture.execute's propose mode)
 *   `proposalType: "capture.graph"` / `proposalType: "import.graph"` (receipts
 *   and import proposals written directly)
 * — must also call a raw door (`stageIntakeSource(`, `stageCaptureSources(`,
 * `recordStructureIntake(`, `recordImportIntake(`, `stageExecuteSources(`), or
 * sit on the EXEMPT list below with its reason. A new door joins the scan by
 * existing.
 *
 * WHAT IT CANNOT SEE (measured by construction):
 *  - Granularity is the FILE, not the call site: a second door added to a file
 *    that already stages elsewhere passes. `capture.execute` gets call-site
 *    pins below because it holds three writers in one procedure.
 *  - That the staged ids REACH the receipt (`data.sourceDocumentIds`) at doors
 *    other than capture.execute — behaviour is pinned per door in their tests.
 *  - A door that materializes through a path none of the four patterns name
 *    (e.g. a raw `db.insert(proposals)`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOOR_CALL =
  /\bsubmitCaptureGraph\(|\bfileAnchoredCaptureProposals\(|proposalType:\s*"(?:capture|import)\.graph"/;
const RAW_DOOR =
  /\b(?:stageIntakeSource|stageCaptureSources|recordStructureIntake|recordImportIntake|stageExecuteSources)\(/;

/** Files that call a door and keep no raw BY DESIGN — each with its reason. */
const EXEMPT: Record<string, string> = {
  "services/capture-agent/submit-capture-graph.ts":
    "the graph door itself: it RECEIVES `sourceDocumentIds` from its callers, which are scanned",
  "utils/capture-propose.ts":
    "the propose helper: it RECEIVES `sourceDocumentIds` from capture.execute, which stages",
  "services/focus-sessions/rerun-session.ts":
    "replays a raw that is ALREADY staged, and forwards its id (`sourceDocumentIds: [source.sourceDocumentId]`)",
  "services/connector-import-bridge.ts":
    "connection sync — wave 2 (founder: keep a COPY of each provider record); out of wave 1 scope",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "node_modules" || name === "__tests__" ? [] : walk(full);
    }
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** Comments name the doors in prose; only code counts. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const doors = walk(SRC)
  .map((file) => ({
    rel: relative(SRC, file),
    code: stripComments(readFileSync(file, "utf8")),
  }))
  .filter((f) => DOOR_CALL.test(f.code));

describe("every capture door keeps its raw through the one raw door", () => {
  it("the scan still sees the capture doors (non-vacuity + literal self-check)", () => {
    // Measured 2026-09-14: 13 files. Fewer than 10 means the walk or the pattern broke.
    expect(doors.length).toBeGreaterThanOrEqual(10);
    for (const known of [
      "routers/capture.ts",
      "routers/mcp/handlers/capture.ts",
      "routers/hub-protocol/rest/capture.ts",
      "routers/webhooks-inbound.ts",
      "services/calcom/run-cal-backfill.ts",
      "services/capabilities/builtin-verbs.ts",
      "services/import/structuring.ts",
    ]) {
      expect(doors.map((d) => d.rel)).toContain(known);
    }
    expect(DOOR_CALL.test("await submitCaptureGraph({")).toBe(true);
    expect(DOOR_CALL.test('proposalType: "import.graph",')).toBe(true);
    expect(DOOR_CALL.test("// plugs into `submitCaptureGraph({`")).toBe(true);
    expect(
      DOOR_CALL.test(stripComments("// plugs into `submitCaptureGraph({`"))
    ).toBe(false);
    expect(RAW_DOOR.test("const s = await stageCaptureSources({")).toBe(true);
    expect(RAW_DOOR.test("stageCaptureSources")).toBe(false);
  });

  it("no door files a capture without staging its raw (or a stated exemption)", () => {
    const unstaged = doors
      .filter((d) => !RAW_DOOR.test(d.code) && !(d.rel in EXEMPT))
      .map((d) => d.rel);
    expect(unstaged).toEqual([]);
  });

  it("every exemption is still a door and still keeps no raw — no stale pass", () => {
    const byRel = new Map(doors.map((d) => [d.rel, d]));
    for (const rel of Object.keys(EXEMPT)) {
      expect(byRel.has(rel), `${rel} is no longer a door`).toBe(true);
      expect(
        RAW_DOOR.test(byRel.get(rel)!.code),
        `${rel} now stages — drop its exemption`
      ).toBe(false);
    }
  });
});

describe("capture.execute keeps its raw before anything is filed", () => {
  const src = readFileSync(join(SRC, "routers/capture.ts"), "utf8");
  const start = src.indexOf("  execute: podProcedure");
  const end = src.indexOf("  executeWithSchema: podProcedure", start);
  const slice = src.slice(start, end);
  const at = (needle: string) => {
    const i = slice.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it("stages once, after the run room is known, before the propose, gate and receipt writers", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(slice.match(/await stageExecuteSources\(/g)).toHaveLength(1);
    const stage = at("await stageExecuteSources({");
    expect(stage).toBeGreaterThan(
      at("const runSession = await ensureIntakeSession({")
    );
    expect(stage).toBeLessThan(at("await fileAnchoredCaptureProposals({"));
    expect(stage).toBeLessThan(at(": await checkPermissionOrPropose({"));
    expect(stage).toBeLessThan(at("await createAutoApprovedProposal({"));
  });

  it("the ids ride the governed gate, the propose filings and the receipt", () => {
    const flat = slice.replace(/\s+/g, " ");
    expect(flat).toContain(
      'data: { operations: gateOperations, source: "capture", ...sourceDocumentIdsData, },'
    );
    expect(flat).toContain(
      "sourceDocumentIds: executeSources.sourceDocumentIds, }));"
    );
    expect(flat).toMatch(
      /materialized: \{ entityIds: \[\] as string\[\] \}, \/\/ [^\n]*? \.\.\.sourceDocumentIdsData, \},/
    );
    // Absent ⇒ omitted, never `[]`.
    expect(flat).toContain(
      "const sourceDocumentIdsData = executeSources.sourceDocumentIds.length ? { sourceDocumentIds: executeSources.sourceDocumentIds } : {};"
    );
  });

  it("every exit echoes what the raw door kept (failures included)", () => {
    const exits = slice.match(/\.\.\.sessionEcho,/g)?.length ?? 0;
    expect(exits).toBeGreaterThanOrEqual(3);
    expect(
      slice.match(/\.\.\.sessionEcho,\s*\n\s*\.\.\.sourceIntakeEcho,/g)
    ).toHaveLength(exits);
  });
});
