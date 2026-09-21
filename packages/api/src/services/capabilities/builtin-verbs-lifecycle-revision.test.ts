/**
 * `view.update` / `cell.update` / `playbook.archive` / `skill.update_rule` /
 * `profile.propose_retire` — the WAVE B LIFECYCLE verbs.
 *
 * THE DEFECT THEY CLOSE: the substrate could CREATE thirteen kinds of object
 * but could REVISE or RETIRE almost none of them. Wave A closed
 * playbook/automation config; this closes view config, cell config, playbook
 * retirement, standing-rule revision, and kind retirement.
 *
 * WHAT THESE TESTS PIN, deliberately narrow (same contract as Wave A): each
 * handler re-enters the EXISTING governed tRPC procedure on the REAL router
 * object, calls the RIGHT procedure with the RIGHT payload, and surfaces a
 * `{ status: "proposed" }` return VERBATIM. Everything downstream of the
 * procedure call — `checkPermissionOrPropose`, `assertViewAccess`,
 * `assertProfileSchemaWrite`, `updateRuleGoverned` — belongs to the routers and
 * is tested there.
 *
 * WHAT THEY DO **NOT** COVER, measured: the routers are mocked, so nothing here
 * proves a real gate fires. Whether each door actually gates is asserted
 * structurally, against real source, by
 * `__tripwires__/synap-core-risky-verbs-reenter-a-governed-door.test.ts` —
 * including the `gatedVia` proof for `skill.update_rule`, whose gate lives in
 * `services/rules/update.ts` and not in the router.
 *
 * ALSO PINNED HERE, because it is the severance failure this pair of files
 * exists to prevent: `BUILTIN_VERBS` and the seeded `SYNAP_CORE_DEFINITION`
 * catalog are SYMMETRIC. Both sides are DERIVED from source (a brace-walk of
 * the object literal, not a regex over the whole file — a loose regex
 * overcounts this file badly), and the symmetric difference must be empty.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  viewUpdateCalls: [] as Array<Record<string, unknown>>,
  cellUpdateCalls: [] as Array<Record<string, unknown>>,
  playbookArchiveCalls: [] as Array<Record<string, unknown>>,
  ruleUpdateCalls: [] as Array<Record<string, unknown>>,
  proposeRetireCalls: [] as Array<Record<string, unknown>>,
  ruleUpdateCtx: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../routers/views.js", () => ({
  viewsRouter: {
    createCaller: () => ({
      update: async (input: Record<string, unknown>) => {
        h.viewUpdateCalls.push(input);
        return { status: "updated", message: "View updated", view: null };
      },
    }),
  },
}));

vi.mock("../../routers/cell-instances.js", () => ({
  cellInstancesRouter: {
    createCaller: () => ({
      updateConfig: async (input: Record<string, unknown>) => {
        h.cellUpdateCalls.push(input);
        return { id: input.id, config: input.config };
      },
    }),
  },
}));

vi.mock("../../routers/playbooks.js", () => ({
  playbooksRouter: {
    createCaller: () => ({
      archive: async (input: Record<string, unknown>) => {
        h.playbookArchiveCalls.push(input);
        return {
          playbook: null,
          status: "proposed",
          proposalId: "prop-archive-1",
        };
      },
    }),
  },
}));

vi.mock("../../routers/skills.js", () => ({
  skillsRouter: {
    createCaller: (callerCtx: Record<string, unknown>) => {
      h.ruleUpdateCtx.push(callerCtx);
      return {
        updateRule: async (input: Record<string, unknown>) => {
          h.ruleUpdateCalls.push(input);
          return { status: "proposed", proposalId: "prop-rule-1" };
        },
      };
    },
  },
}));

vi.mock("../../routers/profiles.js", () => ({
  profilesRouter: {
    createCaller: () => ({
      proposeRetire: async (input: Record<string, unknown>) => {
        h.proposeRetireCalls.push(input);
        return { status: "proposed", proposalId: "prop-retire-1" };
      },
    }),
  },
}));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const VIEW = "55555555-5555-4555-8555-555555555555";
const CELL = "66666666-6666-4666-8666-666666666666";
const PLAYBOOK = "dcbdbb10-958d-4d81-a9ef-2d7958dc2f09";
const RULE = "77777777-7777-4777-8777-777777777777";
const PROFILE = "88888888-8888-4888-8888-888888888888";

/** The five verbs this wave added — the one list this file drives. */
const WAVE_B_VERBS = [
  "view.update",
  "cell.update",
  "playbook.archive",
  "skill.update_rule",
  "profile.propose_retire",
] as const;

