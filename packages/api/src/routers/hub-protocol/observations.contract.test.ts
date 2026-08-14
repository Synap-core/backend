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
  };
});

// Workspace access is stubbed: the door now clamps a caller-supplied
// workspaceId to what the user can actually see, and that lookup hits the DB.
vi.mock("./rest/_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserAccessibleWorkspaceIds: async () => [WS_VISIBLE],
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
    expect(appended[0].metadata.ingestedAt).toBeDefined();
  });
});
