/**
 * Contract tests for the observations door.
 *
 * This door is reachable by EVERY agent key on the pod, so its input schema is
 * a security boundary, not ergonomics. Two invariants matter more than the
 * happy path:
 *   1. A caller cannot escape the registered namespaces — it must not be able
 *      to write `entity.*`, `workspace.*` or anything the materializer or the
 *      domain-event bridge would act on.
 *   2. A caller cannot assert a lifecycle phase. `.validated` is the suffix the
 *      materialization hook executes; that is how a logging endpoint became a
 *      remote shell once already.
 *
 * These assert against the ROUTER'S OWN schema (pulled off the procedure def),
 * not a copy — a copy would drift and pass while the real door regressed.
 */

import { describe, it, expect, vi } from "vitest";

const WS_VISIBLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// The event store is stubbed so these run without a database. What matters is
// what the door BUILDS and hands to `append` — the schema-level tests below
// cannot see that, and a review found the door was in fact broken there.
const appended: any[] = [];
// PARTIAL mock via importOriginal. A whole-module factory nulls every sibling
// export, and this module graph pulls in far more of @synap/database than the
// event repository — the suite then fails to collect with "No X export is
// defined on the mock", which reads as a broken test rather than a broken mock.
/**
 * The UNIFIED TRIGGER HOP. `observations.ts` enqueues `automation-trigger-match`
 * itself (deliberately NOT through `emitSideEffects`), and that send is wrapped
 * in a try/catch so a boss failure never flips a RECORDED fact to `ok:false` —
 * which also means nothing here observed it until now. Captured so the
 * provenance field below is asserted on the real send.
 */
const triggerSends: Array<[string, any]> = [];
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBoss: () => ({
      send: async (queue: string, payload: any) => {
        triggerSends.push([queue, payload]);
        return null;
      },
    }),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEventRepository: () => ({
      append: async (e: any) => {
        appended.push(e);
        return { id: `row-${appended.length}` };
      },
    }),
    // The fact keys live beside the event store (0372), so they are stubbed
    // with it: every call owns its fact. One fact, one event is
    // record-observation-from-automation.test.ts's to prove; here each test
    // appends the same PR afresh.
    claimObservationKey: async () => ({ owned: true }),
    settleObservationKey: async () => {},
    releaseObservationKey: async () => {},
  };
});

// The PR → session resolver (a DB read) is stubbed: what is under test is that
// the door STAMPS what it resolves, and records the fact when it cannot.
const resolver = vi.hoisted(() => ({
  session: null as string | null,
  fail: false,
  asked: [] as unknown[],
}));
vi.mock("../../services/dev-loop/pr-session-resolver.js", async () => ({
  sessionForDevLoopFact: async (input: unknown) => {
    resolver.asked.push(input);
    if (resolver.fail) throw new Error("db down");
    return resolver.session;
  },
}));

// The trigger budget, controllable: the pod's own consumer must not share it.
const budget = vi.hoisted(() => ({ open: true }));
vi.mock("../../services/api-keys.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    apiKeyService: new Proxy(actual.apiKeyService, {
      get: (target, prop) =>
        prop === "checkRateLimit"
          ? () => budget.open
          : Reflect.get(target, prop),
    }),
  };
});

// Workspace access is stubbed: the door now clamps a caller-supplied
// workspaceId to what the user can actually see, and that lookup hits the DB.
vi.mock("../../utils/workspace-membership.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserWorkspaceIds: async () => [WS_VISIBLE],
  };
});

// Key auth is stubbed to a fixed principal. What is under test is what the door
// BUILDS from a validated input — not the api-key middleware, which has its own
// coverage and needs a database.
vi.mock("../../middleware/api-key-auth.js", async () => {
  const { publicProcedure } = await import("../../trpc.js");
  return {
    scopedProcedure: () =>
      publicProcedure.use(({ next }) =>
        next({ ctx: { userId: "user-1", agentUserId: "agent-1" } as never })
      ),
  };
});

const { observationsRouter, OBSERVATION_NAMESPACES } =
  await import("./observations.js");

const appendInput = () =>
  (observationsRouter as any)._def.procedures.append._def.inputs[0];

function parseType(type: string) {
  return appendInput().safeParse({
    observations: [{ type, subjectId: "repo:backend", data: { ok: true } }],
  });
}

