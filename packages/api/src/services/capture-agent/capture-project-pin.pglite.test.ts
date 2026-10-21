/**
 * A capture pinned to a project the caller cannot see is REFUSED before
 * anything is filed — through BOTH capture write cores, on PGlite (real
 * `projects` rows, the real visibility predicate).
 *
 * THE DEFECT this pins (feedback 1518f8d6, proposal 96a8fea8): a capture with
 * a mistyped `projectId` created 4 tasks and a skill, answered
 * `status: applied`, and only said `project: {status: not_linked, reason:
 * project-not-found}` deep in the receipt. The records landed outside the
 * project, where a person browsing it never sees them.
 *
 * Doors covered, by the core they reach:
 *   - `submitCaptureGraph` — MCP `synap_capture` entities[]/plan, Hub REST
 *     `/capture/graph` and `/capture/structure`, rerun, the Library;
 *   - tRPC `capture.execute` — the MCP text lane, Hub REST `/capture/execute`,
 *     the apps.
 *
 * NOT covered here: how each door RENDERS the refusal. It is a `TRPCError`
 * (NOT_FOUND), so Hub REST answers 404 through `httpStatusForTrpcError` and MCP
 * returns the message as a recoverable tool error through `toSafeToolError` —
 * both existing mappings, untouched by this change.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});
// The tRPC read-only guard reads the sync generation table — an infrastructure
// seam, stubbed as in `capture.project-outcome.test.ts`.
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import * as schema from "@synap/database/schema";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import {
  assertCaptureProjectPinVisible,
  CaptureProjectNotFoundError,
} from "./resolve-capture-project.js";

const USER = `user-${randomUUID()}`;
const OTHER_USER = `user-${randomUUID()}`;
const SYNAP = "d4b84ad8-1111-4222-8333-444455556666";
// One character off SYNAP — the shape of the reported mistype.
const SYNAP_TYPO = "d4b84ad8-1111-4222-8333-444455556667";
const BRAND = randomUUID();
const ARCHIVED = randomUUID();
const FOREIGN = randomUUID();

let db: Awaited<ReturnType<typeof h.init>>;

beforeAll(async () => {
  db = await h.init();
  await h.client!.exec(
    pgliteSchemaDdl([
      schema.projects,
      schema.workspaces,
      schema.workspaceMembers,
      schema.users,
      schema.podMembers,
      schema.projectMembers,
    ] as never)
  );
  const insert = (id: string, name: string, userId: string, status: string) =>
    h.client!.query(
      `insert into projects (id, user_id, workspace_id, name, slug, status) values ($1, $2, null, $3, $4, $5)`,
      [id, userId, name, name.toLowerCase(), status]
    );
  await insert(SYNAP, "Synap", USER, "active");
  await insert(BRAND, "Brand refresh", USER, "active");
  await insert(ARCHIVED, "Old thing", USER, "archived");
  await insert(FOREIGN, "Not yours", OTHER_USER, "active");
});

describe("assertCaptureProjectPinVisible — the one pin check", () => {
  it("passes a project the caller can see", async () => {
    await expect(
      assertCaptureProjectPinVisible(db as never, {
        userId: USER,
        projectId: SYNAP,
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a project that EXISTS but belongs to someone else", async () => {
    await expect(
      assertCaptureProjectPinVisible(db as never, {
        userId: USER,
        projectId: FOREIGN,
      })
    ).rejects.toBeInstanceOf(CaptureProjectNotFoundError);
  });

  it("refuses a mistyped id and names the closest visible, active project first", async () => {
    const err = await assertCaptureProjectPinVisible(db as never, {
      userId: USER,
      projectId: SYNAP_TYPO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureProjectNotFoundError);
    const refusal = err as CaptureProjectNotFoundError;
    expect(refusal.code).toBe("NOT_FOUND");
    expect(refusal.closestProjects[0]).toEqual({ id: SYNAP, name: "Synap" });
    const offered = refusal.closestProjects.map((p) => p.id);
    expect(offered).not.toContain(FOREIGN);
    expect(offered).not.toContain(ARCHIVED);
    expect(refusal.message).toContain(`"Synap" (${SYNAP})`);
    expect(refusal.message).toContain("nothing was filed");
    // MCP caps a thrown message at 500 chars — the names must survive it.
    expect(refusal.message.length).toBeLessThan(500);
  });
});

describe("both capture write cores refuse BEFORE anything is filed", () => {
  const FOUR_TASKS = Array.from({ length: 4 }, (_, i) => ({
    ref: `t${i}`,
    profileSlug: "task",
    title: `Task ${i}`,
    properties: {},
  }));

  let writes: string[];
  beforeEach(async () => {
    vi.restoreAllMocks();
    writes = [];
    const proposalWriter = await import("../../utils/event-backed-proposal.js");
    const materializer = await import("../../utils/materialize-composite.js");
    vi.spyOn(proposalWriter, "createEventBackedProposal").mockImplementation(
      (async () => {
        writes.push("pending proposal");
        return { proposal: { id: "p" } };
      }) as never
    );
    vi.spyOn(proposalWriter, "createAutoApprovedProposal").mockImplementation(
      (async () => {
        writes.push("auto-approved proposal");
        return { proposal: { id: "p" } };
      }) as never
    );
    vi.spyOn(materializer, "materializeCompositeGraph").mockImplementation(
      (async () => {
        writes.push("materialized");
        return {};
      }) as never
    );
  });

  it("submitCaptureGraph (the agent auto-apply route of the report)", async () => {
    const { submitCaptureGraph } = await import("./submit-capture-graph.js");
    const err = await submitCaptureGraph({
      userId: USER,
      agentUserId: `agent-${randomUUID()}`,
      workspaceId: null,
      projectId: SYNAP_TYPO,
      source: "agent",
      entities: FOUR_TASKS as never,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureProjectNotFoundError);
    expect((err as CaptureProjectNotFoundError).closestProjects[0]?.id).toBe(
      SYNAP
    );
    expect(writes).toEqual([]);
  });

  it("tRPC capture.execute (the text lane)", async () => {
    const { captureRouter } = await import("../../routers/capture.js");
    const caller = captureRouter.createCaller({
      authenticated: true,
      userId: USER,
      workspaceId: null,
      sessionId: null,
      agentUserId: null,
    } as never);
    const err = await caller
      .execute({
        entities: FOUR_TASKS.map((t) => ({
          tempId: t.ref,
          profileSlug: t.profileSlug,
          title: t.title,
          properties: {},
        })),
        relations: [],
        projectId: SYNAP_TYPO,
      } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureProjectNotFoundError);
    expect(writes).toEqual([]);
  });
});
