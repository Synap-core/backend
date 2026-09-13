import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — a hub REST write that reads the acting agent from the BODY also
 * falls back to the authenticated key's agent (`c.get("agentUserId")`).
 *
 * MEASURED DEFECT (live pod, 2026-09-13): `relates_to` edges created by a
 * Raycast agent key landed `created_by_kind=human`, `agentUserId=null`. Nine
 * write handlers (relations POST/DELETE, cell-instances ×3, documents POST,
 * threads link-entity/link-document, capture/graph) took the agent ONLY from
 * `body.agentUserId`. A key that did not echo its own id resolved as the HUMAN
 * — an unattributed write that skipped agent governance. The backend rule:
 * "Attribution is the prerequisite: an anonymous write falls to the HUMAN path".
 * The canonical shape is `body.agentUserId ?? c.get("agentUserId")`
 * (rest/entities.ts createEntity).
 *
 * HOW IT SCANS: every non-test `.ts` under rest/ is globbed (a new route file
 * joins by existing), comments are stripped, and the source is cut into handler
 * blocks at each `app.get|post|put|patch|delete|openapi(`. A block that reads a
 * body-shaped agent id (`body.agentUserId`, `patch.agentUserId`,
 * `parsed.data.agentUserId`, or a destructured `agentUserId: bodyAgentUserId`)
 * must also contain `c.get("agentUserId")`, or sit on EXEMPT with a reason.
 *
 * WHAT IT CANNOT SEE (measured by reading, not implied):
 *  - Granularity is the HANDLER BLOCK, not the read: a block that falls back in
 *    one expression and reads `body.agentUserId` raw in another stays green.
 *  - A handler that never reads a body agent id at all (POST /capture/graph has
 *    no such field) is invisible — its behavioural test
 *    (rest/relations-capture-graph.agent-attribution.test.ts) guards it.
 *  - Other aliases (`const b = body; b.agentUserId`) and helpers declared
 *    outside a handler block (before the first `app.*(`) are not scanned.
 *  - It proves the fallback TOKEN is present, not that it feeds governance.
 */

const REST_DIR = join(__dirname, "..", "routers", "hub-protocol", "rest");

// Reads of an agent id that a CLIENT supplied.
const BODY_AGENT_READ =
  /\b(?:body|patch|parsed\.data)\.agentUserId\b|\bagentUserId\s*:\s*bodyAgentUserId\b/;
const KEY_AGENT_FALLBACK = /c\.get\(\s*["']agentUserId["']\s*\)/;
const HANDLER_START = /\bapp\.(?:get|post|put|patch|delete|openapi)\(/g;

/** `file::first-line-of-block` → why this block stays body-only. */
const EXEMPT: Record<string, string> = {};

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function handlerBlocks(src: string): string[] {
  const code = stripComments(src);
  const starts = [...code.matchAll(HANDLER_START)].map((m) => m.index ?? 0);
  return starts.map((s, i) => code.slice(s, starts[i + 1] ?? code.length));
}

function offendersIn(file: string, src: string): string[] {
  return handlerBlocks(src)
    .filter((b) => BODY_AGENT_READ.test(b) && !KEY_AGENT_FALLBACK.test(b))
    .map((b) => `${file}::${b.split("\n")[0].trim()}`);
}

function restFiles(): string[] {
  return readdirSync(REST_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts")
  );
}

describe("tripwire: hub REST writes fall back to the key's agent", () => {
  it("every handler reading a body agentUserId also reads c.get('agentUserId')", () => {
    const offenders: string[] = [];
    let bodyReaders = 0;
    for (const f of restFiles()) {
      const src = readFileSync(join(REST_DIR, f), "utf8");
      bodyReaders += handlerBlocks(src).filter((b) =>
        BODY_AGENT_READ.test(b)
      ).length;
      offenders.push(...offendersIn(f, src).filter((o) => !(o in EXEMPT)));
    }
    // Non-vacuity: ~30 handlers read a body agent id today. A broken glob or
    // splitter that sees none would pass the assertion below trivially.
    expect(bodyReaders).toBeGreaterThanOrEqual(20);
    expect(offenders).toEqual([]);
  });

  it("self-check: the scan still flags a synthetic body-only handler", () => {
    const bodyOnly = `
      app.post("/x", async (c) => {
        // c.get("agentUserId") mentioned in a comment does not count
        const body = await c.req.json();
        await resolveActorId(body.agentUserId, userId);
      });
      app.post("/y", async (c) => {
        const id = body.agentUserId ?? (c.get("agentUserId") as string);
      });`;
    expect(offendersIn("synthetic.ts", bodyOnly)).toEqual([
      'synthetic.ts::app.post("/x", async (c) => {',
    ]);
  });

  it("every exemption still names a live body-only handler", () => {
    const live = new Set(
      restFiles().flatMap((f) =>
        offendersIn(f, readFileSync(join(REST_DIR, f), "utf8"))
      )
    );
    expect(Object.keys(EXEMPT).filter((k) => !live.has(k))).toEqual([]);
  });
});
