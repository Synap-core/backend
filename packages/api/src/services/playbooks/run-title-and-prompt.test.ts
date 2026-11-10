import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A run session's TITLE and its agent PROMPT are two different strings.
 *
 * `focus_sessions.goal` used to hold the rendered `goalTemplate`, which the
 * executor then handed the agent as its kickoff prompt — so every run row in
 * every list (runs feed, unblock notifications, diagnose, the run channel's
 * name) rendered as a paragraph. `goal` is now the title
 * (`<playbook> for <subject>`) and the rendered template lives on
 * `metadata.prompt`.
 *
 * The SEAM test below is the one that matters: it drives the real `runPlaybook`
 * through the real `instantiateSession` into a captured executor, so the title
 * write and the prompt read are exercised together with nothing hand-built in
 * between. Reverting either half fails it (negative controls in the report).
 */

// ── Fake db ────────────────────────────────────────────────────────────────
// Table-aware: `insert(table)` and `update(table)` dispatch on the table object
// identity imported from the real module, so a schema rename cannot make this
// silently watch the wrong table.
type Row = Record<string, unknown>;

const inserted: Array<{ table: unknown; values: Row }> = [];

const PLAYBOOK = {
  id: "pb-1",
  workspaceId: "ws-1",
  name: "CRM hygiene",
  goalTemplate:
    "You are the CRM hygiene maintenance agent, running unattended. Review @{arg:scope} and fix stale fields.",
  stages: [
    {
      key: "fix",
      criteria: [
        {
          key: "no-stale",
          statement: "No contact is stale",
          check: { kind: "judge" },
        },
      ],
    },
  ],
  criteria: [
    {
      key: "typecheck",
      statement: "Typecheck passes",
      check: { kind: "evidence", evidenceKey: "typecheck" },
    },
  ],
  params: [],
  expectedOutputs: [],
  executor: "is-agent",
  inputStrategy: null,
  channelSpec: {},
  metadata: {},
  version: 1,
};

const ENTITY = { id: "ent-1", title: "Acme Corp", type: "company" };

function makeDb() {
  const fake = {
    // A promoted playbook's row and its kept version (0416) share one
    // transaction.
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fake),
    query: {
      playbooks: { findFirst: async () => PLAYBOOK },
      entities: { findFirst: async () => ENTITY },
      focusSessions: {
        findFirst: async () =>
          // Re-load after the channel wiring (run-playbook §6) — return the row
          // the insert produced so the returned session is the real one.
          inserted.find((i) => i.values.playbookId === PLAYBOOK.id)?.values ??
          undefined,
      },
      channels: { findFirst: async () => undefined },
    },
    insert(table: unknown) {
      return {
        values(values: Row) {
          const row = { id: `row-${inserted.length + 1}`, ...values };
          inserted.push({ table, values: row });
          const self = {
            returning: async () => [row],
            onConflictDoNothing: () => self,
            onConflictDoUpdate: async () => [row],
          };
          return self;
        },
      };
    },
    update() {
      // `.set().where()` is awaited on its own in one place and chained into
      // `.returning()` in another, so `where` must be BOTH a thenable and a
      // builder.
      const where = () => {
        const p: any = Promise.resolve([{}]);
        p.returning = async () => [{}];
        return p;
      };
      return { set: () => ({ where }) };
    },
  };
  return fake;
}

let db = makeDb();

// PARTIAL mock (`importOriginal`) — a total replacement dies at collection time
// the moment the import graph reaches an export it does not list, taking the
// whole file dark. Only `getDb` is overridden; real tables/operators are used,
// which is what makes the table-identity dispatch above meaningful.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: async () => db };
});
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
  }),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: async () => [],
  getLinksFor: async () => [],
  extractCapabilities: () => [],
  resolveGrantedCapabilities: async () => [],
}));

// Promote's tail (conversion receipt + event log) writes through its own
// connections; stubbed so the PROMOTE insert is observable here.
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("../focus-sessions/session-conversion.js", () => ({
  recordConversion: async () => ({}),
}));
vi.mock("../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: async () => undefined,
}));

const executorRun = vi.fn(async (_ctx: { goal: string }) => ({
  status: "running" as const,
}));
vi.mock("./executors/registry.js", () => ({
  resolveExecutor: () => ({ ref: "is-agent", run: executorRun }),
}));

const {
  buildRunSessionTitle,
  runWorksOnLabel,
  runPromptFor,
  RUN_PROMPT_METADATA_KEY,
  promoteSessionToPlaybook,
} = await import("./playbook-lifecycle.js");
const { runPlaybook } = await import("./run-playbook.js");
const { focusSessions, playbooks } = await import("@synap/database");

beforeEach(() => {
  inserted.length = 0;
  executorRun.mockClear();
  db = makeDb();
});