describe("observations.append — namespace containment", () => {
  it.each([...OBSERVATION_NAMESPACES])(
    "ACCEPTS the registered namespace %s",
    (ns) => {
      expect(parseType(`${ns}.commit`).success).toBe(true);
    }
  );

  it.each([
    "entity.create",
    "workspace.join",
    "proposal.approve",
    "command.execute",
    "user.deleted",
    "system.shutdown",
  ])("REJECTS the unregistered namespace in %s", (type) => {
    expect(
      parseType(type).success,
      `SECURITY REGRESSION: "${type}" escaped the observation namespaces`
    ).toBe(false);
  });

  it("REJECTS a bare type with no namespace", () => {
    expect(parseType("commit").success).toBe(false);
  });

  it("REJECTS a namespace used as a prefix without the dot separator", () => {
    // "devious.commit" starts with "dev" but is NOT the "dev" namespace.
    expect(
      parseType("devious.commit").success,
      "prefix matching must require the dot, or a neighbouring word grants access"
    ).toBe(false);
  });
});

describe("observations.append — lifecycle phases are refused", () => {
  it.each([".validated", ".completed", ".failed"])(
    "REJECTS %s even inside a registered namespace",
    (phase) => {
      expect(
        parseType(`dev.commit${phase}`).success,
        `SECURITY REGRESSION: dev.commit${phase} would be treated as a command`
      ).toBe(false);
    }
  );

  it("ACCEPTS a non-lifecycle suffix that merely looks similar", () => {
    expect(parseType("dev.commit.recorded").success).toBe(true);
  });
});

describe("observations.append — the phase check cannot be dodged by padding", () => {
  // These came from an adversarial probe. `"dev.commit.validated "` WAS accepted
  // before the strict shape rule: a trailing space defeats endsWith(".validated").
  // Not exploitable via the materialization hook (it uses the same endsWith, so
  // it would not have matched either) — but it defeated the check's intent, and
  // any consumer that trimmed would have been exposed.
  it.each([
    "dev.commit.validated ", // trailing space
    "dev.commit.validated\n", // trailing newline
    "dev.commit.validated\t", // trailing tab
  ])(
    "REJECTS %j — padding must not smuggle a lifecycle phase through",
    (type) => {
      expect(parseType(type).success).toBe(false);
    }
  );

  it.each([
    "DEV.commit", // uppercase namespace
    "Dev.commit",
    " dev.commit", // leading space
    "dev..commit", // empty segment
    "dev.commit.", // trailing dot
    "dev.", // namespace with no verb
  ])("REJECTS the malformed type %j", (type) => {
    expect(parseType(type).success).toBe(false);
  });

  it("ACCEPTS a nested type inside a registered namespace", () => {
    // `dev.entity.create` is namespace-contained and reaches no acting consumer:
    // the domain-event bridge maps exact types like `entity.created`, not this.
    expect(parseType("dev.entity.create").success).toBe(true);
  });
});

