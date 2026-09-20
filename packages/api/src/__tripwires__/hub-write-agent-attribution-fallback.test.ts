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
 * must also reach the fallback — either `c.get("agentUserId")` inline, or a
 * call to a FALLBACK HELPER — or sit on EXEMPT with a reason.
 *
 * FALLBACK HELPERS are DERIVED, never listed: a helper counts only when its own
 * body in the SAME file contains `c.get("agentUserId")`. `rest/playbooks.ts`
 * routes three handlers through `resolveWriteAgent(c, body.agentUserId)`, whose
 * one line IS `bodyAgentUserId ?? c.get("agentUserId")` — correct code the
 * token-only scan reported as a defect for days, which is how a guard trains
 * people to ignore it. Deriving from the helper's own body is what keeps this
 * from becoming an exemption: gut the helper's fallback and its callers are
 * flagged again (negative control below, and proven by reverting playbooks.ts).
 *
 * WHAT IT CANNOT SEE (measured by reading, not implied):
 *  - Granularity is the HANDLER BLOCK, not the read: a block that falls back in
 *    one expression and reads `body.agentUserId` raw in another stays green.
 *  - A handler that never reads a body agent id at all (POST /capture/graph has
 *    no such field) is invisible — its behavioural test
 *    (rest/relations-capture-graph.agent-attribution.test.ts) guards it.
 *  - Other aliases (`const b = body; b.agentUserId`) are not scanned.
 *  - A helper is credited to the handler that CALLS it by name only. A handler
 *    that calls a real fallback helper AND separately passes a raw
 *    `body.agentUserId` somewhere else stays green — same handler-block
 *    granularity caveat as above, now one level deeper.
 *  - Helper detection is per FILE: a fallback helper imported from another
 *    module does not count, and its callers are still flagged.
 *  - It proves the fallback TOKEN is present, not that it feeds governance.
 */

const REST_DIR = join(__dirname, "..", "routers", "hub-protocol", "rest");

// Reads of an agent id that a CLIENT supplied.
const BODY_AGENT_READ =
  /\b(?:body|patch|parsed\.data)\.agentUserId\b|\bagentUserId\s*:\s*bodyAgentUserId\b/;
const KEY_AGENT_FALLBACK = /c\.get\(\s*["']agentUserId["']\s*\)/;
const HANDLER_START = /\bapp\.(?:get|post|put|patch|delete|openapi)\(/g;
/** `function name(` / `const name = (` / `const name = async (` in the prelude. */
const HELPER_DECL =
  /(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

/** `file::first-line-of-block` → why this block stays body-only. */
const EXEMPT: Record<string, string> = {};

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Names of file-local helpers whose OWN body reads `c.get("agentUserId")` —
 * i.e. helpers that perform the fallback on a handler's behalf. Derived from
 * the prelude (everything before the first `app.*(`), which is where these
 * files declare them; a helper without the token is deliberately NOT returned,
 * so calling it never satisfies this tripwire.
 */
export function fallbackHelpers(src: string): Set<string> {
  const code = stripComments(src);
  const firstHandler = code.search(
    /\bapp\.(?:get|post|put|patch|delete|openapi)\(/
  );
  const prelude = code.slice(
    0,
    firstHandler === -1 ? code.length : firstHandler
  );
  const decls = [...prelude.matchAll(HELPER_DECL)];
  const names = new Set<string>();
  for (const [i, m] of decls.entries()) {
    const name = m[1] ?? m[2];
    const start = m.index ?? 0;
    const end = decls[i + 1]?.index ?? prelude.length;
    if (name && KEY_AGENT_FALLBACK.test(prelude.slice(start, end))) {
      names.add(name);
    }
  }
  return names;
}

function handlerBlocks(src: string): string[] {
  const code = stripComments(src);
  const starts = [...code.matchAll(HANDLER_START)].map((m) => m.index ?? 0);
  return starts.map((s, i) => code.slice(s, starts[i + 1] ?? code.length));
}

function offendersIn(file: string, src: string): string[] {
  const helpers = [...fallbackHelpers(src)];
  const callsHelper = (b: string) =>
    helpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(b));
  return handlerBlocks(src)
    .filter(
      (b) =>
        BODY_AGENT_READ.test(b) &&
        !KEY_AGENT_FALLBACK.test(b) &&
        !callsHelper(b)
    )
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

  it("self-check: a helper only launders when the helper ITSELF falls back", () => {
    // Shape of rest/playbooks.ts: the fallback lives one level down.
    const viaRealHelper = `
      async function resolveWriteAgent(c, bodyAgentUserId) {
        const agentUserId = bodyAgentUserId ?? c.get("agentUserId");
        return { agentUserId };
      }
      app.post("/x", async (c) => {
        const agent = await resolveWriteAgent(c, body.agentUserId);
      });`;
    expect(fallbackHelpers(viaRealHelper)).toContain("resolveWriteAgent");
    expect(offendersIn("real.ts", viaRealHelper)).toEqual([]);

    // THE HOLE THIS MUST NOT OPEN: same call shape, but the helper never reads
    // the key's agent — exactly the 2026-09-13 defect, one indirection deeper.
    const viaHollowHelper = `
      async function resolveWriteAgent(c, bodyAgentUserId) {
        return { agentUserId: bodyAgentUserId };
      }
      app.post("/x", async (c) => {
        const agent = await resolveWriteAgent(c, body.agentUserId);
      });`;
    expect(fallbackHelpers(viaHollowHelper).size).toBe(0);
    expect(offendersIn("hollow.ts", viaHollowHelper)).toEqual([
      'hollow.ts::app.post("/x", async (c) => {',
    ]);
  });

  it("self-check: playbooks.ts is really reached through a helper, not inline", () => {
    // Guards the guard: if playbooks.ts ever inlines the fallback, this test is
    // the one that says the helper path is no longer what keeps it green.
    const src = readFileSync(join(REST_DIR, "playbooks.ts"), "utf8");
    const helpers = fallbackHelpers(src);
    expect(helpers).toContain("resolveWriteAgent");
    const viaHelperOnly = handlerBlocks(src).filter(
      (b) =>
        BODY_AGENT_READ.test(b) &&
        !KEY_AGENT_FALLBACK.test(b) &&
        /\bresolveWriteAgent\s*\(/.test(b)
    );
    expect(viaHelperOnly.length).toBeGreaterThanOrEqual(2);
    expect(offendersIn("playbooks.ts", src)).toEqual([]);
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
