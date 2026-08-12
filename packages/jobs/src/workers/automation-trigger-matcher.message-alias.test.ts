/**
 * `message.received` synthetic alias + normalized MessageEnvelope + shape
 * predicate — the agnostic message-match layer.
 *
 * Proves, behaviourally (db mocked; assertions on which automations reached
 * `fireAutomation` — an inserted run + an enqueued `automation-execute` — and on
 * the trigger payload each run carries):
 *   (a) ONE `message.received` automation fires for BOTH physical message events
 *       (external_message.received.completed AND channel_message.created.completed);
 *   (b) a `shape` predicate (has_url / contains / from_participant / has_attachment
 *       / regex) narrows WHICH messages fire, and a pathological regex rejects
 *       rather than hanging;
 *   (c) an existing `external_message.*` automation still fires unchanged, and the
 *       alias does not leak into unrelated event types (additive/no-regression);
 *   (d) the owner-floor (WHERE predicate shape) + the chain-depth guard apply to a
 *       `message.received` automation exactly as to any other — the alias inherits
 *       every safety invariant because it changes only pattern matching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();
// WHERE trees passed to each db.select(...).where(...) call, in order.
const whereArgs: unknown[] = [];

let selectResults: Array<
  Array<{
    id: string;
    triggerConfig: Record<string, unknown>;
    workspaceId: string | null;
  }>
> = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.set = chain;
  p.where = (arg: unknown) => {
    whereArgs.push(arg);
    return p;
  };
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.onConflictDoNothing = () => p;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

const selectSpy = vi.fn(() => {
  const result = selectResults[selectCall] ?? [];
  selectCall += 1;
  return makeThenable(result);
});

vi.mock("@synap/events", () => ({ getBoss: () => ({ send: bossSend }) }));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
// Operators return inspectable markers so the WHERE predicate SHAPE (owner-floor)
// is assertable, matching the pod-wide test's harness.
vi.mock("@synap/database", async (importOriginal) => ({
  // matchMessageShape moved into @synap/database (the shared shape-matcher door,
  // reused by the guideline resolver). It's a PURE function — pull the REAL one
  // from the actual module so the worker's shape gate runs for real; everything
  // else below stays the deliberately-minimal mock (do NOT spread `actual`,
  // which would replace the mocked db).
  matchMessageShape: (await importOriginal<typeof import("@synap/database")>())
    .matchMessageShape,
  db: {
    query: {
      focusSessions: { findFirst: () => Promise.resolve(null) },
      links: { findMany: () => Promise.resolve([]) },
    },
    select: () => selectSpy(),
    insert: () => makeThenable([{ id: "run-1" }]),
    update: () => makeThenable(undefined),
  },
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
  drizzleSql: () => ({}),
  automations: {
    id: "id",
    workspaceId: "workspace_id",
    createdBy: "created_by",
    runCount: 0,
  },
  automationRuns: {},
  automationClaims: { id: "id" },
  playbookAutomations: {},
  workspaceMembers: { workspaceId: "ws_member_workspace_id", userId: "uid" },
  workspaces: { id: "ws_id", settings: "settings" },
}));

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

// ── Physical message events ────────────────────────────────────────────────
const EXTERNAL_EVENT = {
  eventType: "external_message.received.completed",
  subjectId: "chan-A",
  userId: "user-1",
  workspaceId: "ws-1",
  data: {
    channelId: "chan-A",
    provider: "discord",
    entityId: "ent-1",
    messageId: "msg-1",
    participantName: "Alice",
    content: "hello team, no links here",
  },
} as const;

const CHANNEL_EVENT = {
  eventType: "channel_message.created.completed",
  subjectId: "msg-2",
  userId: "user-1",
  workspaceId: "ws-1",
  data: {
    channelId: "chan-A",
    messageRole: "user",
  },
} as const;

/** Run inserts that opened a run, with the automationId + triggerPayload. */
function firedRuns(): Array<{
  automationId: string;
  triggerPayload: Record<string, unknown>;
}> {
  return insertValues.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((v) => typeof v?.automationId === "string")
    .map((v) => ({
      automationId: v.automationId as string,
      triggerPayload: (v.triggerPayload ?? {}) as Record<string, unknown>,
    }));
}

function firedAutomationIds(): string[] {
  return firedRuns().map((r) => r.automationId);
}

type Marker = { op?: string; col?: unknown; args?: unknown[] };

/** The pod-wide branch must be `and(isNull(workspace_id), eq(created_by, …))`. */
function podWideBranchIsOwnerBound(node: unknown, col: string): boolean {
  if (node == null || typeof node !== "object") return false;
  const n = node as Marker;
  if (n.op === "and") {
    const args = (n.args ?? []) as Marker[];
    if (
      args.some((a) => a?.op === "isNull" && a.col === col) &&
      args.some((a) => a?.op === "eq" && a.col === "created_by")
    ) {
      return true;
    }
  }
  return (n.args ?? []).some((child) => podWideBranchIsOwnerBound(child, col));
}

