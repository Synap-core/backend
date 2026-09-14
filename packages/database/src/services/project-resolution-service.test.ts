/**
 * Unit tests for `resolveProjectPlacement` — the deterministic project ladder
 * (explicit → session → channel → relational majority), exercised against a mock
 * db. There is NO AI rung by design: an AI-guessed project must never be
 * auto-linked (it would WIDEN cross-workspace access), so the resolver only ever
 * returns real context — the caller owns the AI advisory lane.
 *
 * NOTE (same harness limit the workspace-resolution test documents): the
 * `focusSessions` and `channels` schema-barrel bindings resolve to `undefined`
 * under vitest's ESM source transform (a pre-existing circular-import artifact in
 * @synap/database's schema barrel), so building `eq(focusSessions.id, …)` throws
 * in-harness. Rungs 2 & 3 are therefore proven through the wired capture /
 * entities / materializer call sites, not here. Rungs 1 and 4 — the pure ladder
 * precedence and the majority tally — are fully covered below.
 */
import { describe, it, expect } from "vitest";
import { resolveProjectPlacement } from "./project-resolution-service.js";
import { runWithDerivedSession } from "../utils/request-write-context.js";

const USER = "user-1";
const PROJ_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJ_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface Seed {
  /** `belongs_to_project` edges: sourceEntityId is implicit; only the target (project) matters for the tally. */
  membershipEdges?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(seed: Seed = {}): any {
  return {
    query: {
      relations: {
        findMany: async () =>
          (seed.membershipEdges ?? []).map((targetEntityId) => ({
            targetEntityId,
          })),
      },
    },
  };
}

describe("resolveProjectPlacement — rung 1 (explicit)", () => {
  it("explicit project wins, no DB lookup", async () => {
    const r = await resolveProjectPlacement(makeDb(), {
      userId: USER,
      explicitProjectId: PROJ_A,
    });
    expect(r).toEqual({
      projectId: PROJ_A,
      rung: 1,
      reason: "explicit project supplied by the caller",
    });
  });

  it("a nullish explicit id is 'not provided' (no pod-wide-project concept) → falls through", async () => {
    const r = await resolveProjectPlacement(makeDb(), {
      userId: USER,
      explicitProjectId: null,
    });
    expect(r.projectId).toBeNull();
    expect(r.rung).toBeNull();
  });
});

describe("resolveProjectPlacement — rung 2 and the DERIVED session (A1)", () => {
  const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  // A session row that IS scoped to a project, so the fixture discriminates:
  // the derived and explicit cases differ ONLY in `sessionSource`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sessionDb(): any {
    const db = makeDb();
    db.query.focusSessions = {
      findFirst: async () => ({ projectId: PROJ_A }),
    };
    return db;
  }

  it("(b) an EXPLICIT session with a project places the write (rung 2)", async () => {
    const r = await resolveProjectPlacement(sessionDb(), {
      userId: USER,
      sessionId: SESSION,
      sessionSource: "explicit",
    });
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(2);
  });

  it("an omitted sessionSource is explicit — pre-existing callers are unchanged", async () => {
    const r = await resolveProjectPlacement(sessionDb(), {
      userId: USER,
      sessionId: SESSION,
    });
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(2);
  });

  it("(a) a DERIVED session with a project contributes NO project", async () => {
    const r = await resolveProjectPlacement(sessionDb(), {
      userId: USER,
      sessionId: SESSION,
      sessionSource: "derived",
    });
    expect(r).toEqual({
      projectId: null,
      rung: null,
      reason: "no deterministic project context",
    });
  });

  it("(d) a DERIVED session + a declared focus → the focus places (rung 3.5)", async () => {
    const r = await resolveProjectPlacement(sessionDb(), {
      userId: USER,
      sessionId: SESSION,
      sessionSource: "derived",
      focusProjectId: PROJ_B,
    });
    expect(r.projectId).toBe(PROJ_B);
    expect(r.rung).toBe(3.5);
  });
});