describe("observations.append — payload shape", () => {
  it("requires at least one observation", () => {
    expect(appendInput().safeParse({ observations: [] }).success).toBe(false);
  });

  it("caps a batch so one producer cannot flood a single call", () => {
    const many = Array.from({ length: 201 }, () => ({
      type: "dev.commit",
      subjectId: "repo:x",
      data: {},
    }));
    expect(appendInput().safeParse({ observations: many }).success).toBe(false);
  });

  it("defaults subjectType rather than forcing every producer to supply one", () => {
    const parsed = appendInput().safeParse({
      observations: [{ type: "dev.commit", subjectId: "repo:x", data: {} }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.observations[0].subjectType).toBe("observation");
  });

  it("coerces occurredAt so a producer can report when it HAPPENED, not when we heard", () => {
    const parsed = appendInput().safeParse({
      observations: [
        {
          type: "dev.commit",
          subjectId: "repo:x",
          data: {},
          occurredAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.observations[0].occurredAt).toBeInstanceOf(Date);
  });
});

// ── The mutation itself ─────────────────────────────────────────────────────
// These exist because the schema-only tests above passed while the door was
// BROKEN: `SynapEvent.subjectId` is `z.string().uuid()` and `createSynapEvent`
// ends in `SynapEventSchema.parse`, so a real subject ref (`repo:backend`, a
// git SHA) threw, was swallowed by the per-item catch, and came back as HTTP
// 200 with `failed: 1`. Testing the input schema proves nothing about what the
// door actually writes.

async function callAppend(observations: unknown[]) {
  const caller = (observationsRouter as any).createCaller({
    userId: "user-1",
    agentUserId: "agent-1",
    scopes: ["hub-protocol.write", "hub-protocol.read"],
  });
  return caller.append({ observations });
}

describe("observations.append — the mutation actually records", () => {
  it("RECORDS a non-UUID subject ref (a repo id) instead of silently failing", async () => {
    appended.length = 0;
    const res = await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: { sha: "abc" } },
    ]);

    expect(
      res.recorded,
      "REGRESSION: the door cannot record its own canonical subject"
    ).toBe(1);
    expect(res.failed).toBe(0);
    expect(appended).toHaveLength(1);
  });

  it("preserves the ORIGINAL ref in data.subjectRef while hashing subjectId to a UUID", async () => {
    appended.length = 0;
    await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: {} },
    ]);

    const ev = appended[0];
    expect(ev.subjectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(ev.data.subjectRef, "the human-readable ref must not be lost").toBe(
      "repo:backend"
    );
  });

  it("derives the SAME uuid for the same ref (stable across batches/machines)", async () => {
    appended.length = 0;
    await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: {} },
      { type: "dev.commit", subjectId: "repo:backend", data: {} },
      { type: "dev.commit", subjectId: "repo:browser", data: {} },
    ]);

    expect(appended[0].subjectId).toBe(appended[1].subjectId);
    expect(appended[0].subjectId).not.toBe(appended[2].subjectId);
  });

  it("passes a real UUID through untouched", async () => {
    appended.length = 0;
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    await callAppend([{ type: "dev.commit", subjectId: uuid, data: {} }]);
    expect(appended[0].subjectId).toBe(uuid);
  });

  it("sets agentUserId but NOT isAgent (budget + metric rationale in the header)", async () => {
    appended.length = 0;
    await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: {} },
    ]);

    expect(appended[0].agentUserId).toBe("agent-1");
    expect(
      appended[0].isAgent,
      "stamping isAgent would burn the agent's daily write ceiling for recording a fact"
    ).toBeUndefined();
  });

  it("returns per-INDEX results so a caller marks exactly what landed", async () => {
    appended.length = 0;
    const res = await callAppend([
      { type: "dev.commit", subjectId: "repo:a", data: {} },
      { type: "dev.commit", subjectId: "repo:b", data: {} },
    ]);

    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results.map((r: any) => r.index)).toEqual([0, 1]);
    expect(res.results.every((r: any) => r.ok)).toBe(true);
  });
});

describe("observations.append — workspace tagging is clamped, never trusted", () => {
  it("sets the real workspace_id column, not just data (readers index on the column)", async () => {
    appended.length = 0;
    await callAppend([
      {
        type: "dev.commit",
        subjectId: "repo:x",
        data: {},
        workspaceId: WS_VISIBLE,
      },
    ]);

    expect(
      appended[0].workspaceId,
      "leaving workspaceId in data only forces readers onto an unindexed JSONB fallback"
    ).toBe(WS_VISIBLE);
    expect(appended[0].data.workspaceId).toBe(WS_VISIBLE);
  });

  it("DROPS a workspace the caller cannot see rather than stamping it", async () => {
    appended.length = 0;
    const res = await callAppend([
      {
        type: "dev.commit",
        subjectId: "repo:x",
        data: {},
        workspaceId: WS_FOREIGN,
      },
    ]);

    // The fact is still recorded — losing it would break the one promise this
    // door makes — but it lands pod-wide rather than in someone else's lens.
    expect(res.recorded).toBe(1);
    expect(
      appended[0].workspaceId,
      "a workspace the caller cannot access must never be stamped"
    ).toBeUndefined();
    expect(appended[0].data.workspaceId).toBeUndefined();
  });

  it("uses occurredAt as the ROW timestamp so a replayed backlog is not all 'now'", async () => {
    appended.length = 0;
    const when = "2026-08-01T10:00:00.000Z";
    await callAppend([
      { type: "dev.commit", subjectId: "repo:x", data: {}, occurredAt: when },
    ]);

    expect(
      new Date(appended[0].timestamp).toISOString(),
      "everything that orders, partitions or expires an event keys on timestamp"
    ).toBe(when);
    // ingestedAt lives in `data`, not `metadata`: EventRepository.append
    // REPLACES event metadata with {version, requestId}, so a metadata field
    // would read back null (confirmed against a live pod).
    expect(appended[0].data.ingestedAt).toBeDefined();
    expect(
      appended[0].metadata,
      "do not write metadata the store discards — it reads back null"
    ).toBeUndefined();
  });
});