const MESSAGE_ALIAS = { eventPattern: "message.received" } as const;

describe("message.received alias + envelope + shape", () => {
  beforeEach(() => {
    bossSend.mockClear();
    selectSpy.mockClear();
    insertValues.mockClear();
    whereArgs.length = 0;
    selectCall = 0;
    selectResults = [];
  });

  // ── (a) ONE alias automation fires for BOTH physical events ──────────────
  it("fires a message.received automation for an external_message event", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });

    expect(firedAutomationIds()).toEqual(["auto-alias"]);
    expect(bossSend).toHaveBeenCalledWith(
      "automation-execute",
      expect.objectContaining({ automationId: "auto-alias" })
    );
  });

  it("fires the SAME message.received automation for a channel_message event", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({ data: { ...CHANNEL_EVENT } });

    expect(firedAutomationIds()).toEqual(["auto-alias"]);
  });

  it("also accepts the message.* / message.received.* wildcard forms", async () => {
    for (const eventPattern of ["message.*", "message.received.*"]) {
      insertValues.mockClear();
      selectCall = 0;
      selectResults = [
        [
          {
            id: "auto-wild",
            workspaceId: "ws-1",
            triggerConfig: { eventPattern },
          },
        ],
      ];
      await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });
      expect(firedAutomationIds()).toEqual(["auto-wild"]);
    }
  });

  // ── envelope mapping (both payloads → one shape, exposed to trigger.*) ────
  it("exposes a normalized envelope on the external_message trigger payload", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });

    const [run] = firedRuns();
    expect(run.triggerPayload.message).toMatchObject({
      channelId: "chan-A",
      provider: "discord",
      participant: "Alice",
      content: "hello team, no links here",
      entityId: "ent-1",
      attachments: [],
    });
    // `data` is untouched — existing `{{trigger.data.*}}` mappings keep working.
    expect(run.triggerPayload.data).toMatchObject({ channelId: "chan-A" });
  });

  it("maps the thinner channel_message payload into the same envelope shape", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({ data: { ...CHANNEL_EVENT } });

    const [run] = firedRuns();
    // channel_message carries only { channelId, messageRole } — honest absence,
    // never fabricated content/participant/attachments.
    expect(run.triggerPayload.message).toMatchObject({
      channelId: "chan-A",
      attachments: [],
    });
    expect(
      (run.triggerPayload.message as Record<string, unknown>).content
    ).toBeUndefined();
    expect(
      (run.triggerPayload.message as Record<string, unknown>).participant
    ).toBeUndefined();
  });

  // ── channelId binding composes with the alias ────────────────────────────
  it("respects channelId on a message.received automation (composes)", async () => {
    selectResults = [
      [
        {
          id: "auto-other-chan",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "message.received",
            channelId: "chan-B",
          },
        },
      ],
    ];

    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });

    expect(firedAutomationIds()).toEqual([]);
  });

  // ── (b) shape predicate ──────────────────────────────────────────────────
  it("has_url: matches a message WITH a url, rejects one without", async () => {
    // With a URL → fires.
    selectResults = [
      [
        {
          id: "auto-url",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "message.received",
            shape: { op: "has_url" },
          },
        },
      ],
    ];
    await handleAutomationTriggerMatch({
      data: {
        ...EXTERNAL_EVENT,
        data: { ...EXTERNAL_EVENT.data, content: "see https://synap.live/x" },
      },
    });
    expect(firedAutomationIds()).toEqual(["auto-url"]);

    // Without a URL → rejected (EXTERNAL_EVENT.data.content has no link).
    insertValues.mockClear();
    selectCall = 0;
    selectResults = [
      [
        {
          id: "auto-url",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "message.received",
            shape: { op: "has_url" },
          },
        },
      ],
    ];
    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });
    expect(firedAutomationIds()).toEqual([]);
  });

  it("contains / from_participant / has_attachment shape ops", async () => {
    const cases: Array<{
      shape: Record<string, unknown>;
      data: Record<string, unknown>;
      fires: boolean;
    }> = [
      {
        shape: { op: "contains", value: "TEAM" },
        data: EXTERNAL_EVENT.data,
        fires: true,
      },
      {
        shape: { op: "contains", value: "invoice" },
        data: EXTERNAL_EVENT.data,
        fires: false,
      },
      {
        shape: { op: "from_participant", value: "alice" },
        data: EXTERNAL_EVENT.data,
        fires: true,
      },
      {
        shape: { op: "from_participant", value: "bob" },
        data: EXTERNAL_EVENT.data,
        fires: false,
      },
      {
        shape: { op: "has_attachment" },
        data: {
          ...EXTERNAL_EVENT.data,
          attachments: [{ type: "image", url: "u" }],
        },
        fires: true,
      },
      {
        shape: { op: "has_attachment" },
        data: EXTERNAL_EVENT.data,
        fires: false,
      },
    ];

    for (const c of cases) {
      insertValues.mockClear();
      selectCall = 0;
      selectResults = [
        [
          {
            id: "auto-shape",
            workspaceId: "ws-1",
            triggerConfig: { eventPattern: "message.received", shape: c.shape },
          },
        ],
      ];
      await handleAutomationTriggerMatch({
        data: { ...EXTERNAL_EVENT, data: c.data },
      });
      expect(firedAutomationIds(), JSON.stringify(c.shape)).toEqual(
        c.fires ? ["auto-shape"] : []
      );
    }
  });

  it("regex shape: valid pattern matches; pathological/over-long pattern rejects without hanging", async () => {
    // Valid regex matches.
    selectResults = [
      [
        {
          id: "auto-rx",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "message.received",
            shape: { op: "regex", value: "hello\\s+team" },
          },
        },
      ],
    ];
    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });
    expect(firedAutomationIds()).toEqual(["auto-rx"]);

    // A catastrophic-backtracking pattern against a long input must NOT hang:
    // the input is bounded to 4k and evaluation is time-bounded here (5s) — a
    // real ReDoS would blow well past it.
    insertValues.mockClear();
    selectCall = 0;
    const evil = "(a+)+$"; // classic ReDoS pattern
    selectResults = [
      [
        {
          id: "auto-evil",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "message.received",
            shape: { op: "regex", value: evil },
          },
        },
      ],
    ];
    const start = Date.now();
    await handleAutomationTriggerMatch({
      data: {
        ...EXTERNAL_EVENT,
        data: { ...EXTERNAL_EVENT.data, content: "a".repeat(4000) + "!" },
      },
    });
    expect(Date.now() - start).toBeLessThan(5000);

    // An over-long regex source is rejected outright (returns false → no fire).
    insertValues.mockClear();
    selectCall = 0;
    selectResults = [
      [
        {
          id: "auto-long",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "message.received",
            shape: { op: "regex", value: "a".repeat(201) },
          },
        },
      ],
    ];
    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });
    expect(firedAutomationIds()).toEqual([]);
  }, 10000);

  it("channelId + shape compose (both must match)", async () => {
    const triggerConfig = {
      eventPattern: "message.received",
      channelId: "chan-A",
      shape: { op: "has_url" as const },
    };
    // channel matches, but no url → rejected.
    selectResults = [[{ id: "auto-both", workspaceId: "ws-1", triggerConfig }]];
    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });
    expect(firedAutomationIds()).toEqual([]);

    // channel matches AND url present → fires.
    insertValues.mockClear();
    selectCall = 0;
    selectResults = [[{ id: "auto-both", workspaceId: "ws-1", triggerConfig }]];
    await handleAutomationTriggerMatch({
      data: {
        ...EXTERNAL_EVENT,
        data: { ...EXTERNAL_EVENT.data, content: "http://x.io" },
      },
    });
    expect(firedAutomationIds()).toEqual(["auto-both"]);
  });

  // ── (c) additive / no-regression ────────────────────────────────────────
  it("an existing external_message.* automation still fires unchanged", async () => {
    selectResults = [
      [
        {
          id: "auto-physical",
          workspaceId: "ws-1",
          triggerConfig: { eventPattern: "external_message.*" },
        },
      ],
    ];

    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });

    expect(firedAutomationIds()).toEqual(["auto-physical"]);
  });

  it("the message alias does NOT leak into unrelated event types", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({
      data: {
        eventType: "entity.create.completed",
        subjectId: "ent-1",
        userId: "user-1",
        workspaceId: "ws-1",
        data: { profileSlug: "person" },
      },
    });

    expect(firedAutomationIds()).toEqual([]);
  });

  // ── (d) owner-floor + depth guard inherited ──────────────────────────────
  it("owner-bounds the pod-wide branch for a message event (owner-floor inherited)", async () => {
    selectResults = [[]]; // inspect the predicate only

    await handleAutomationTriggerMatch({ data: { ...EXTERNAL_EVENT } });

    expect(whereArgs).toHaveLength(1);
    expect(podWideBranchIsOwnerBound(whereArgs[0], "workspace_id")).toBe(true);
  });

  it("a message.received automation is subject to the chain-depth guard", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({
      data: {
        ...EXTERNAL_EVENT,
        automationContext: {
          automationRunId: "run-0",
          automationId: "auto-x",
          chainDepth: 3, // at MAX_CHAIN_DEPTH
          rootRunId: "run-0",
          chainAutomationIds: ["auto-x"],
        },
      },
    });

    // Depth guard returns BEFORE selecting/firing anything.
    expect(bossSend).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("cycle detection still applies to a message.received automation", async () => {
    selectResults = [
      [{ id: "auto-alias", workspaceId: "ws-1", triggerConfig: MESSAGE_ALIAS }],
    ];

    await handleAutomationTriggerMatch({
      data: {
        ...EXTERNAL_EVENT,
        automationContext: {
          automationRunId: "run-0",
          automationId: "auto-root",
          chainDepth: 1,
          rootRunId: "run-0",
          chainAutomationIds: ["auto-root", "auto-alias"], // alias already in chain
        },
      },
    });

    expect(bossSend).not.toHaveBeenCalled();
  });
});
