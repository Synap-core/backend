/**
 * TRIPWIRE — a write door whose gate runs for agents only still checks the grant.
 *
 * A grant is enforced inside `checkPermissionOrPropose` (its grant rung) and
 * the key-auth door fence passes writes through. A door shaped
 * `if (agentUserId) { checkPermissionOrPropose(...) }` — or "only the person
 * can …" (`if (ctx.agentUserId) throw`) — therefore let any key that is NOT an
 * agent write unbounded by its grant: a narrow human key could define renderer
 * code (`POST /cells/define`), cancel a run, answer a slot, file a guideline.
 *
 * The rule, per write procedure / REST handler under `src/routers/` (the set is
 * DERIVED — every `.mutation(` procedure and `.post|put|patch|delete(` handler
 * whose body branches on the acting agent): the body calls the grant door
 * (`assertKeyMayWrite(` / `grantWriteDenial(`), OR calls
 * `checkPermissionOrPropose(` OUTSIDE every agent-only branch (an unconditional
 * gate already runs the grant rung for every key).
 *
 * NOT covered (measured): handlers registered through `app.openapi(route, …)`
 * (not matched by the REST chunker); services that branch on the acting agent
 * below a router (`services/**`); a grant check placed AFTER the write it
 * guards. Granularity is the procedure/handler chunk.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROUTERS = join(process.cwd(), "src/routers");

/** Held by another session in this wave (agent-users.ts) — report, not skip silently. */
const EXEMPT = new Set([
  "agent-users.ts:disconnect",
  "agent-users.ts:setBinding",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : walk(p);
    return f.endsWith(".ts") && !f.includes(".test.") ? [p] : [];
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

const AGENT_BRANCH =
  /if \((?:ctx\.|input\.)?(?:\w+A|a)gentUserId\b(?: &&[^)]*)?\)\s*\{/g;
const DECL =
  /^ {2}(\w+):\s*\w*[pP]rocedure|\.(post|put|patch|delete)\(\s*"([^"]+)"/gm;

function closeBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return s.length;
}

interface Chunk {
  id: string;
  body: string;
}

function gatedChunks(file: string, src: string): Chunk[] {
  const code = stripComments(src);
  const decls = [...code.matchAll(DECL)];
  return decls
    .map((d, i) => ({
      id: `${file}:${d[1] ?? `${d[2]} ${d[3]}`}`,
      isProc: !!d[1],
      body: code.slice(d.index, decls[i + 1]?.index ?? code.length),
    }))
    .filter((c) => !c.isProc || c.body.includes(".mutation("))
    .filter((c) => new RegExp(AGENT_BRANCH.source).test(c.body))
    .map(({ id, body }) => ({ id, body }));
}

/** Does this chunk bound every key by its grant? */
function checksGrant(body: string): boolean {
  if (/\b(assertKeyMayWrite|grantWriteDenial)\(/.test(body)) return true;
  const spans = [...body.matchAll(AGENT_BRANCH)].map((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    return [m.index ?? 0, closeBrace(body, open)] as const;
  });
  return [...body.matchAll(/checkPermissionOrPropose\(/g)].some(
    (g) => !spans.some(([a, b]) => (g.index ?? 0) > a && (g.index ?? 0) < b)
  );
}

const chunks = walk(ROUTERS).flatMap((p) =>
  gatedChunks(relative(ROUTERS, p), readFileSync(p, "utf8"))
);

describe("tripwire: agent-only write gates still bound every key by its grant", () => {
  it("scans a plausible set (non-vacuous)", () => {
    expect(chunks.length).toBeGreaterThanOrEqual(20);
    expect(
      chunks.some(
        (c) => c.id === "hub-protocol/rest/cells.ts:post /cells/define"
      )
    ).toBe(true);
  });

  it("the checker still sees the defect (self-check)", () => {
    const agentOnly = `if (agentUserId) {\n const perm = await checkPermissionOrPropose({});\n }\n write();`;
    const refusal = `if (ctx.agentUserId) {\n throw new TRPCError({});\n }\n write();`;
    expect(checksGrant(agentOnly)).toBe(false);
    expect(checksGrant(refusal)).toBe(false);
    expect(checksGrant(`await assertKeyMayWrite({});\n${refusal}`)).toBe(true);
    expect(
      checksGrant(`${agentOnly}\n await checkPermissionOrPropose({});`)
    ).toBe(true);
  });

  it("every agent-only gated write checks the key's grant", () => {
    const missing = chunks
      .filter((c) => !EXEMPT.has(c.id) && !checksGrant(c.body))
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("exemptions still exist", () => {
    const ids = new Set(chunks.map((c) => c.id));
    for (const id of EXEMPT) expect(ids.has(id)).toBe(true);
  });
});
