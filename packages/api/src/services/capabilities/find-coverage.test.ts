/**
 * TRIPWIRE — every kind a bare id can OPEN is FINDABLE by its words, or says
 * why not.
 *
 * `resolveObjectKind` (`PROBE_ORDER`) is the list of kinds `/open/<id>` and
 * `diagnose` can open. `synap_find` used to search four catalogs (verbs,
 * intents, playbooks, spaces), so a skill, a rule, an automation, a session, a
 * goal, a view or a document could be opened by id and found by nobody — the
 * live miss where "how do I build a custom UI" never reached the synap-ui
 * skill (finding cb91b095).
 *
 * The set is DERIVED: the runtime check iterates the real `PROBE_ORDER`
 * export, and `COVERAGE` is typed `Record<ObjectKind, …>`, so a new kind fails
 * the build until it is classified. Each kind is either:
 *   - `catalog`: a `FIND_CATALOGS` member, proven REACHABLE below — a row seeded
 *     at that catalog's real I/O boundary comes back out of `findByIntent` as a
 *     match with its id and (for an object catalog) an `/open/<id>` link; or
 *   - `exempt`: a reason, stated here, why a text search is not its door.
 *
 * WHAT IS REAL: `findByIntent`, `searchObjectCatalogs` and every object
 * catalog reader (their selects, floors and the JS ranker), `rankByTerms`.
 * WHAT IS STUBBED: the record index (`searchService.searchCollection`; its
 * floor is proven on PGlite in `find-objects.grants.pglite.test.ts`), `db` (rows per TABLE, whatever the predicate — so this
 * proves the reader reaches its table and shapes the row, NOT the floor SQL;
 * `find-objects.pglite.test.ts` proves the floors on a real Postgres), the
 * skills door (`searchInstructionSkills`, which has its own PGlite suites), and
 * the three pre-existing arms' reads (`listCapabilities`,
 * `matchSessionTemplate`, `listSpaceCandidates`).
 *
 * NOT COVERED, measured: ranking quality. A catalog that returns the seeded
 * row for its exact title passes; whether it ranks well among many rows is the
 * PGlite suite's question.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
}));

vi.mock("@synap/database", async (orig) => {
  const actual = await orig<typeof import("@synap/database")>();
  // Every builder step returns the chain; awaiting it (at any step) yields the
  // rows seeded for the table named in `.from()`.
  const chainFor = (table: unknown) => {
    const rows = () => h.rows.get(table) ?? [];
    const chain: Record<string, unknown> = {};
    for (const step of [
      "where",
      "orderBy",
      "limit",
      "offset",
      "innerJoin",
      "leftJoin",
      "groupBy",
    ]) {
      chain[step] = () => chain;
    }
    chain.then = (
      resolve: (v: unknown[]) => unknown,
      reject: (e: unknown) => unknown
    ) => Promise.resolve(rows()).then(resolve, reject);
    return chain;
  };
  return {
    ...actual,
    db: {
      select: () => ({ from: (table: unknown) => chainFor(table) }),
      selectDistinct: () => ({ from: (table: unknown) => chainFor(table) }),
    },
  };
});

const searchInstructionSkills = vi.fn();
vi.mock("../skills/search.js", () => ({
  searchInstructionSkills: (...a: unknown[]) => searchInstructionSkills(...a),
}));
const listCapabilities = vi.fn();
vi.mock("./capability-registry.js", () => ({
  listCapabilities: (...a: unknown[]) => listCapabilities(...a),
}));
vi.mock("./intent-registry.js", () => ({
  listIntentSlugs: async () => [],
  listIntentRows: async () => [],
}));
const matchSessionTemplate = vi.fn();
vi.mock("../focus-sessions/match-session-template.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  matchSessionTemplate: (...a: unknown[]) => matchSessionTemplate(...a),
}));
const listSpaceCandidates = vi.fn();
const searchCollection = vi.fn();
vi.mock("@synap/search", () => ({
  searchService: {
    searchCollection: (...a: unknown[]) => searchCollection(...a),
  },
}));
vi.mock("../discover/space-catalog.js", () => ({
  listSpaceCandidates: (...a: unknown[]) => listSpaceCandidates(...a),
}));

import {
  automations,
  documents,
  entities,
  focusSessions,
  projects,
  projectTracks,
  views,
} from "@synap/database";
import type { ObjectKind } from "../diagnose/types.js";
import { PROBE_ORDER } from "../diagnose/resolve-object-kind.js";
import { invalidateCapabilityReadCaches } from "./capability-read-caches.js";
import {
  FIND_CATALOGS,
  findByIntent,
  type FindByIntentResult,
  type FindCatalog,
} from "./find-intent.js";

const ID = "00000000-0000-4000-8000-0000000000aa";
const WORD = "zebracorn";
const TITLE = `Zebracorn pipeline`;

type Coverage =
  | {
      catalog: FindCatalog;
      /** Put one row titled TITLE with id ID at the catalog's I/O boundary. */
      seed: () => void;
      /** The id of the first match, read off the door's own answer. */
      hit: (r: FindByIntentResult) => { id?: string; open?: string };
    }
  | { exempt: string };