const ctx = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  workspaceId: WS,
  ...over,
});

beforeEach(() => {
  h.viewUpdateCalls = [];
  h.cellUpdateCalls = [];
  h.playbookArchiveCalls = [];
  h.ruleUpdateCalls = [];
  h.proposeRetireCalls = [];
  h.ruleUpdateCtx = [];
});

describe("the five lifecycle verbs are registered as WRITES", () => {
  it("each is dispatchable from BUILTIN_VERBS", () => {
    for (const verb of WAVE_B_VERBS) {
      expect(typeof BUILTIN_VERBS[verb], `${verb} is not dispatchable`).toBe(
        "function"
      );
    }
  });

  it("none of them is marked read-only (they must flow through the full gate)", () => {
    // SELF-CHECK FIRST: the set must still be able to SEE a read verb, or the
    // loop below is a tautology over an empty/blind set.
    expect(
      READ_ONLY_BUILTIN_VERBS.has("entity.query"),
      "READ_ONLY_BUILTIN_VERBS can no longer see a known READ verb — this " +
        "assertion has gone blind and the loop below proves nothing"
    ).toBe(true);
    expect(READ_ONLY_BUILTIN_VERBS.size).toBeGreaterThanOrEqual(8);

    for (const verb of WAVE_B_VERBS) {
      expect(
        READ_ONLY_BUILTIN_VERBS.has(verb),
        `${verb} MUTATES — marking it read-only would make the capability ` +
          `gate auto-run it with no grant and no proposal`
      ).toBe(false);
    }
  });
});

describe("view.update", () => {
  it("forwards the patch to viewsRouter.update under `id`", async () => {
    await BUILTIN_VERBS["view.update"]!(
      {
        viewId: VIEW,
        name: "Pipeline",
        config: { columns: ["a"] },
        metadata: { userAuthored: true },
        type: "kanban",
      },
      ctx()
    );
    expect(h.viewUpdateCalls).toHaveLength(1);
    expect(h.viewUpdateCalls[0]).toEqual({
      id: VIEW,
      name: "Pipeline",
      config: { columns: ["a"] },
      metadata: { userAuthored: true },
      type: "kanban",
    });
  });

  it("omits absent fields entirely (a patch, never a wipe)", async () => {
    await BUILTIN_VERBS["view.update"]!({ viewId: VIEW, name: "X" }, ctx());
    expect(Object.keys(h.viewUpdateCalls[0]!).sort()).toEqual(["id", "name"]);
  });

  it("REFUSES a content field — content belongs to views.save, not here", async () => {
    // The activate/nextRunAt-class trap for views: `views.save` uploads the
    // snapshot and mints a document version; `views.update` cannot write
    // content at all. Accepting-and-dropping `content` would tell the caller a
    // board was saved that never was.
    await expect(
      BUILTIN_VERBS["view.update"]!(
        { viewId: VIEW, content: { category: "canvas" } },
        ctx()
      )
    ).rejects.toThrow();
    expect(h.viewUpdateCalls).toHaveLength(0);
  });
});

describe("cell.update", () => {
  it("forwards the config to cellInstances.updateConfig under `id`", async () => {
    await BUILTIN_VERBS["cell.update"]!(
      { cellInstanceId: CELL, config: { title: "Notes" } },
      ctx()
    );
    expect(h.cellUpdateCalls).toEqual([
      { id: CELL, config: { title: "Notes" } },
    ]);
  });

  it("requires config (it REPLACES, so an omitted config would blank the cell)", async () => {
    await expect(
      BUILTIN_VERBS["cell.update"]!({ cellInstanceId: CELL }, ctx())
    ).rejects.toThrow();
    expect(h.cellUpdateCalls).toHaveLength(0);
  });
});

