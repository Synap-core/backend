import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A PENDING APPOINTMENT MUST NOT SUPPRESS A RUN.
 *
 * `runPlaybook` with `idempotentBySubject` reuses an existing (playbook,
 * subject) session instead of dispatching. It used to reuse `scheduled` too, so
 * a run-mode trigger returned `{ run: null, reused: true }` onto an appointment
 * that had executed nothing — a run that reads as handled and never ran.
 *
 * Driven through the real `runPlaybook` → `executeSingleRun`. The DB is mocked,
 * but `findFirst` APPLIES the composed `eq` / `notInArray` predicates to one
 * fixture session. `instantiateSession` — the first thing a run does after the
 * reuse check — throws a sentinel, so "the run proceeded" is an observable
 * outcome rather than an inference.
 *
 * What it does NOT cover: anything after session instantiation (channel, run
 * row, executor dispatch).
 */

const PROCEEDED = "APPOINTMENT_REUSE_TEST: run proceeded to instantiateSession";

const { fixture, findFirst } = vi.hoisted(() => ({
  fixture: { row: null as null | Record<string, unknown> },
  findFirst: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({ query: { focusSessions: { findFirst } } })),
    and: vi.fn((...c: unknown[]) => ({ and: c.filter((x) => x !== undefined) })),
    eq: vi.fn((col: unknown, v: unknown) => ({ eq: [col, v] })),
    notInArray: vi.fn((col: unknown, v: unknown) => ({ notInArray: [col, v] })),
    desc: vi.fn((col: unknown) => ({ desc: col })),
  };
});

vi.mock("../playbook-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../playbook-lifecycle.js")>();
  return {
    ...actual,
    resolveRunnablePlaybook: vi.fn(async () => ({
      id: "pb-1",
      metadata: {},
      inputStrategy: null,
      goalTemplate: "Sync {{subject}}",
    })),
    instantiateSession: vi.fn(async () => {
      throw new Error(PROCEEDED);
    }),
  };
});

import { focusSessions } from "@synap/database";
import { runPlaybook } from "../run-playbook.js";

type Node = Record<string, unknown>;

const COLUMN_FIELD = new Map<unknown, string>([
  [focusSessions.playbookId, "playbookId"],
  [focusSessions.subjectEntityId, "subjectEntityId"],
  [focusSessions.status, "status"],
]);

function matches(node: unknown, row: Record<string, unknown>): boolean {
  if (!node || typeof node !== "object") return true;
  const n = node as Node;
  if (Array.isArray(n.and)) return n.and.every((c) => matches(c, row));
  const eqPair = n.eq as [unknown, unknown] | undefined;
  if (eqPair) {
    const field = COLUMN_FIELD.get(eqPair[0]);
    return field ? row[field] === eqPair[1] : true;
  }
  const ninPair = n.notInArray as [unknown, unknown[]] | undefined;
  if (ninPair) {
    const field = COLUMN_FIELD.get(ninPair[0]);
    return field ? !ninPair[1].includes(row[field]) : true;
  }
  return true;
}

const INPUT = {
  playbookId: "pb-1",
  workspaceId: "ws-1",
  userId: "u1",
  subjectId: "subject-1",
  idempotentBySubject: true,
};

describe("runPlaybook subject-idempotency — an appointment is not reused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockImplementation(async ({ where }: { where: unknown }) =>
      fixture.row && matches(where, fixture.row) ? fixture.row : undefined
    );
  });

  function sessionFor(status: string) {
    fixture.row = {
      id: `session-${status}`,
      playbookId: "pb-1",
      subjectEntityId: "subject-1",
      status,
    };
  }

  it("with a SCHEDULED session for the same playbook+subject, the run proceeds (not reused)", async () => {
    sessionFor("scheduled");

    const outcome = await runPlaybook(INPUT as never).then(
      (r) => ({ reused: r.reused }),
      (e: Error) => ({ error: e.message })
    );

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ error: PROCEEDED });
  });

  it("an ACTIVE session for the same playbook+subject is still reused (reuse is not disabled)", async () => {
    sessionFor("active");

    const result = await runPlaybook(INPUT as never);

    expect(result.reused).toBe(true);
    expect(result.run).toBeNull();
    expect(result.session.id).toBe("session-active");
  });
});