describe("observations.append — the trigger hop names the event it recorded", () => {
  /**
   * `automation_runs.trigger_event_id` (0256) is only ever non-NULL because a
   * producer names the event. This door ALREADY held `row.id` — the id the
   * event store just returned — and dropped it, so a run fired by an
   * observation could not be walked back to the observation.
   */
  it("forwards the recorded row's id as a TOP-LEVEL eventId", async () => {
    appended.length = 0;
    triggerSends.length = 0;
    await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: { sha: "abc" } },
    ]);

    // Non-vacuity: the hop actually fired. Without this the assertions below
    // would pass over an empty array if the enqueue were removed entirely.
    const hop = triggerSends.find(([q]) => q === "automation-trigger-match");
    expect(hop, "the unified trigger hop did not fire").toBeDefined();

    // The stub returns `row-<n>` from `append`, so this ties the enqueued id to
    // the row that was actually recorded rather than to a constant.
    expect(hop![1].eventId).toBe("row-1");
  });

  it("never puts it inside `data` — that would disable the dedupe claim", async () => {
    // `resolveAutomationEventFingerprintId` reads `data.eventId` FIRST. A
    // per-event unique id there gives every observation a unique fingerprint,
    // so the D5 exactly-once claim can never collide and silently stops
    // deduping. Nothing throws; runs just start duplicating.
    appended.length = 0;
    triggerSends.length = 0;
    await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: { sha: "abc" } },
    ]);

    const hop = triggerSends.find(([q]) => q === "automation-trigger-match");
    expect(hop).toBeDefined();
    expect(hop![1].data.eventId).toBeUndefined();
    // …and the caller's own payload is untouched.
    expect(hop![1].data.sha).toBe("abc");
  });
});