describe("playbook.archive", () => {
  it("threads agentUserId + reasoning and surfaces `proposed` VERBATIM", async () => {
    const result = await BUILTIN_VERBS["playbook.archive"]!(
      { playbookId: PLAYBOOK, reasoning: "superseded" },
      ctx({ agentUserId: AGENT })
    );
    expect(h.playbookArchiveCalls).toEqual([
      { id: PLAYBOOK, agentUserId: AGENT, reasoning: "superseded" },
    ]);
    // A proposal IS the success. Surfaced unaltered, never re-labelled.
    expect(result).toEqual({
      playbook: null,
      status: "proposed",
      proposalId: "prop-archive-1",
    });
  });

  it("omits agentUserId for an owner-attributed run", async () => {
    await BUILTIN_VERBS["playbook.archive"]!({ playbookId: PLAYBOOK }, ctx());
    expect(h.playbookArchiveCalls[0]).toEqual({ id: PLAYBOOK });
  });
});

describe("skill.update_rule", () => {
  it("puts agentUserId on the CALLER CONTEXT (this door reads ctx, not input)", async () => {
    // LOAD-BEARING and easy to lose: skillsRouter.updateRule reads
    // `ctx.agentUserId`. Dropping it would make an agent's rule edit look like
    // the owner's own and auto-execute — the attribution trap that
    // disqualified workspaces.update from this wave.
    await BUILTIN_VERBS["skill.update_rule"]!(
      {
        ruleId: RULE,
        intent: "Always cc finance",
        scope: { kind: "pod" },
      },
      ctx({ agentUserId: AGENT })
    );
    expect(h.ruleUpdateCtx).toHaveLength(1);
    expect(h.ruleUpdateCtx[0]!.agentUserId).toBe(AGENT);
  });

  it("preserves the THREE states of expiresAt and sentence", async () => {
    // absent → the key must not be sent at all
    await BUILTIN_VERBS["skill.update_rule"]!(
      { ruleId: RULE, intent: "i", scope: { kind: "pod" } },
      ctx()
    );
    expect("expiresAt" in h.ruleUpdateCalls[0]!).toBe(false);
    expect("sentence" in h.ruleUpdateCalls[0]!).toBe(false);

    // null → the key must be sent AS NULL (clear / remove)
    await BUILTIN_VERBS["skill.update_rule"]!(
      {
        ruleId: RULE,
        intent: "i",
        scope: { kind: "pod" },
        expiresAt: null,
        sentence: null,
      },
      ctx()
    );
    expect(h.ruleUpdateCalls[1]!.expiresAt).toBeNull();
    expect(h.ruleUpdateCalls[1]!.sentence).toBeNull();

    // a value → sent through unaltered
    await BUILTIN_VERBS["skill.update_rule"]!(
      {
        ruleId: RULE,
        intent: "i",
        scope: { kind: "workspace", workspaceId: WS },
        expiresAt: "2026-12-01T00:00:00.000Z",
        sentence: { verb: "notify" },
      },
      ctx()
    );
    expect(h.ruleUpdateCalls[2]!.expiresAt).toBe("2026-12-01T00:00:00.000Z");
    expect(h.ruleUpdateCalls[2]!.sentence).toEqual({ verb: "notify" });
    expect(h.ruleUpdateCalls[2]!.scope).toEqual({
      kind: "workspace",
      workspaceId: WS,
    });
  });

  it("surfaces `proposed` VERBATIM", async () => {
    const result = await BUILTIN_VERBS["skill.update_rule"]!(
      { ruleId: RULE, intent: "i", scope: { kind: "pod" } },
      ctx({ agentUserId: AGENT })
    );
    expect(result).toEqual({ status: "proposed", proposalId: "prop-rule-1" });
  });
});

