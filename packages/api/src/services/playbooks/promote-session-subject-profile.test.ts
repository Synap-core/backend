/**
 * promoteSessionToPlaybook copies the session subject's kind into
 * `playbooks.subjectProfile` when the session has one, and leaves it null
 * when it doesn't (honest). Project-scoped sessions stay refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
const keptVersions: Array<Record<string, unknown>> = [];

const mockGetDb = vi.hoisted(() => vi.fn());

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

vi.mock("../links/links-service.js", () => ({
  getLinksFor: vi.fn(async () => []),
  extractCapabilities: vi.fn(() => []),
  createLinks: vi.fn(async () => undefined),
}));

vi.mock("../focus-sessions/session-conversion.js", () => ({
  recordConversion: vi.fn(async () => ({
    created: { kind: "playbook", id: "pb-1", name: "Promoted" },
    renamedFrom: null,
    renamedTo: "Promoted",
    undoUntil: "2099-01-01T00:00:00.000Z",
  })),
}));

vi.mock("../../lib/event-helpers.js", () => ({
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(async () => undefined),
}));

import { playbooks, playbookVersions } from "@synap/database";
import { promoteSessionToPlaybook } from "./playbook-lifecycle.js";

const WS = "00000000-0000-4000-8000-000000000010";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ENTITY = "00000000-0000-4000-8000-0000000000bb";

function makeDb(opts: {
  session: Record<string, unknown> | undefined;
  entity?: { type: string } | undefined;
}) {
  const db = {
    // The insert and its kept version (0416) share one transaction.
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    query: {
      focusSessions: {
        findFirst: vi.fn(async () => opts.session),
      },
      entities: {
        findFirst: vi.fn(async () => opts.entity),
      },
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          const row = { id: "pb-1", ...values };
          if (table === playbooks) inserted.push(values);
          if (table === playbookVersions) keptVersions.push(values);
          return {
            returning: async () => [row],
            onConflictDoNothing: async () => undefined,
          };
        },
      };
    },
  };
  return db;
}

describe("promoteSessionToPlaybook subjectProfile", () => {
  beforeEach(() => {
    inserted.length = 0;
    keptVersions.length = 0;
    vi.clearAllMocks();
  });

  it("copies the subject entity's kind onto the new playbook", async () => {
    mockGetDb.mockResolvedValue(
      makeDb({
        session: {
          id: SESSION,
          workspaceId: WS,
          goal: "Plan the next post",
          expectedOutputs: [],
          subjectEntityId: ENTITY,
          playbookId: null,
          metadata: {},
        },
        entity: { type: "post" },
      })
    );

    const result = await promoteSessionToPlaybook({
      sessionId: SESSION,
      userId: "user-1",
    });

    expect(result.status).toBe("promoted");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.subjectProfile).toEqual({ profileSlug: "post" });
    // The new playbook's version is kept with it (0416): a step may pin it.
    expect(keptVersions).toHaveLength(1);
    expect(keptVersions[0]).toMatchObject({
      playbookId: "pb-1",
      createdBy: "user-1",
    });
  });

  it("leaves subjectProfile null when the session has no subject entity", async () => {
    mockGetDb.mockResolvedValue(
      makeDb({
        session: {
          id: SESSION,
          workspaceId: WS,
          goal: "Plan next content",
          expectedOutputs: [],
          subjectEntityId: null,
          playbookId: null,
          metadata: {},
        },
      })
    );

    const result = await promoteSessionToPlaybook({
      sessionId: SESSION,
      userId: "user-1",
    });

    expect(result.status).toBe("promoted");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.subjectProfile).toBeNull();
  });

  it("still refuses a project-scoped session (no workspace)", async () => {
    mockGetDb.mockResolvedValue(
      makeDb({
        session: {
          id: SESSION,
          workspaceId: null,
          goal: "A project session",
          expectedOutputs: [],
          subjectEntityId: ENTITY,
          playbookId: null,
          metadata: {},
        },
        entity: { type: "post" },
      })
    );

    const result = await promoteSessionToPlaybook({
      sessionId: SESSION,
      userId: "user-1",
    });

    expect(result).toMatchObject({
      status: "refused",
      reason: "project_scoped_session",
    });
    expect(inserted).toHaveLength(0);
  });
});
