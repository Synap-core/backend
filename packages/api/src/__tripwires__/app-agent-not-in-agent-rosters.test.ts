/**
 * Tripwire: an app's own agent user is never shown or ranked AS an agent.
 *
 * Each connected app acts as its own agent user (`apps.agent_user_id`) so its
 * writes run the agent governance ladder. It is governed on its APP's page;
 * an agent roster, scorecard or governance recommender that lists every
 * `userType = 'agent'` row would show it twice (once as an app, once as a
 * mystery agent named after the app) and recommend widening it outside its
 * app. `notAnAppAgent` (`@synap/database`) is the ONE predicate that keeps it
 * out.
 *
 * The scanned set is DERIVED: every non-test source file under `src/` is read
 * and every agent-type query (`eq(users.userType, "agent")` or raw
 * `user_type = 'agent'`) is a site. Each site must be one of:
 *   - FILTERED   — `notAnAppAgent(` in the statement window;
 *   - POINT      — the query names its principal (`eq(users.id, …)` /
 *                  `inArray(users.id, …)`): an "is this id an agent" probe,
 *                  not a roster;
 *   - SINGLETON  — keyed by `agent_type` / personal agent / parent agent: an
 *                  app agent's type is its own `public_id`, it is never a
 *                  personal agent and has no parent, so it cannot match;
 *   - LISTED     — in `INCLUDES_APP_AGENTS` below, with why it must keep them.
 *
 * Does NOT cover: the window is the 6 lines above and 4 below the match, so a
 * statement whose filter sits further away is judged on what the window sees
 * (a site misread as FILTERED/POINT this way is a false green); a query built
 * without either literal (e.g. a `userType` variable) is not a site at all,
 * and a comment line (`*` / `//`) is never one.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Queries that MUST keep app agents, per file, with the number of such sites —
 * a new unfiltered roster in one of these files still fails (the count moves).
 */
const INCLUDES_APP_AGENTS: Record<string, { sites: number; reason: string }> = {
  "services/agent-identity-service.ts": {
    sites: 1,
    reason:
      "ownAgentUserIds — an app's proposals are its owner's review queue like any of their agents'",
  },
  "routers/system.ts": {
    sites: 1,
    reason:
      "deleting a user removes EVERY agent they created — an app agent left behind would be an orphan principal",
  },
  "routers/agent-users.ts": {
    sites: 1,
    reason:
      "the admin 'remove this user's agents' sweep must reach every agent principal they own, app agents included",
  },
  "services/agent-dispatch/agent-binding.ts": {
    sites: 1,
    reason:
      "joins `dispatched_via` links — only a dispatch binding writes one, never an app",
  },
};

const SITE = /eq\(users\.userType,\s*"agent"\)|user_type\s*=\s*'agent'/;
const FILTERED = /notAnAppAgent\(/;
const POINT = /\b(eq|inArray)\(\s*users\.id\s*,/;
const SINGLETON =
  /users\.agentType|agent_type|users\.isPersonalAgent|users\.parentAgentId/;

type Kind = "FILTERED" | "POINT" | "SINGLETON" | "UNFILTERED";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "__tripwires__") continue;
      out.push(...sourceFiles(p));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.test\.ts$/.test(name)
    ) {
      out.push(p);
    }
  }
  return out;
}

export function classifySites(src: string): Kind[] {
  const lines = src.split("\n");
  const kinds: Kind[] = [];
  lines.forEach((line, i) => {
    // Prose naming the shape is not a query.
    if (!SITE.test(line) || /^\s*(\*|\/\/)/.test(line)) return;
    const window = lines.slice(Math.max(0, i - 6), i + 5).join("\n");
    kinds.push(
      FILTERED.test(window)
        ? "FILTERED"
        : POINT.test(window)
          ? "POINT"
          : SINGLETON.test(window)
            ? "SINGLETON"
            : "UNFILTERED"
    );
  });
  return kinds;
}

const files = sourceFiles(SRC);
const sites = files.flatMap((f) =>
  classifySites(readFileSync(f, "utf8")).map((kind) => ({
    file: relative(SRC, f),
    kind,
  }))
);

describe("app agents stay out of agent rosters (notAnAppAgent)", () => {
  it("the scan sees the agent queries (non-vacuity + self-check)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(sites.length).toBeGreaterThanOrEqual(30);
    expect(sites.filter((s) => s.kind === "FILTERED").length).toBeGreaterThan(
      5
    );
    // The classifier still recognises each shape it claims to.
    expect(
      classifySites(`db.select().from(users)\n  .where(eq(users.userType, "agent"));`)
    ).toEqual(["UNFILTERED"]);
    expect(
      classifySites(
        `.where(and(eq(users.userType, "agent"), notAnAppAgent(users.id)))`
      )
    ).toEqual(["FILTERED"]);
    expect(
      classifySites(`and(eq(users.id, x), eq(users.userType, "agent"))`)
    ).toEqual(["POINT"]);
    expect(classifySites(` * a \`users\` row with \`user_type = 'agent'\``)).toEqual(
      []
    );
  });

  it("every unfiltered agent roster is listed with a reason — and only those", () => {
    const unfiltered: Record<string, number> = {};
    for (const s of sites) {
      if (s.kind !== "UNFILTERED") continue;
      unfiltered[s.file] = (unfiltered[s.file] ?? 0) + 1;
    }
    const listed = Object.fromEntries(
      Object.entries(INCLUDES_APP_AGENTS).map(([f, v]) => [f, v.sites])
    );
    expect(unfiltered).toEqual(listed);
  });

  it("each listed exception still exists and says why", () => {
    for (const [file, { reason }] of Object.entries(INCLUDES_APP_AGENTS)) {
      expect(files.map((f) => relative(SRC, f))).toContain(file);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