describe("profile.propose_retire", () => {
  it("forwards to profiles.proposeRetire and surfaces `proposed` VERBATIM", async () => {
    const result = await BUILTIN_VERBS["profile.propose_retire"]!(
      { profileId: PROFILE, reason: "merged into `contact`" },
      ctx({ agentUserId: AGENT })
    );
    expect(h.proposeRetireCalls).toEqual([
      { id: PROFILE, reason: "merged into `contact`" },
    ]);
    expect(result).toEqual({ status: "proposed", proposalId: "prop-retire-1" });
  });

  it("REFUSES a pod-wide run — the door is a workspaceProcedure", async () => {
    await expect(
      BUILTIN_VERBS["profile.propose_retire"]!(
        { profileId: PROFILE },
        ctx({ workspaceId: undefined })
      )
    ).rejects.toThrow(/acting workspace/i);
    expect(h.proposeRetireCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SEVERANCE FLOOR: the handler registry and the seeded catalog are symmetric.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Strip `//` and block comments, preserving string/template literals.
 *
 * LOAD-BEARING, learned the hard way: this file's first draft walked the raw
 * source and the scan came back missing six verbs. The cause was an APOSTROPHE
 * in a prose comment (`the verb's identity`) opening a string state that never
 * closed, plus unbalanced parentheses in other comments moving the depth
 * counter. A brace-walk that can see comments is not a brace-walk.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Brace-walk the `export const <name>: ... = { ... }` object literal and return
 * its top-level quoted keys. DELIBERATELY NOT a regex over the whole file: this
 * module is 3.5k lines of handlers full of quoted string literals, and a loose
 * regex overcounts it badly.
 */
function topLevelQuotedKeys(raw: string, declName: string): string[] {
  const source = stripComments(raw);
  const declAt = source.indexOf(`export const ${declName}`);
  if (declAt < 0) throw new Error(`declaration not found: ${declName}`);
  const open = source.indexOf("{", source.indexOf("=", declAt));
  if (open < 0) throw new Error(`no object literal for ${declName}`);

  let depth = 0;
  let end = -1;
  let inStr: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced object literal for ${declName}`);

  const body = source.slice(open + 1, end);
  // Depth-0 `"key":` only — a nested object's keys are skipped.
  const keys: string[] = [];
  let d = 0;
  let s: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (s) {
      if (c === "\\") i++;
      else if (c === s) s = null;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === "}" || c === "]" || c === ")") d--;
    else if (c === '"' && d === 0) {
      const close = body.indexOf('"', i + 1);
      if (close > 0 && /^\s*:/.test(body.slice(close + 1))) {
        keys.push(body.slice(i + 1, close));
        i = close;
        continue;
      }
      s = '"';
    } else if (c === '"' || c === "'" || c === "`") s = c;
  }
  return keys;
}

/** `name: "<verb>",` entries inside SYNAP_CORE_DEFINITION's skills array. */
function catalogVerbNames(raw: string): string[] {
  const source = stripComments(raw);
  const at = source.indexOf("export const SYNAP_CORE_DEFINITION");
  if (at < 0) throw new Error("SYNAP_CORE_DEFINITION not found");
  return [...source.slice(at).matchAll(/^\s{6}name:\s*"([^"]+)",$/gm)].map(
    (m) => m[1]!
  );
}

describe("SEVERANCE FLOOR: BUILTIN_VERBS ≡ the seeded synap-core catalog", () => {
  const verbsSrc = readFileSync(resolve(HERE, "builtin-verbs.ts"), "utf8");
  const coreSrc = readFileSync(resolve(HERE, "ensure-synap-core.ts"), "utf8");

  const handlers = topLevelQuotedKeys(verbsSrc, "BUILTIN_VERBS");
  const schemas = topLevelQuotedKeys(verbsSrc, "BUILTIN_VERB_PARAM_SCHEMAS");
  const catalog = catalogVerbNames(coreSrc);

  it("NON-VACUITY: both parsers see a plausible, duplicate-free verb set", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(38);
    expect(catalog.length).toBeGreaterThanOrEqual(38);
    expect(new Set(handlers).size).toBe(handlers.length);
    expect(new Set(catalog).size).toBe(catalog.length);
    // Literal samples each parser MUST still be able to see: one from before
    // this wave, one from it.
    expect(handlers).toContain("entity.delete");
    expect(handlers).toContain("profile.propose_retire");
    expect(catalog).toContain("entity.delete");
    expect(catalog).toContain("profile.propose_retire");
    // And the brace-walk must NOT have swallowed a nested key.
    expect(handlers).not.toContain("type");
    expect(handlers).not.toContain("properties");
  });

  it("the symmetric difference is EMPTY", () => {
    const inHandlers = new Set(handlers);
    const inCatalog = new Set(catalog);
    expect(
      handlers.filter((v) => !inCatalog.has(v)),
      "verbs with a handler but NO catalog entry — undiscoverable on every door"
    ).toEqual([]);
    expect(
      catalog.filter((v) => !inHandlers.has(v)),
      "verbs advertised in the catalog with NO handler — they fail at run time"
    ).toEqual([]);
  });

  it("every handler has a param schema (feed.read parses inline, by design)", () => {
    const inSchemas = new Set(schemas);
    expect(handlers.filter((v) => !inSchemas.has(v))).toEqual(["feed.read"]);
  });
});
