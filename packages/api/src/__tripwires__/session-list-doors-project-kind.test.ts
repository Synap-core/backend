/**
 * TRIPWIRE — a session LIST projects BOTH derived lenses, or says why not.
 *
 * `focus_sessions` holds three populations (a person's work, machine runs, and
 * the containers an agent's writes are filed under) and one derived acceptance
 * state (triage). Neither is stored: both are DERIVED, by `session-kind.ts` and
 * `triage.ts`, precisely so a second copy of the rule cannot exist. That only
 * holds if every door that hands a page of sessions to a consumer attaches the
 * projections — a door that does not forces its consumer to re-derive from
 * `origin` + `playbookId` + `metadata`, and that re-derivation IS the second,
 * drifting copy. It has already happened on this codebase with a proposal class
 * that matched `run` while the executor wrote `capability.run`.
 *
 * Source-parsed on purpose: it must fail in CI without a database, at the point
 * of EDIT rather than when a receipt quietly starts showing up in somebody's
 * working list.
 *
 * NOT every read of `focus_sessions` is a list door. A narrow projection that
 * never returns a session row (a run ledger's unified row, a place feed's
 * summary, an ambient-session resolver) has nothing to attach a lens to. Those
 * declare themselves with an inline `SESSION-KIND-LENS-EXEMPT:` marker plus a
 * reason, so an exemption is a sentence somebody wrote rather than a silence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");

const EXEMPT_MARKER = "SESSION-KIND-LENS-EXEMPT:";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * A session LIST read: it selects FROM `focus_sessions` and orders the result
 * — i.e. it produces a PAGE, which is the only shape a lens applies to.
 */
function isSessionListRead(src: string): boolean {
  return (
    src.includes(".from(focusSessions)") &&
    /\.orderBy\(\s*desc\(focusSessions\./.test(src)
  );
}

/**
 * The shared row projection — `projectSessionRows`
 * (`services/focus-sessions/session-list-rows.ts`) — attaches both lenses for
 * every door that projects through it (tRPC `list` / `browse` / `graph`). A
 * door that calls it is covered; the projection itself is pinned below, so
 * the delegation cannot quietly hollow out.
 */
const SHARED_PROJECTION_CALL = /\bprojectSessionRows\s*\(/;
const SHARED_PROJECTION_FILE = join(
  API_SRC,
  "services/focus-sessions/session-list-rows.ts"
);

const FILES = walk(API_SRC)
  .filter((f) => !f.includes("__tests__") && !f.includes("__tripwires__"))
  .filter((f) => !f.endsWith(".test.ts"));

describe("every focus-session list door projects kind + triage", () => {
  const listReads = FILES.filter((f) =>
    isSessionListRead(readFileSync(f, "utf8"))
  );

  it("finds the list doors at all (the scan is not silently empty)", () => {
    // If a refactor renames the table binding or the order-by, this scan would
    // go quiet and pass forever — the classic false-green for a source scan.
    expect(listReads.length).toBeGreaterThanOrEqual(3);
    const rels = listReads.map((f) => relative(API_SRC, f));
    expect(rels).toContain("routers/focus-sessions.ts");
    expect(rels).toContain("routers/hub-protocol/rest/focus-sessions.ts");
    expect(rels).toContain("routers/mcp/handlers/session.ts");
  });

  for (const file of listReads) {
    const rel = relative(API_SRC, file);
    it(`${rel} attaches both projections or documents an exemption`, () => {
      const src = readFileSync(file, "utf8");
      if (src.includes(EXEMPT_MARKER)) {
        // An exemption must carry a REASON on the same line, not a bare token.
        const line = src
          .split("\n")
          .find((l) => l.includes(EXEMPT_MARKER))!
          .split(EXEMPT_MARKER)[1]
          .trim();
        expect(
          line.length,
          `${rel}: ${EXEMPT_MARKER} needs a reason on the same line`
        ).toBeGreaterThan(20);
        return;
      }
      if (SHARED_PROJECTION_CALL.test(src)) return;
      expect(src, `${rel} must call attachTriage`).toContain("attachTriage");
      expect(src, `${rel} must call attachSessionKind`).toContain(
        "attachSessionKind"
      );
    });
  }
});

describe("the shared row projection attaches both lenses", () => {
  it("projectSessionRows calls attachTriage and attachSessionKind", () => {
    const src = readFileSync(SHARED_PROJECTION_FILE, "utf8");
    const start = src.indexOf("export async function projectSessionRows(");
    expect(start, "projectSessionRows moved — update this pin").toBeGreaterThan(
      -1
    );
    // Its body: up to the next top-level declaration.
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(?:export )?(?:async )?function /);
    const body = end === -1 ? rest : rest.slice(0, end);
    expect(body).toMatch(/\battachTriage\(/);
    expect(body).toMatch(/\battachSessionKind\(/);
  });
});

/**
 * The two defaults are DELIBERATELY different, and the asymmetry is the kind of
 * thing a tidy-up silently "fixes". Pinned at the source so flipping either one
 * is a decision somebody makes on purpose.
 */
describe("the human door defaults to work, the agent doors default to all", () => {
  it("tRPC focusSessions.list defaults kind to `work`", () => {
    const src = readFileSync(
      join(API_SRC, "routers/focus-sessions.ts"),
      "utf8"
    );
    expect(src).toMatch(
      /z\s*\n?\s*\.enum\(\[\.\.\.SESSION_KINDS, "all"\]\)\s*\n?\s*\.default\("work"\)/
    );
  });

  it("Hub REST list defaults kind to `all`", () => {
    const src = readFileSync(
      join(API_SRC, "routers/hub-protocol/rest/focus-sessions.ts"),
      "utf8"
    );
    expect(src).toContain('c.req.query("kind") ?? "all"');
  });

  it("MCP synap_list_sessions defaults kind to `all`", () => {
    const src = readFileSync(
      join(API_SRC, "routers/mcp/handlers/session.ts"),
      "utf8"
    );
    expect(src).toContain('(args.kind as string | undefined) ?? "all"');
  });
});