describe("buildRunSessionTitle", () => {
  it("is the playbook name when no subject is bound", () => {
    expect(buildRunSessionTitle("CRM hygiene", null)).toBe("CRM hygiene");
    expect(buildRunSessionTitle("CRM hygiene", undefined)).toBe("CRM hygiene");
    // Whitespace-only is not a subject.
    expect(buildRunSessionTitle("CRM hygiene", "   ")).toBe("CRM hygiene");
  });

  it("names the subject by its TITLE, never an id", () => {
    expect(buildRunSessionTitle("CRM hygiene", "Acme Corp")).toBe(
      "CRM hygiene for Acme Corp"
    );
  });

  it("falls back to a readable label rather than an empty title", () => {
    expect(buildRunSessionTitle("   ", "Acme Corp")).toBe(
      "Playbook run for Acme Corp"
    );
  });

  it("caps the title so a long subject name cannot restore the paragraph", () => {
    const title = buildRunSessionTitle("P", "x".repeat(2000));
    expect(title.length).toBe(300);
  });
});

describe("runWorksOnLabel (a run with no subject is named by what it works on)", () => {
  const RECIPE_ID = "1b91229e-f202-4a7a-9b57-1d6f5a48ec7c";
  const names: Record<string, string> = { [RECIPE_ID]: "Consolidate findings" };
  const nameOf = async (id: string) => names[id] ?? null;

  it("names the pod object a param's id points at, by its title", async () => {
    await expect(
      runWorksOnLabel(
        [
          { name: "recipe", type: "text", required: true },
          { name: "runs", type: "number" },
        ],
        { recipe: RECIPE_ID, runs: 10 },
        nameOf
      )
    ).resolves.toBe("Consolidate findings");
  });

  it("an id that names nothing visible is skipped, never shown", async () => {
    await expect(
      runWorksOnLabel(
        [{ name: "recipe", type: "text", required: true }],
        { recipe: "00000000-0000-4000-8000-000000000000" },
        nameOf
      )
    ).resolves.toBeNull();
  });

  it("else the first required text param's own value", async () => {
    await expect(
      runWorksOnLabel(
        [
          { name: "depth", type: "number" },
          { name: "area", type: "text", required: true },
        ],
        { depth: 2, area: "governance" },
        nameOf
      )
    ).resolves.toBe("governance");
  });

  it("else nothing: a boolean or number param does not name a run", async () => {
    await expect(
      runWorksOnLabel(
        [{ name: "dryRun", type: "boolean", required: true }],
        { dryRun: true },
        nameOf
      )
    ).resolves.toBeNull();
    await expect(runWorksOnLabel([], {}, nameOf)).resolves.toBeNull();
  });
});

describe("runPromptFor", () => {
  it("returns the stored prompt when one exists", () => {
    expect(
      runPromptFor({ goal: "Title", metadata: { prompt: "Do the thing" } })
    ).toBe("Do the thing");
  });

  it("falls back to `goal` for sessions written BEFORE the split", () => {
    // These rows have their paragraph in `goal` and nowhere else, which is why
    // no backfill is needed: they keep dispatching exactly as they did.
    expect(runPromptFor({ goal: "A whole paragraph" })).toBe(
      "A whole paragraph"
    );
    expect(runPromptFor({ goal: "A whole paragraph", metadata: {} })).toBe(
      "A whole paragraph"
    );
    expect(
      runPromptFor({ goal: "A whole paragraph", metadata: { prompt: "  " } })
    ).toBe("A whole paragraph");
    expect(
      runPromptFor({ goal: "A whole paragraph", metadata: { prompt: 42 } })
    ).toBe("A whole paragraph");
  });
});

