/**
 * ONE WHERE clause for every `focus_sessions` list door.
 *
 * `sessionListConditions` was lifted out of the tRPC router so the Hub REST
 * list door would stop hand-writing its twin: a single-value status `eq`,
 * triage, kind and flow, copied, and already unable to express a status set or
 * a recency window. These tests pin what the doors must share and where they
 * legitimately differ.
 *
 * DB-free: the real operators build real SQL and the assertions read it,
 * the way `owed-outputs.test.ts` and `session-status-filter.test.ts` do. Param
 * numbering differs by position, so sub-clauses are compared with `$n`
 * normalised away.
 *
 * The discriminating fixtures are the DEFAULTS pair. The tRPC door (a person's
 * work surface) relies on `lens: "default"` and `kind: "work"`; the Hub REST
 * door (an agent) passes `"all"` for both. A shared function that ignored its
 * arguments, or hard-coded either door's defaults, passes one half and fails
 * the other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { and } from "@synap/database";
import type { SQL } from "@synap/database";
import { sessionListConditions } from "../session-list-conditions.js";
import { notTriagePendingWhere, triagePendingWhere } from "../triage.js";
import { sessionKindWhere } from "../session-kind.js";

const dialect = new PgDialect();
const sqlOf = (conds: SQL[]) => dialect.sqlToQuery(and(...conds) as SQL);
const shape = (text: string) => text.replace(/\$\d+/g, "$");
const clause = (s: SQL) => shape(dialect.sqlToQuery(s).sql);

const USER = "user-1";
const WS = "ws-1";

describe("the tRPC door's defaults", () => {
  const q = sqlOf(
    sessionListConditions({
      userId: USER,
      scope: { workspaceLens: undefined, projectLens: undefined },
      status: "all",
    })
  );

  it("hides undecided agent drafts by default", () => {
    expect(shape(q.sql)).toContain(clause(notTriagePendingWhere()));
  });

  it("narrows to the person's WORK population by default", () => {
    expect(shape(q.sql)).toContain(clause(sessionKindWhere("work")));
  });

  it("always floors on the caller", () => {
    expect(q.sql).toMatch(/"focus_sessions"\."user_id" = \$\d+/);
    expect(q.params).toContain(USER);
  });
});

describe("the Hub REST door's arguments", () => {
  const conds = sessionListConditions({
    userId: USER,
    scope: { workspaceLens: WS, projectLens: undefined },
    status: "stale",
    lens: "all",
    kind: "all",
    flow: {},
  });
  const q = sqlOf(conds);

  it("adds NO triage clause for lens 'all' — an agent wants its own drafts", () => {
    expect(shape(q.sql)).not.toContain(clause(notTriagePendingWhere()));
    expect(shape(q.sql)).not.toContain(clause(triagePendingWhere()));
  });

  it("adds NO kind clause for kind 'all' — an agent wants its runs and receipts", () => {
    expect(shape(q.sql)).not.toContain(clause(sessionKindWhere("work")));
  });

  it("keeps the workspace it was given and the status it asked for", () => {
    expect(q.sql).toMatch(/"focus_sessions"\."workspace_id" = \$\d+/);
    expect(q.params).toEqual(expect.arrayContaining([USER, WS, "stale"]));
  });
});

describe("search", () => {
  it("is a case-insensitive substring with its wildcards escaped", () => {
    const q = sqlOf(
      sessionListConditions({
        userId: USER,
        scope: { workspaceLens: undefined, projectLens: undefined },
        status: "all",
        q: "  50%_off  ",
      })
    );
    // The NAME the list shows (title) OR the goal — a session titled
    // "Relay theme" whose goal never says "relay" is still found.
    expect(q.sql).toMatch(
      /\("focus_sessions"\."title" ilike \$\d+ or "focus_sessions"\."goal" ilike \$\d+\)/
    );
    // Trimmed, then `%` and `_` escaped so they match literally.
    expect(q.params).toContain("%50\\%\\_off%");
  });

  it("adds nothing for an empty or whitespace-only term", () => {
    const base = sessionListConditions({
      userId: USER,
      scope: { workspaceLens: undefined, projectLens: undefined },
      status: "all",
    });
    const blank = sessionListConditions({
      userId: USER,
      scope: { workspaceLens: undefined, projectLens: undefined },
      status: "all",
      q: "   ",
    });
    expect(blank).toHaveLength(base.length);
  });
});

describe("the Hub REST list door does not hand-write its own copy again", () => {
  /**
   * A SOURCE guard, and its limit is stated: it proves the REST file calls the
   * shared function and no longer contains the hand-mirrored status filter. It
   * cannot prove a future reviewer did not add a different second filter.
   * Comments are stripped first, so prose that quotes the old line cannot
   * satisfy or fail it.
   */
  const src = readFileSync(
    join(__dirname, "../../../routers/hub-protocol/rest/focus-sessions.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("NON-VACUITY: the file was read", () => {
    expect(src).toMatch(/export function registerFocusSessionsRoutes/);
  });

  it("builds its list WHERE clause through sessionListConditions", () => {
    expect(src).toMatch(/sessionListConditions\(\{/);
  });

  it("no longer hand-writes a status, triage or kind filter", () => {
    expect(src).not.toMatch(/conditions\.push\(eq\(focusSessions\.status/);
    expect(src).not.toMatch(
      /conditions\.push\((?:not)?[Tt]riagePendingWhere\(\)\)/
    );
    expect(src).not.toMatch(/conditions\.push\(sessionKindWhere\(/);
  });
});

describe("unfiled — Home's sessions with no project", () => {
  const IS_NULL = /"focus_sessions"\."project_id" is null/;

  it("narrows to projectId IS NULL when asked", () => {
    const q = sqlOf(
      sessionListConditions({
        userId: USER,
        scope: { workspaceLens: undefined, projectLens: undefined },
        status: "all",
        unfiled: true,
      })
    );
    expect(q.sql).toMatch(IS_NULL);
  });

  it("a null project lens still means NO narrow, not unfiled", () => {
    // Rules out the tempting fix of re-reading `projectId: null` as "none",
    // which would change every other door that shares the scope filter.
    const q = sqlOf(
      sessionListConditions({
        userId: USER,
        scope: { workspaceLens: undefined, projectLens: null },
        status: "all",
      })
    );
    expect(q.sql).not.toMatch(IS_NULL);
    expect(q.sql).not.toMatch(/"project_id"/);
  });

  it("composes with a workspace lens", () => {
    const q = sqlOf(
      sessionListConditions({
        userId: USER,
        scope: { workspaceLens: WS, projectLens: undefined },
        status: "all",
        unfiled: true,
      })
    );
    expect(q.sql).toMatch(IS_NULL);
    expect(q.params).toContain(WS);
  });
});
