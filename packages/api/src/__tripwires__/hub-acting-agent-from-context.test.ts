/**
 * TRIPWIRE — a hub-protocol tRPC write is governed as the AUTHENTICATED agent.
 *
 * The hole this pins: the hub routers read the acting agent from INPUT only
 * (`input.agentUserId`) and built the delegated caller context without it. An
 * agent key that simply omitted the field reached the inner procedure as the
 * operator — no grant, no limits, no ask-first, no proposal (`automations.trigger`
 * gates only `if (agentUserId)`; `create` with `status:"active"` the same).
 *
 * The rule, per `.mutation(` procedure of every file under
 * `routers/hub-protocol/` that defines `scopedProcedure(` (the set is DERIVED —
 * a new router joins the scan by existing):
 *   A. it never reads `input.agentUserId` / `rest.agentUserId` except as the
 *      argument of `actingAgentUserId(ctx, …)` (utils.ts — ctx wins);
 *   B. every `createHubProtocolCallerContext(` call passes a 6th argument that
 *      comes from `actingAgentUserId(ctx…)` (directly, or a local assigned from it);
 *   C. a procedure whose input declares `agentUserId` calls `actingAgentUserId(ctx`.
 * Plus the inner `automations.create` / `automations.trigger` gates resolve
 * through the same helper.
 *
 * NOT covered (measured): queries (`listA2AIChannels` takes `agentUserId` as a
 * FILTER, not an identity); routes that skip `createHubProtocolCallerContext`
 * and call a service directly (they are covered only by rules A/C); a 6th arg
 * that names `agentUserId` assigned from something else in a DIFFERENT chunk.
 * Granularity is the procedure chunk (text between two `scopedProcedure(`).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const HUB_DIR = join(process.cwd(), "src/routers/hub-protocol");

/**
 * `branches.ts` floors `agentUserId` to `ctx.userId` with `assertMayActAs` and
 * runs `checkPermissionOrPropose` UNCONDITIONALLY (no agent-only branch), so an
 * omitted field cannot skip the gate or the grant rung.
 */
const EXEMPT = new Set(["branches.ts:createBranch", "branches.ts:mergeBranch"]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function topLevelArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of argText) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Chunk {
  id: string;
  body: string;
}

function mutationChunks(file: string, src: string): Chunk[] {
  const code = stripComments(src);
  const re = /\n {2}(\w+): scopedProcedure\(/g;
  const starts: Array<{ name: string; at: number }> = [];
  for (const m of code.matchAll(re))
    starts.push({ name: m[1], at: m.index ?? 0 });
  return starts
    .map((s, i) => ({
      id: `${file}:${s.name}`,
      body: code.slice(s.at, starts[i + 1]?.at ?? code.length),
    }))
    .filter((c) => c.body.includes(".mutation("));
}

/** Violations for one procedure chunk. */
function violations(chunk: Chunk): string[] {
  const out: string[] = [];
  const { body, id } = chunk;
  const rawReads = body
    .replace(/actingAgentUserId\(ctx,\s*input\.agentUserId\)/g, "")
    .match(/\b(input|rest)\.agentUserId\b/g);
  if (rawReads)
    out.push(`${id}: reads ${rawReads[0]} outside actingAgentUserId`);

  const helperLocal = /const (\w+) = \(?await actingAgentUserId\(ctx\b/.exec(
    body
  )?.[1];
  for (const m of body.matchAll(/createHubProtocolCallerContext\(/g)) {
    const open = (m.index ?? 0) + "createHubProtocolCallerContext".length;
    const args = topLevelArgs(body.slice(open + 1, closeParen(body, open)));
    const sixth = args[5];
    const ok =
      !!sixth &&
      (/^\(?await actingAgentUserId\(ctx\b/.test(sixth) ||
        (!!helperLocal && sixth === helperLocal));
    if (!ok)
      out.push(
        `${id}: caller context built without the authenticated agent (6th arg: ${sixth ?? "none"})`
      );
  }

  if (
    /\bagentUserId:\s*z\./.test(body) &&
    !/actingAgentUserId\(ctx\b/.test(body)
  )
    out.push(
      `${id}: declares agentUserId but never resolves actingAgentUserId(ctx)`
    );
  return out;
}

const files = readdirSync(HUB_DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
);
const routerFiles = files.filter((f) =>
  readFileSync(join(HUB_DIR, f), "utf8").includes("scopedProcedure(")
);
const chunks = routerFiles.flatMap((f) =>
  mutationChunks(f, readFileSync(join(HUB_DIR, f), "utf8"))
);

describe("tripwire: hub tRPC writes take the agent from the authenticated context", () => {
  it("scans a plausible set (non-vacuous)", () => {
    expect(routerFiles.length).toBeGreaterThanOrEqual(15);
    expect(chunks.length).toBeGreaterThanOrEqual(30);
    const ctxCalls = chunks
      .map(
        (c) => c.body.match(/createHubProtocolCallerContext\(/g)?.length ?? 0
      )
      .reduce((a, b) => a + b, 0);
    expect(ctxCalls).toBeGreaterThanOrEqual(20);
  });

  it("the checker still sees the defect it hunts (self-check)", () => {
    const bad: Chunk = {
      id: "sample:trigger",
      body: `trigger: scopedProcedure(["w"]).input(z.object({ agentUserId: z.string() }))
        .mutation(async ({ input, ctx }) => {
          const c = await createHubProtocolCallerContext(input.userId, ctx.scopes, null);
          return inner(c).trigger({ agentUserId: input.agentUserId });
        })`,
    };
    expect(violations(bad)).toHaveLength(3);
    const good: Chunk = {
      id: "sample:ok",
      body: `x: scopedProcedure(["w"]).input(z.object({ agentUserId: z.string() }))
        .mutation(async ({ input, ctx }) => {
          const agentUserId = await actingAgentUserId(ctx, input.agentUserId);
          const c = await createHubProtocolCallerContext(a, b, c, d, e, agentUserId);
        })`,
    };
    expect(violations(good)).toEqual([]);
  });

  it("every hub mutation resolves the acting agent through actingAgentUserId(ctx)", () => {
    const found = chunks
      .filter((c) => !EXEMPT.has(c.id))
      .flatMap((c) => violations(c));
    expect(found).toEqual([]);
  });

  it("exemptions still exist (a renamed procedure must not silently stay exempt)", () => {
    const ids = new Set(chunks.map((c) => c.id));
    for (const id of EXEMPT) expect(ids.has(id)).toBe(true);
  });

  it("automations.create and automations.trigger gate on the same resolution", () => {
    const src = stripComments(
      readFileSync(join(process.cwd(), "src/routers/automations.ts"), "utf8")
    );
    const create = src.slice(
      src.indexOf("  create: protectedProcedure"),
      src.indexOf("  update: protectedProcedure")
    );
    const trigger = src.slice(src.indexOf("  trigger: protectedProcedure"));
    for (const body of [create, trigger]) {
      expect(body).toMatch(
        /const agentUserId = await actingAgentUserId\(ctx, input\.agentUserId\)/
      );
      expect(body).not.toMatch(/if \(input\.agentUserId\)/);
    }
  });
});