describe("observations.append — the dev-loop contract (plan v5 T2)", () => {
  const merged = {
    repo: "Synap-core/backend",
    number: 255,
    url: "https://github.com/Synap-core/backend/pull/255",
    sha: "91de41c34",
    body: "Pod session: cb0df539-7346-4db4-bf7d-a42b2abed58c",
  };

  it("REFUSES a contract type whose payload does not parse — per item, never the batch", async () => {
    appended.length = 0;
    const res = await callAppend([
      // url names another PR than repo#number: the sweeper would complete the wrong outcome.
      {
        type: "dev.pr_merged",
        subjectId: "Synap-core/backend#255",
        data: {
          ...merged,
          url: "https://github.com/Synap-core/backend/pull/256",
        },
      },
      {
        type: "ci.finished",
        subjectId: "x",
        data: { status: "green", sha: "abc1234", repo: "a/b" },
      },
      {
        type: "dev.pr_merged",
        subjectId: "Synap-core/backend#255",
        data: merged,
      },
    ]);
    expect(res.recorded).toBe(1);
    expect(res.results[0]).toMatchObject({ ok: false, index: 0 });
    expect(res.results[0].error).toMatch(/dev\.pr_merged: url/);
    expect(res.results[1]).toMatchObject({ ok: false, index: 1 });
    expect(res.results[1].error).toMatch(/ci\.finished: status/);
    expect(res.results[2]).toMatchObject({ ok: true, index: 2 });
    // Only the valid fact reached the event store.
    expect(appended).toHaveLength(1);
  });

  it("leaves a type outside the contract free-form (dev.commit carries anything)", async () => {
    const res = await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: { anything: 1 } },
    ]);
    expect(res.recorded).toBe(1);
  });

  it("ENQUEUES the pod's own consumer for dev.pr_merged, with the producer as the governed actor", async () => {
    appended.length = 0;
    triggerSends.length = 0;
    await callAppend([
      {
        type: "dev.pr_merged",
        subjectId: "Synap-core/backend#255",
        data: merged,
      },
    ]);
    const job = triggerSends.find(([q]) => q === "dev-loop-observation");
    expect(job, "the merge sweeper job was not enqueued").toBeDefined();
    expect(job![1]).toMatchObject({
      eventType: "dev.pr_merged",
      userId: "user-1",
      producerAgentUserId: "agent-1",
      eventId: "row-1",
    });
    expect(job![1].data).toMatchObject({
      repo: "Synap-core/backend",
      number: 255,
    });
    // …and the automations still fire on it (the unified hop is unchanged).
    expect(triggerSends.some(([q]) => q === "automation-trigger-match")).toBe(
      true
    );
  });

  it("does NOT enqueue it for a fact the pod does not act on", async () => {
    triggerSends.length = 0;
    await callAppend([
      {
        type: "dev.pr_opened",
        subjectId: "Synap-core/backend#255",
        data: merged,
      },
    ]);
    expect(triggerSends.some(([q]) => q === "dev-loop-observation")).toBe(
      false
    );
    expect(triggerSends.some(([q]) => q === "automation-trigger-match")).toBe(
      true
    );
  });

  it("ENQUEUES the sweep for dev.pr_closed too (an unmerged close retires the outcome)", async () => {
    triggerSends.length = 0;
    await callAppend([
      {
        type: "dev.pr_closed",
        subjectId: "Synap-core/backend#255",
        data: merged,
      },
    ]);
    const job = triggerSends.find(([q]) => q === "dev-loop-observation");
    expect(job?.[1]).toMatchObject({ eventType: "dev.pr_closed" });
  });

  it("the sweep job CARRIES the posting key's grant (F1: the sweep re-enters it)", async () => {
    const { runWithGrant } = await import("@synap/database");
    triggerSends.length = 0;
    const scope = { permissions: ["event.create"] };
    await runWithGrant({ scopes: [scope], clientId: "app-1" }, () =>
      callAppend([
        {
          type: "dev.pr_merged",
          subjectId: "Synap-core/backend#255",
          data: merged,
        },
      ])
    );
    const job = triggerSends.find(([q]) => q === "dev-loop-observation");
    expect(job, "the sweep was not enqueued").toBeDefined();
    expect(job![1].grant).toEqual({ scopes: [scope], clientId: "app-1" });
  });

  it("a key with no grant enqueues grant: null (a legacy key, unchanged)", async () => {
    triggerSends.length = 0;
    await callAppend([
      {
        type: "dev.pr_merged",
        subjectId: "Synap-core/backend#255",
        data: merged,
      },
    ]);
    const job = triggerSends.find(([q]) => q === "dev-loop-observation");
    expect(job![1].grant).toBeNull();
  });

  it("the sweep is NOT bound by the trigger budget: a spent budget still moves the session", async () => {
    triggerSends.length = 0;
    budget.open = false;
    try {
      await callAppend([
        {
          type: "dev.pr_merged",
          subjectId: "Synap-core/backend#255",
          data: merged,
        },
      ]);
    } finally {
      budget.open = true;
    }
    expect(triggerSends.some(([q]) => q === "automation-trigger-match")).toBe(
      false
    );
    expect(triggerSends.some(([q]) => q === "dev-loop-observation")).toBe(true);
  });
});

describe("observations.append — the resolved session is stamped before automations match", () => {
  const SID = "cb0df539-7346-4db4-bf7d-a42b2abed58c";
  const pr = {
    repo: "Synap-core/backend",
    number: 255,
    url: "https://github.com/Synap-core/backend/pull/255",
  };

  it("a PR fact naming no session gets the one its outcome ref resolves to — on the row AND the trigger", async () => {
    appended.length = 0;
    triggerSends.length = 0;
    resolver.session = SID;
    try {
      await callAppend([
        {
          type: "dev.pr_merged",
          subjectId: "Synap-core/backend#255",
          data: pr,
        },
      ]);
    } finally {
      resolver.session = null;
    }
    expect(appended[0].data.sessionId).toBe(SID);
    const hop = triggerSends.find(([q]) => q === "automation-trigger-match");
    expect(hop![1].data.sessionId).toBe(SID);
  });

  it("a ci.finished of a PR is resolved too (the contract's `pr` field)", async () => {
    appended.length = 0;
    resolver.asked.length = 0;
    resolver.session = SID;
    try {
      await callAppend([
        {
          type: "ci.finished",
          subjectId: "Synap-core/backend@abc1234",
          data: {
            status: "success",
            sha: "abc1234",
            repo: "Synap-core/backend",
            pr: 255,
          },
        },
      ]);
    } finally {
      resolver.session = null;
    }
    expect(appended[0].data.sessionId).toBe(SID);
    expect(resolver.asked[0]).toMatchObject({
      userId: "user-1",
      type: "ci.finished",
    });
  });

  it("a failed lookup never costs the fact: recorded, unstamped", async () => {
    appended.length = 0;
    resolver.fail = true;
    try {
      const res = await callAppend([
        {
          type: "dev.pr_merged",
          subjectId: "Synap-core/backend#255",
          data: pr,
        },
      ]);
      expect(res.recorded).toBe(1);
    } finally {
      resolver.fail = false;
    }
    expect(appended[0].data.sessionId).toBeUndefined();
  });

  it("asks nothing for a fact outside the dev-loop contract", async () => {
    resolver.asked.length = 0;
    await callAppend([
      { type: "dev.commit", subjectId: "repo:backend", data: { sha: "abc" } },
    ]);
    expect(resolver.asked).toHaveLength(0);
  });
});