/** First row of an object catalog block, or nothing (an error or no match). */
function objectHit(catalog: FindCatalog) {
  return (r: FindByIntentResult) => {
    const block = (r as unknown as Record<string, unknown>)[catalog] as
      | { matches?: Array<{ id: string; open: string; title: string }> }
      | undefined;
    const m = block?.matches?.[0];
    return m ? { id: m.id, open: m.open } : {};
  };
}

const COVERAGE: Record<ObjectKind, Coverage> = {
  proposal: {
    exempt:
      "A proposal is a pending change waiting for a person, not a thing that says how. Its doors are the review queue (synap_list_proposals, synap_needs_you, orient) and diagnose by id; a text search would compete with the queue's own order.",
  },
  session: {
    catalog: "sessions",
    seed: () =>
      h.rows.set(focusSessions, [
        { id: ID, title: TITLE, goal: "ship it", status: "active" },
      ]),
    hit: objectHit("sessions"),
  },
  capability: {
    // `capability` spans three tables: a registered verb (this catalog), a
    // bare skill (the `skills` catalog, asserted by the skill row below) and
    // a bare tool (listed by the registry, so also this catalog).
    catalog: "capabilities",
    seed: () =>
      listCapabilities.mockResolvedValue([
        {
          id: "cap-1",
          name: "Zebra",
          kind: "source-provider",
          description: null,
          inputSchema: {},
          executor: "provider",
          governance: "auto",
          enabled: true,
          verbs: [
            {
              id: ID,
              label: TITLE,
              kind: "action",
              granted: true,
              govDefault: "auto",
              effectiveExecMode: "auto",
              backingSkillExecutable: true,
            },
          ],
        },
      ]),
    hit: (r) => ({ id: r.capabilities?.matches[0]?.action.verbId }),
  },
  automation_run: {
    exempt:
      "A run is an execution record of an automation, with no words of its own (its name is the definition's). Find the automation (the automations catalog), then read its runs with diagnose or get_flow.",
  },
  playbook_run: {
    exempt:
      "A run is one execution of a playbook, named by its definition. Find the playbook (the playbooks catalog), then read its runs through the playbook or diagnose by id.",
  },
  automation: {
    catalog: "automations",
    seed: () =>
      h.rows.set(automations, [
        {
          id: ID,
          name: TITLE,
          description: null,
          triggerType: "cron",
          status: "active",
          workspaceId: null,
        },
      ]),
    hit: objectHit("automations"),
  },
  playbook: {
    catalog: "playbooks",
    seed: () =>
      matchSessionTemplate.mockResolvedValue({
        candidates: [
          {
            id: ID,
            name: TITLE,
            score: 3,
            reason: `You mentioned "${WORD}"`,
            scope: "session",
            templateKind: "Work template",
          },
        ],
        optOut: "pass templateId: null",
      }),
    hit: (r) => ({ id: r.playbooks?.candidates[0]?.id }),
  },
  agent: {
    exempt:
      "The agent roster is small and listed whole, with each agent's computer and status, by synap_list_agents; an agent's only words are its name.",
  },
  workspace: {
    catalog: "spaces",
    seed: () =>
      listSpaceCandidates.mockResolvedValue([
        { workspaceId: ID, name: TITLE, kinds: [] },
      ]),
    hit: (r) => ({
      id:
        r.spaces && "matches" in r.spaces
          ? r.spaces.matches[0]?.workspaceId
          : undefined,
    }),
  },
  project: {
    catalog: "projects",
    seed: () =>
      h.rows.set(projects, [
        {
          id: ID,
          name: TITLE,
          description: null,
          status: "active",
          workspaceId: null,
        },
      ]),
    hit: objectHit("projects"),
  },
  track: {
    catalog: "goals",
    seed: () =>
      h.rows.set(projectTracks, [
        {
          id: ID,
          name: TITLE,
          status: "active",
          projectName: "Synap",
          workspaceId: null,
        },
      ]),
    hit: objectHit("goals"),
  },
  channel: {
    exempt:
      "A room belongs to its owner (a session's channelId, an entity's thread) and opens through it; its words are messages, which are content recall (synap_ask, synap_get_thread_context), not a thing to find by name.",
  },
  view: {
    catalog: "views",
    seed: () =>
      h.rows.set(views, [
        {
          id: ID,
          name: TITLE,
          description: null,
          type: "kanban",
          workspaceId: null,
        },
      ]),
    hit: objectHit("views"),
  },
  document: {
    catalog: "documents",
    seed: () =>
      h.rows.set(documents, [
        { id: ID, title: TITLE, type: "markdown", workspaceId: null },
      ]),
    hit: objectHit("documents"),
  },
  entity: {
    // Was exempt ("a second, lexical entity ranker here would fork synap_ask's
    // engine"). The catalog answers that reason instead of overriding it: it
    // reads the engine's own keyword half in its own order (no rankByTerms),
    // floored by the helper hybrid recall uses (intent bar W1, decision D4).
    catalog: "entities",
    seed: () => {
      searchCollection.mockResolvedValue({
        results: [
          {
            id: ID,
            collection: "entities",
            document: { id: ID, title: TITLE, entityType: "person" },
            textMatch: 100,
          },
        ],
        found: 1,
        searchTimeMs: 1,
      });
      // The floor read (`visibleEntityIds`) reaches the entities table.
      h.rows.set(entities, [{ id: ID }]);
    },
    hit: objectHit("entities"),
  },
  external_send: {
    exempt:
      "Not in PROBE_ORDER: an external send has no row of its own and resolves only by its correlationId (diagnose's fallback); there is nothing with words to search.",
  },
};

