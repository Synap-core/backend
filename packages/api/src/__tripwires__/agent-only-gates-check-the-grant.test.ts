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
 * Also scanned (SB2): MCP tool handlers (`synap_*: async (ctx)` chunks that
 * require `mcp.write`), `app.openapi(createRoute({ method, path }), …)` REST
 * routes, and a REST refusal shaped `if (c.get("agentUserId") || …) {`.
 *
 * NOT covered (measured): an `app.openapi(<route variable>, …)` registration
 * (only an inline `createRoute({ method, path })` is read); a branch inside a
 * helper function declared between routes (it lands in the neighbouring
 * chunk); services that branch on the acting agent below a router
 * (`services/**`); a grant check placed AFTER the write it guards; an
 * agents-only door (`if (!agentUserId) return …`) — it refuses the keys the
 * grant gap is about. Granularity is the procedure/handler chunk.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const ROUTERS = join(process.cwd(), "src/routers");

/** A door listed here is reported as a known gap (none today). */
const EXEMPT = new Set<string>([]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : walk(p);
    return f.endsWith(".ts") && !f.includes(".test.") ? [p] : [];
  });
}

const AGENT_BRANCH =
  /if \((?:(?:ctx\.|input\.)?(?:\w+A|a)gentUserId\b(?: &&[^)]*)?|\s*c\.get\("agentUserId"\)[^{]*)\)\s*\{/g;
/**
 * Every chunk boundary: a tRPC procedure, an MCP tool handler, a REST route
 * (`.get` too, so a read route never extends the write route above it), and
 * an inline `app.openapi(createRoute({ method, path }))`.
 */
const DECL =
  /^ {2}(\w+):\s*\w*[pP]rocedure|^ {2}(synap_\w+):\s*async\b|\.(get|post|put|patch|delete)\(\s*"(\/[^"]*|[^"]*)"|app\.openapi\(\s*createRoute\(\{\s*method:\s*"(\w+)",\s*path:\s*"([^"]+)"/gm;
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

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

interface WriteChunk extends Chunk {
  kind: "procedure" | "mcp" | "rest" | "openapi";
}

/** Every WRITE chunk of a file (before the agent-branch filter). */
function writeChunks(file: string, src: string): WriteChunk[] {
  const code = stripComments(src, "ts");
  const decls = [...code.matchAll(DECL)].filter(
    // `c.get("…")` is a context read, not a route.
    (d) => d[3] !== "get" || (d[4] ?? "").startsWith("/")
  );
  return decls
    .map((d, i) => {
      const body = code.slice(d.index, decls[i + 1]?.index ?? code.length);
      if (d[1])
        return { id: `${file}:${d[1]}`, kind: "procedure", body } as const;
      if (d[2]) return { id: `${file}:${d[2]}`, kind: "mcp", body } as const;
      if (d[3])
        return { id: `${file}:${d[3]} ${d[4]}`, kind: "rest", body } as const;
      return { id: `${file}:${d[5]} ${d[6]}`, kind: "openapi", body } as const;
    })
    .filter((c) => {
      if (c.kind === "procedure") return c.body.includes(".mutation(");
      if (c.kind === "mcp") return c.body.includes('"mcp.write"');
      const method = c.id.slice(c.id.indexOf(":") + 1).split(" ")[0]!;
      return WRITE_METHODS.has(method);
    });
}

function gatedChunks(file: string, src: string): Chunk[] {
  return writeChunks(file, src)
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

const sources = walk(ROUTERS).map(
  (p) => [relative(ROUTERS, p), readFileSync(p, "utf8")] as const
);
const chunks = sources.flatMap(([f, src]) => gatedChunks(f, src));
const scanned = sources.flatMap(([f, src]) => writeChunks(f, src));

describe("tripwire: agent-only write gates still bound every key by its grant", () => {
  it("scans a plausible set (non-vacuous)", () => {
    expect(chunks.length).toBeGreaterThanOrEqual(20);
    expect(
      chunks.some(
        (c) => c.id === "hub-protocol/rest/cells.ts:post /cells/define"
      )
    ).toBe(true);
  });

  it("reads MCP write tools and inline openapi write routes (non-vacuous)", () => {
    const by = (k: WriteChunk["kind"]) => scanned.filter((c) => c.kind === k);
    expect(by("mcp").length).toBeGreaterThanOrEqual(30);
    expect(by("openapi").length).toBeGreaterThanOrEqual(15);
    expect(
      scanned.some(
        (c) =>
          c.id ===
          "hub-protocol/rest/connectors.ts:post /connectors/tool-execute"
      )
    ).toBe(true);
    expect(
      chunks.some(
        (c) =>
          c.id ===
          "hub-protocol/rest/connectors.ts:post /connectors/tool-execute"
      )
    ).toBe(true);
    expect(
      chunks.some(
        (c) => c.id === "hub-protocol/rest/runs.ts:post /runs/:runId/cancel"
      )
    ).toBe(true);
    // A read tool is not a write chunk (synap_governance branches on the agent).
    expect(
      scanned.some(
        (c) => c.id === "mcp/handlers/capability.ts:synap_governance"
      )
    ).toBe(false);
  });

  it("the checker still sees the defect (self-check)", () => {
    const agentOnly = `if (agentUserId) {\n const perm = await checkPermissionOrPropose({});\n }\n write();`;
    const refusal = `if (ctx.agentUserId) {\n throw new TRPCError({});\n }\n write();`;
    expect(checksGrant(agentOnly)).toBe(false);
    expect(checksGrant(refusal)).toBe(false);
    const restRefusal = `if (\n c.get("agentUserId") ||\n keyType === "system"\n ) {\n return c.json({}, 403);\n }\n write();`;
    expect(new RegExp(AGENT_BRANCH.source).test(restRefusal)).toBe(true);
    expect(checksGrant(restRefusal)).toBe(false);
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