describe("resolveProjectPlacement — the request's GUESSED session (write context)", () => {
  const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sessionDb(): any {
    const db = makeDb();
    db.query.focusSessions = {
      findFirst: async () => ({ projectId: PROJ_A }),
    };
    return db;
  }

  it("no source, sessionId IS the guessed session → NONE", async () => {
    const r = await runWithDerivedSession(SESSION, () =>
      resolveProjectPlacement(sessionDb(), { userId: USER, sessionId: SESSION })
    );
    expect(r.projectId).toBeNull();
    expect(r.rung).toBeNull();
  });

  it("DISCRIMINATING: the same id named EXPLICITLY inside the scope still places", async () => {
    const r = await runWithDerivedSession(SESSION, () =>
      resolveProjectPlacement(sessionDb(), {
        userId: USER,
        sessionId: SESSION,
        sessionSource: "explicit",
      })
    );
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(2);
  });

  it("a DIFFERENT session inside the scope still places", async () => {
    const r = await runWithDerivedSession(SESSION, () =>
      resolveProjectPlacement(sessionDb(), { userId: USER, sessionId: OTHER })
    );
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(2);
  });

  it("outside any scope the same id places — the guess is per request", async () => {
    const r = await resolveProjectPlacement(sessionDb(), {
      userId: USER,
      sessionId: SESSION,
    });
    expect(r.projectId).toBe(PROJ_A);
  });
});

describe("resolveProjectPlacement — rung 3.5 (declared agent focus)", () => {
  it("a declared focus places when nothing more specific pinned a project", async () => {
    const r = await resolveProjectPlacement(makeDb(), {
      userId: USER,
      focusProjectId: PROJ_A,
    });
    expect(r).toEqual({
      projectId: PROJ_A,
      rung: 3.5,
      reason: "the acting agent declared this project as its working focus",
    });
  });

  it("an EXPLICIT per-call pin still wins over the sticky focus (rung 1)", async () => {
    const r = await resolveProjectPlacement(makeDb(), {
      userId: USER,
      explicitProjectId: PROJ_A,
      focusProjectId: PROJ_B,
    });
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(1);
  });

  it("a DECLARATION beats relational gravity — rung 3.5 runs before rung 4", async () => {
    // The batch's neighbours all belong to B; the agent declared A. A wins:
    // an inference must never override a declaration.
    const r = await resolveProjectPlacement(
      makeDb({ membershipEdges: [PROJ_B, PROJ_B] }),
      {
        userId: USER,
        focusProjectId: PROJ_A,
        relatedEntityIds: ["e1", "e2"],
      }
    );
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(3.5);
  });

  it("NO focus declared → the ladder still abstains (there is no project default)", async () => {
    // The load-bearing property: workspace placement may default, project
    // placement must not — `belongs_to_project` WIDENS cross-workspace access.
    const r = await resolveProjectPlacement(makeDb(), {
      userId: USER,
      focusProjectId: null,
    });
    expect(r).toEqual({
      projectId: null,
      rung: null,
      reason: "no deterministic project context",
    });
  });
});

describe("resolveProjectPlacement — rung 4 (relational gravity)", () => {
  it("strict majority project among related entities → rung 4", async () => {
    // A appears twice, B once → A is the strict majority.
    const r = await resolveProjectPlacement(
      makeDb({ membershipEdges: [PROJ_A, PROJ_A, PROJ_B] }),
      { userId: USER, relatedEntityIds: ["e1", "e2", "e3"] }
    );
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(4);
  });

  it("a tie (no strict majority) → honest abstain, no placement", async () => {
    const r = await resolveProjectPlacement(
      makeDb({ membershipEdges: [PROJ_A, PROJ_B] }),
      { userId: USER, relatedEntityIds: ["e1", "e2"] }
    );
    expect(r.projectId).toBeNull();
    expect(r.rung).toBeNull();
  });

  it("no membership edges among related entities → no placement", async () => {
    const r = await resolveProjectPlacement(makeDb({ membershipEdges: [] }), {
      userId: USER,
      relatedEntityIds: ["e1", "e2"],
    });
    expect(r.projectId).toBeNull();
    expect(r.rung).toBeNull();
  });

  it("no related entities supplied → no placement (rung 4 never runs)", async () => {
    const r = await resolveProjectPlacement(makeDb(), { userId: USER });
    expect(r).toEqual({
      projectId: null,
      rung: null,
      reason: "no deterministic project context",
    });
  });
});