beforeEach(() => {
  h.rows.clear();
  invalidateCapabilityReadCaches();
  searchCollection
    .mockReset()
    .mockResolvedValue({ results: [], found: 0, searchTimeMs: 0 });
  searchInstructionSkills.mockReset().mockResolvedValue({
    rows: [],
    total: 0,
    matches: new Map(),
  });
  listCapabilities.mockReset().mockResolvedValue([]);
  matchSessionTemplate
    .mockReset()
    .mockResolvedValue({ candidates: [], optOut: "pass templateId: null" });
  listSpaceCandidates.mockReset().mockResolvedValue([]);
});

describe("tripwire: every openable kind has a find catalog or a reasoned exemption", () => {
  it("reads the real PROBE_ORDER (non-vacuity)", () => {
    expect(PROBE_ORDER.length).toBeGreaterThanOrEqual(15);
    expect(PROBE_ORDER).toContain("entity");
    expect(PROBE_ORDER).toContain("session");
  });

  it.each([...PROBE_ORDER])("%s is classified", (kind) => {
    const c = COVERAGE[kind];
    expect(c, `${kind} has no find catalog and no exemption`).toBeDefined();
    if ("exempt" in c) {
      expect(c.exempt.length).toBeGreaterThan(60);
    } else {
      expect(
        FIND_CATALOGS as readonly string[],
        `${kind} names catalog "${c.catalog}", which find no longer searches`
      ).toContain(c.catalog);
    }
  });

  it("most openable kinds are findable (a floor, so exemptions cannot quietly take over)", () => {
    // 10 of the 15 probed kinds (entity joined in W1); the floor stops a
    // catalog being swapped for an exemption without this line moving.
    const covered = PROBE_ORDER.filter((k) => "catalog" in COVERAGE[k]);
    expect(covered.length).toBeGreaterThanOrEqual(10);
  });

  it.each(PROBE_ORDER.filter((k) => "catalog" in COVERAGE[k]))(
    "%s is REACHABLE: a seeded row comes back out of findByIntent",
    async (kind) => {
      const c = COVERAGE[kind] as Extract<Coverage, { catalog: FindCatalog }>;
      c.seed();
      const r = await findByIntent({
        intent: WORD,
        userId: "user-1",
        workspaceId: null,
        catalogs: [c.catalog],
      });
      const hit = c.hit(r);
      expect(hit.id, `${kind}: ${JSON.stringify(r).slice(0, 400)}`).toBe(ID);
      if (hit.open !== undefined) expect(hit.open).toMatch(`/open/${ID}`);
    }
  );

  it("a bare skill and a rule (the rest of `capability`) are reachable through the skills catalog", async () => {
    searchInstructionSkills.mockResolvedValue({
      rows: [
        {
          id: ID,
          name: TITLE,
          slug: "team/zebracorn",
          description: "How we build zebracorns",
          tags: [],
          topics: [],
          workspaceId: null,
        },
        {
          id: "00000000-0000-4000-8000-0000000000bb",
          name: "Zebracorn rule",
          slug: "rules/zebracorn",
          description: null,
          tags: ["rule"],
          topics: [],
          workspaceId: null,
        },
      ],
      total: 2,
      matches: new Map(),
    });
    const r = await findByIntent({
      intent: WORD,
      userId: "user-1",
      workspaceId: null,
      catalogs: ["skills"],
    });
    const matches = r.skills && "matches" in r.skills ? r.skills.matches : [];
    expect(matches.map((m) => [m.kind, m.ref])).toEqual(
      expect.arrayContaining([
        ["skill", "team/zebracorn"],
        ["rule", "rules/zebracorn"],
      ])
    );
    expect(matches.every((m) => m.open.endsWith(`/open/${m.id}`))).toBe(true);
  });

  it("a catalog whose read throws is `error`, never `matches: []`, and does not sink the others", async () => {
    searchInstructionSkills.mockRejectedValue(new Error("skills down"));
    (COVERAGE.view as Extract<Coverage, { catalog: FindCatalog }>).seed();
    const r = await findByIntent({
      intent: WORD,
      userId: "user-1",
      workspaceId: null,
      catalogs: ["skills", "views"],
    });
    expect(r.skills).toEqual({ error: "skills down" });
    expect(objectHit("views")(r).id).toBe(ID);
  });
});