describe("runPlaybook seam: the row gets a title, the agent gets the prompt", () => {
  it("writes the title to `goal` and the rendered template to metadata.prompt, and dispatches the PROMPT", async () => {
    await runPlaybook({
      playbookId: PLAYBOOK.id,
      workspaceId: "ws-1",
      userId: "user-1",
      subjectId: ENTITY.id,
      params: { scope: "stale contacts" },
    });

    const sessionInserts = inserted.filter((i) => i.table === focusSessions);
    // Non-vacuity: if the insert never happened, every assertion below would
    // pass on an empty list.
    expect(sessionInserts).toHaveLength(1);
    const session = sessionInserts[0].values;

    const renderedPrompt =
      "You are the CRM hygiene maintenance agent, running unattended. Review stale contacts and fix stale fields.";

    // The ROW reads as a title.
    expect(session.goal).toBe("CRM hygiene for Acme Corp");
    expect(String(session.goal)).not.toContain("unattended");
    // The display NAME is written beside the goal, derived and improvable.
    expect(session.title).toBe("CRM hygiene · Acme Corp");
    expect((session.metadata as Record<string, unknown>).titleSource).toBe(
      "derived"
    );

    // The INSTRUCTION is stored, whole, where the executor reads it.
    expect(
      (session.metadata as Record<string, unknown>)[RUN_PROMPT_METADATA_KEY]
    ).toBe(renderedPrompt);

    // The AGENT receives the instruction — not the label.
    expect(executorRun).toHaveBeenCalledTimes(1);
    expect(executorRun.mock.calls[0][0].goal).toBe(renderedPrompt);
  });

  it("keeps caller metadata (governance / chain context) alongside the prompt", async () => {
    await runPlaybook({
      playbookId: PLAYBOOK.id,
      workspaceId: "ws-1",
      userId: "user-1",
      params: {},
      chainContext: {
        automationId: "auto-1",
        automationRunId: "arun-1",
        chainDepth: 0,
        rootRunId: "arun-1",
        chainAutomationIds: ["auto-1"],
      },
    });

    const session = inserted.filter((i) => i.table === focusSessions)[0].values;
    const metadata = session.metadata as Record<string, unknown>;
    expect(metadata.automationId).toBe("auto-1");
    expect(metadata.automationRunId).toBe("arun-1");
    expect(typeof metadata[RUN_PROMPT_METADATA_KEY]).toBe("string");
    // No subject bound ⇒ the title is the bare playbook name.
    expect(session.goal).toBe("CRM hygiene");
  });

  it("a run with no subject is NAMED by what it works on; its goal is unchanged", async () => {
    const RECIPE_ID = "1b91229e-f202-4a7a-9b57-1d6f5a48ec7c";
    const withParam = {
      ...PLAYBOOK,
      params: [{ name: "recipe", type: "text", required: true }],
    };
    db.query.playbooks.findFirst = async () => withParam;
    // The param's id resolves to a playbook the starter can see (no entity).
    (db as unknown as Record<string, unknown>).select = () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === playbooks ? [{ name: "Consolidate findings" }] : [],
        }),
      }),
    });
    await runPlaybook({
      playbookId: PLAYBOOK.id,
      workspaceId: "ws-1",
      userId: "user-1",
      params: { recipe: RECIPE_ID },
    });

    const session = inserted.filter((i) => i.table === focusSessions)[0].values;
    expect(session.title).toBe("CRM hygiene · Consolidate findings");
    // `goal` is the dedup/proposal key: it stays the bare playbook name.
    expect(session.goal).toBe("CRM hygiene");
  });

  it("the scheduled path's goalOverride is a PROMPT, not a title", async () => {
    await runPlaybook({
      playbookId: PLAYBOOK.id,
      workspaceId: "ws-1",
      userId: "user-1",
      params: {},
      goalResolver: () => "Resolved against the automation StepContext",
    });

    const session = inserted.filter((i) => i.table === focusSessions)[0].values;
    expect(session.goal).toBe("CRM hygiene");
    expect(
      (session.metadata as Record<string, unknown>)[RUN_PROMPT_METADATA_KEY]
    ).toBe("Resolved against the automation StepContext");
    expect(executorRun.mock.calls[0][0].goal).toBe(
      "Resolved against the automation StepContext"
    );
  });
});

describe("criteria travel with the template", () => {
  it("instantiate copies playbook-level AND every stage's criteria, stageKey stamped", async () => {
    await runPlaybook({
      playbookId: PLAYBOOK.id,
      workspaceId: "ws-1",
      userId: "user-1",
      params: {},
    });
    const session = inserted.filter((i) => i.table === focusSessions)[0].values;
    const criteria = session.criteria as Array<Record<string, unknown>>;
    expect(criteria.map((c) => c.key)).toEqual(["typecheck", "no-stale"]);
    expect(criteria[1].stageKey).toBe("fix");
    expect(criteria[0]).not.toHaveProperty("stageKey");
  });

  it("promote carries the session's criteria as STRUCTURE, stageKey dropped", async () => {
    await runPlaybook({
      playbookId: PLAYBOOK.id,
      workspaceId: "ws-1",
      userId: "user-1",
      params: {},
    });
    await promoteSessionToPlaybook({ sessionId: "row-1", userId: "user-1" });
    const promoted = inserted.find((i) => i.table === playbooks)!.values;
    expect(promoted.criteria).toEqual([
      {
        key: "typecheck",
        statement: "Typecheck passes",
        check: { kind: "evidence", evidenceKey: "typecheck" },
      },
      {
        key: "no-stale",
        statement: "No contact is stale",
        check: { kind: "judge" },
      },
    ]);
  });
});

describe("a template's slots are born through the declaration sanitizer", () => {
  it("drops an unparsed ask and a forged receipt, keeps the slot, stamps owedSince", async () => {
    const saved = PLAYBOOK.expectedOutputs;
    (PLAYBOOK as { expectedOutputs: unknown[] }).expectedOutputs = [
      {
        kind: "decision",
        label: "Pick a region",
        owner: "human",
        blockedReason: "decision",
        ask: { mode: "teleport" },
        // A stored template must not birth a receipt.
        status: "done",
      },
    ];
    try {
      await runPlaybook({
        playbookId: PLAYBOOK.id,
        workspaceId: "ws-1",
        userId: "user-1",
        params: {},
      });
    } finally {
      (PLAYBOOK as { expectedOutputs: unknown[] }).expectedOutputs = saved;
    }
    const session = inserted.filter((i) => i.table === focusSessions)[0].values;
    const [slot] = session.expectedOutputs as Array<Record<string, unknown>>;
    expect(slot.label).toBe("Pick a region");
    expect(slot).not.toHaveProperty("ask");
    expect(slot).not.toHaveProperty("status");
    expect(typeof slot.owedSince).toBe("string");
  });
});
