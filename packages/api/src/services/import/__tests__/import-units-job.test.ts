/**
 * The `import-units` job (finding 51e086d8): every unit of a store-first import
 * manifest goes through the ONE unit door `/import/store-unit` uses
 * (`storeImportUnit`), governed per unit under the submitter's replayed
 * context, and the job output tells stored, proposed and failed apart.
 *
 * DB-free: the create door is injected (the real one is the hub
 * `entities.createEntity`), the source-blob attach gate and storage are mocked,
 * and `@synap/database` keeps its real request-scope helpers (the grant and
 * acting agent the gate reads) with only `db` and `EntityBodyService` stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const token = (n: number, user = USER_ID) =>
  `imports/${user}/${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000/output.wav`;

const h = vi.hoisted(() => ({
  setBody: vi.fn(),
  deleted: [] as string[],
  attach: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    // stageImportUnitUpload's "one object backs one document" read: none yet.
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  },
  EntityBodyService: class {
    setBody = h.setBody;
  },
}));

vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/storage")>()),
  storage: {
    getMetadata: vi.fn(async () => ({
      size: 2_000_000,
      contentType: "audio/wav",
      lastModified: new Date(),
    })),
    delete: vi.fn(async (key: string) => {
      h.deleted.push(key);
    }),
  },
}));

vi.mock(
  "../../../utils/store-entity-source-blob.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../utils/store-entity-source-blob.js")
    >()),
    stageSourceBlob: vi.fn(),
    gateAndAttachStagedSourceBlob: (...a: unknown[]) => h.attach(...a),
  })
);

vi.mock("../../../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(),
}));

import { getActingAgentUserId, getRequestGrant } from "@synap/database";
import { runImportUnitsJob } from "../import-units-job.js";
import type { ImportUnitCreateInput } from "../store-unit.js";
import type { ImportUnitsPayload } from "@synap/jobs/workers/import-units-worker.js";

const GRANT = {
  scopes: [{ permissions: ["entity.*", "document.*"] }],
  clientId: null,
};

function payload(units: ImportUnitsPayload["units"]): ImportUnitsPayload {
  return {
    userId: USER_ID,
    workspaceId: null,
    source: "cli",
    units,
    scopes: ["hub-protocol.write"],
    agentUserId: AGENT_ID,
    sessionId: null,
    keyType: "user",
    keyWorkspaceId: null,
    apiKeyId: "key-1",
    grant: GRANT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.deleted.length = 0;
  h.setBody.mockResolvedValue({
    documentId: "doc-1",
    storageUrl: "https://storage.test/x",
  });
  h.attach.mockImplementation(
    async (a: { staged: Record<string, unknown> }) => ({
      status: "stored",
      ...a.staged,
    })
  );
});

describe("runImportUnitsJob — one run, every unit through the store-unit door", () => {
  it("reports stored, proposed and failed apart, by unit key", async () => {
    const seen: ImportUnitCreateInput[] = [];
    const createDoor = vi.fn(async (input: ImportUnitCreateInput) => {
      seen.push(input);
      if (input.idempotencyKey === "superwhisper:2") {
        return {
          status: "proposed",
          proposalId: "prop-2",
          proposalType: "entity.create",
        };
      }
      if (input.idempotencyKey === "superwhisper:3") {
        throw new Error("Profile 'nope' not found");
      }
      return { status: "created", id: "entity-1" };
    });

    const out = await runImportUnitsJob(
      payload([
        {
          key: "superwhisper:1",
          title: "One",
          profileSlug: "note",
          content: "first",
          properties: { recordingId: "1" },
          uploadToken: token(1),
        },
        {
          key: "superwhisper:2",
          title: "Two",
          profileSlug: "note",
          uploadToken: token(2),
        },
        { key: "superwhisper:3", title: "Three", profileSlug: "nope" },
      ]),
      { createDoor }
    );

    expect(out).toEqual({
      total: 3,
      stored: 1,
      proposed: 1,
      failed: 1,
      results: {
        "superwhisper:1": {
          status: "stored",
          entityId: "entity-1",
          audio: true,
          audioSkippedReason: null,
        },
        "superwhisper:2": {
          status: "proposed",
          proposalId: "prop-2",
          audioSkippedReason: "entity_proposed",
        },
        "superwhisper:3": {
          status: "failed",
          error: "Profile 'nope' not found",
        },
      },
    });
    // The governed create door, once per unit, keyed for idempotency.
    expect(createDoor).toHaveBeenCalledTimes(3);
    expect(seen[0]).toMatchObject({
      userId: USER_ID,
      profileSlug: "note",
      title: "One",
      content: "first",
      properties: { recordingId: "1" },
      source: "cli",
      idempotencyKey: "superwhisper:1",
    });
    // The stored unit's file: adopted as a document, then the attach gate.
    expect(h.setBody).toHaveBeenCalledTimes(1);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.attach).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "entity-1", userId: USER_ID })
    );
    // A parked create stores no file: its upload is deleted, not orphaned.
    expect(h.deleted).toEqual([token(2)]);
  });

  it("runs each unit inside the submitter's grant and acting agent", async () => {
    const ctx: Array<{ grant: unknown; agent: unknown }> = [];
    await runImportUnitsJob(
      payload([{ key: "k1", title: "One", profileSlug: "note" }]),
      {
        createDoor: async () => {
          ctx.push({ grant: getRequestGrant(), agent: getActingAgentUserId() });
          return { status: "created", id: "e1" };
        },
      }
    );
    expect(ctx).toEqual([{ grant: GRANT, agent: AGENT_ID }]);
  });

  it("keeps the entity when the attach is parked, and says so", async () => {
    h.attach.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "p-attach",
      proposalType: "entity.update",
      reviewUrl: "/r",
      staged: {},
    });
    const out = await runImportUnitsJob(
      payload([
        { key: "k1", title: "One", profileSlug: "note", uploadToken: token(1) },
      ]),
      { createDoor: async () => ({ status: "created", id: "e1" }) }
    );
    expect(out.results.k1).toEqual({
      status: "stored",
      entityId: "e1",
      audio: false,
      audioSkippedReason: "proposed",
    });
  });

  it("never adopts another user's upload", async () => {
    const out = await runImportUnitsJob(
      payload([
        {
          key: "k1",
          title: "One",
          profileSlug: "note",
          uploadToken: token(1, OTHER_USER_ID),
        },
      ]),
      { createDoor: async () => ({ status: "created", id: "e1" }) }
    );
    expect(out.results.k1).toEqual({
      status: "stored",
      entityId: "e1",
      audio: false,
      audioSkippedReason: "upload_not_yours",
    });
    expect(h.setBody).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
  });
});