describe("observations.append — exactly-once survives a re-posted fact", () => {
  it("the trigger's data leaves out ingestedAt, so the same fact posted twice fingerprints the same", async () => {
    // The matcher's claim fingerprint (`resolveAutomationEventFingerprintId`)
    // hashes eventType + subjectId + data when the fact has no native id (a
    // PR fact has none): equal trigger payloads ARE equal fingerprints.
    triggerSends.length = 0;
    appended.length = 0;
    const fact = {
      type: "dev.pr_opened",
      subjectId: "Synap-core/backend#255",
      occurredAt: "2026-10-26T10:00:00.000Z",
      data: {
        repo: "Synap-core/backend",
        number: 255,
        url: "https://github.com/Synap-core/backend/pull/255",
      },
    };
    await callAppend([fact]);
    await new Promise((r) => setTimeout(r, 5));
    await callAppend([fact]);
    const hops = triggerSends.filter(([q]) => q === "automation-trigger-match");
    expect(hops).toHaveLength(2);
    expect(hops[0]![1].data.ingestedAt).toBeUndefined();
    expect(hops[0]![1].data).toEqual(hops[1]![1].data);
    expect(hops[0]![1].subjectId).toBe(hops[1]![1].subjectId);
    // The recorded rows keep when we heard it.
    expect(appended[0].data.ingestedAt).toBeDefined();
  });
});

describe("observations.append — dev.repo_snapshot (the Work › Ship fact)", () => {
  const snapshot = {
    repo: "Synap-core/backend",
    observedAt: "2026-10-27T21:00:00.000Z",
    visibility: "public",
    main: {
      sha: "abc1234",
      health: "red",
      source: "github-checks",
      fixedBy: { repo: "Synap-core/backend", number: 363 },
    },
    prs: [
      {
        number: 363,
        title: "main typecheck fix",
        url: "https://github.com/Synap-core/backend/pull/363",
        headSha: "def5678",
        draft: false,
        author: "Antoinesrvt",
        updatedAt: "2026-10-27T20:30:00Z",
        mergeable: "blocked",
        checks: "queued",
        autoMerge: true,
      },
    ],
    mergedToday: [],
  };

  it("RECORDS a valid snapshot and REFUSES a malformed one, per item", async () => {
    appended.length = 0;
    triggerSends.length = 0;
    const res = await callAppend([
      {
        type: "dev.repo_snapshot",
        subjectId: "Synap-core/backend",
        data: {
          ...snapshot,
          // a PR of ANOTHER repo filed under this one: the fold would draw it
          // in the wrong lane.
          prs: [
            {
              ...snapshot.prs[0],
              url: "https://github.com/Synap-core/browser/pull/363",
            },
          ],
        },
      },
      {
        type: "dev.repo_snapshot",
        subjectId: "Synap-core/backend",
        data: snapshot,
      },
    ]);
    expect(res.results[0]).toMatchObject({ ok: false, index: 0 });
    expect(res.results[0].error).toMatch(/dev\.repo_snapshot: prs\.0\.url/);
    expect(res.results[1]).toMatchObject({ ok: true, index: 1 });
    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe("dev.repo_snapshot");
    expect(appended[0].data.main.fixedBy).toEqual({
      repo: "Synap-core/backend",
      number: 363,
    });
    // A snapshot fires automations, and moves no session by itself.
    expect(triggerSends.some(([q]) => q === "automation-trigger-match")).toBe(
      true
    );
    expect(triggerSends.some(([q]) => q === "dev-loop-observation")).toBe(
      false
    );
  });
});
