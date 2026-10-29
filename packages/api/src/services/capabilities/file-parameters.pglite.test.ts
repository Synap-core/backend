/**
 * Pod files to tools, by URL (plan e7c3c98e, decision 7d42be8c) — through the
 * REAL run core (`executeCapability`), the REAL capability gate, the REAL
 * post-gate runner (`runResolvedSkill`, shared by a direct run and an approved
 * proposal) and the REAL file doors (`readableFileEntity` →
 * `loadSignableFileEntity` → `scopedDb`, which ANDs the key's grant;
 * `signFileEntityUrl`), compiled and run as SQL on PGlite.
 *
 * Stubbed: the object-store signer (it echoes the key and the TTL, so the test
 * sees WHICH blob was signed and for HOW LONG), the provider HTTP call (it
 * records the parameters the verb received), the proposal row write (PGlite
 * nests no transactions; the data and the VERDICT are the real ones), the
 * event log (captured, so the `file.sent` rows can be read), the grant
 * lookups behind the gate's grant and rule rungs (no grant, no rule), the
 * `capability_run` telemetry and the recall deposit.
 *
 * Rows rule out:
 *  - a file the caller cannot read (outside its key's grant), an unknown or
 *    trashed file, one with no stored bytes, one over the cap, or a value that
 *    is not a file id, being proposed or run;
 *  - a URL minted at ask time (stored in the proposal, or dead by approval);
 *  - the id reaching the tool instead of a URL; the wrong lifetime for the
 *    verb's mode;
 *  - an agent run carrying a file running, or proposing without the file
 *    floor's reason; the floor firing on a run that carries no file;
 *  - a file deleted before approval still sent at approval;
 *  - a local-storage pod handing out a `file://` link;
 *  - a send with no `file.sent` event, an event per run instead of per file,
 *    or the bearer URL written into the event.
 *
 * Cannot see: production Postgres, a real signer (S3/R2/MinIO), a real tool
 * fetching the URL, the approval executor's claim bookkeeping (its
 * `kind:"error"` → `delivered:false` mapping is `proposals/executors/capability.ts`).
 */
import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  /** What the signer returns: an https store, or a local pod's file://. */
  signerBase: "https://signed.test",
  /** Every provider call: the parameters the verb received. */
  calls: [] as Array<Record<string, unknown>>,
  proposals: [] as Array<{
    id: string;
    agentUserId?: string;
    data: Record<string, unknown>;
    governanceReason?: string | null;
  }>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const events = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : prop === "append"
            ? async (e: Record<string, unknown>) => {
                h.events.push(e);
                return { id: e.id };
              }
            : async () => ({ id: globalThis.crypto.randomUUID() }),
    }
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: events,
    knowledgeRepository: { saveFact: async () => undefined },
    // No capability grant: the gate's grant rung finds none.
    findCapabilityGrant: async () => ({ ok: false }),
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGovernanceRule: async () => undefined,
  resolveOriginTrust: async () => undefined,
}));
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    getSignedUrl: async (key: string, expiresIn: number) =>
      `${h.signerBase}/${key}?expires=${expiresIn}`,
  },
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: async () => new Array(1536).fill(0),
}));
vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
vi.mock("./execute-provider-verb.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeProviderVerb: async (
    _spec: unknown,
    params: Record<string, unknown>
  ) => {
    h.calls.push(params);
    return { posted: true };
  },
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: {
    agentUserId?: string;
    data: Record<string, unknown>;
    governanceReason?: string | null;
  }) => {
    const id = globalThis.crypto.randomUUID();
    h.proposals.push({ id, ...input });
    return { id };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
// Registers the grant read provider the database floors call (as the API does
// at load): without it a scoped grant reads deny-all, not narrowed.
import "../../access/grant-read.js";
import { executeCapability, runResolvedSkill } from "./execute-capability.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS_A = randomUUID(); // the space a pinned key's grant covers
const WS_B = randomUUID(); // another of the person's spaces
const FILE_PROFILE = randomUUID();
const TOOL = randomUUID();
const POST_VERB = randomUUID(); // sync: postiz_schedule_post
const EDIT_VERB = randomUUID(); // async: fal_edit_reference_image
const BYTES_VERB = randomUUID(); // code: unipile_create_post (file[]:bytes)

const keyOf = (id: string) => `users/owner/${id}.bin`;
const MB = 1024 * 1024;

/** One file entity per name, with its document (or none). */
const FILES = {
  photo: { ws: WS_A, title: "photo.jpg", size: 2_202_009, doc: true },
  second: { ws: WS_A, title: "second.png", size: MB, doc: true },
  other: { ws: WS_B, title: "other.jpg", size: MB, doc: true },
  big: { ws: WS_A, title: "reel.mp4", size: 400 * MB, doc: true },
  // Over the bytes cap (100 MB), under the URL cap (300 MB).
  mid: { ws: WS_A, title: "long.mp4", size: 150 * MB, doc: true },
  empty: { ws: WS_A, title: "no-bytes", size: 0, doc: false },
  trashed: { ws: WS_A, title: "gone.jpg", size: MB, doc: true },
  later: { ws: WS_A, title: "later.jpg", size: MB, doc: true },
} as const;
type FileName = keyof typeof FILES;
const ID = Object.fromEntries(
  Object.keys(FILES).map((k) => [k, randomUUID()])
) as Record<FileName, string>;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const ws of [WS_A, WS_B]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'file','File','kind','system','workspace',true,'{}'::jsonb,null)`,
    [FILE_PROFILE]
  );
  for (const [name, f] of Object.entries(FILES) as Array<
    [FileName, (typeof FILES)[FileName]]
  >) {
    const docId = f.doc ? randomUUID() : null;
    if (docId) {
      await q(
        `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, size)
         values ($1,$2,$3,$4,'file',$5,'image/jpeg',$6)`,
        [docId, OWNER, f.ws, f.title, keyOf(ID[name]), f.size]
      );
    }
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, document_id, deleted_at)
       values ($1,$2,$3,$4,'file',$5,'{}'::jsonb,'{}'::jsonb,$6,$7)`,
      [
        ID[name],
        OWNER,
        f.ws,
        FILE_PROFILE,
        f.title,
        docId,
        name === "trashed" ? new Date().toISOString() : null,
      ]
    );
  }
  await q(
    `insert into tools (id, name, kind, approved, created_by, workspace_id) values ($1,'postiz','api',true,$2,null)`,
    [TOOL, OWNER]
  );
  for (const [id, name, mode, parameters] of [
    [
      POST_VERB,
      "postiz_schedule_post",
      "sync",
      { content: "string", media: "file[]:url?" },
    ],
    [
      EDIT_VERB,
      "fal_edit_reference_image",
      "async",
      { prompt: "string", image: "file:url" },
    ],
  ] as const) {
    await q(
      `insert into skills (id, user_id, name, kind, scope, status, approved, execution_mode, parameters, provider_spec, metadata)
       values ($1,$2,$3,'declarative','pod','active',true,$4,$5::jsonb,$6::jsonb,'{}'::jsonb)`,
      [
        id,
        OWNER,
        name,
        mode,
        JSON.stringify(parameters),
        JSON.stringify({ tool: "postiz", method: "POST", pathTemplate: "/p" }),
      ]
    );
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'tool',$3,'requires')`,
      [randomUUID(), id, TOOL]
    );
  }
  await q(
    `insert into skills (id, user_id, name, kind, scope, status, approved, execution_mode, parameters, metadata, code)
     values ($1,$2,'unipile_create_post','code','pod','active',true,'async',$3::jsonb,'{}'::jsonb,'return 1')`,
    [
      BYTES_VERB,
      OWNER,
      JSON.stringify({ text: "string", attachments: "file[]:bytes" }),
    ]
  );
}, 120_000);

beforeEach(() => {
  h.signerBase = "https://signed.test";
  h.calls.length = 0;
  h.proposals.length = 0;
  h.events.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const post = (media: unknown, over: Record<string, unknown> = {}) =>
  executeCapability({
    verbId: "postiz_schedule_post",
    parameters: {
      content: "Launch day",
      ...(media === undefined ? {} : { media }),
    },
    workspaceId: null,
    userId: OWNER,
    // Each run its own operation: the direct-run receipt never replays one.
    idempotencyKey: randomUUID(),
    ...over,
  });

const fileSent = () => h.events.filter((e) => e.type === "file.sent");

describe("run time: the tool gets a fresh URL, never the id", () => {
  it("the person's own run sends a 15-minute URL and writes one file.sent per file", async () => {
    const out = await post([ID.photo, ID.second]);
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.media).toEqual([
      `https://signed.test/${keyOf(ID.photo)}?expires=900`,
      `https://signed.test/${keyOf(ID.second)}?expires=900`,
    ]);
    expect(h.calls[0]!.content).toBe("Launch day");
    expect(h.proposals).toHaveLength(0);

    const sent = fileSent();
    expect(sent.map((e) => e.subjectId)).toEqual([ID.photo, ID.second]);
    expect(sent[0]).toMatchObject({
      subjectType: "entity",
      userId: OWNER,
      data: {
        fileId: ID.photo,
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 2_202_009,
        field: "media",
        skillId: POST_VERB,
        verb: "postiz_schedule_post",
        tool: "Postiz",
        delivery: "url",
        urlTtlSeconds: 900,
      },
    });
    // The bearer link itself is never written into the pod's events.
    expect(JSON.stringify(sent)).not.toContain("signed.test");
  });

  it("an async verb's URL lives 6 hours; a `file` parameter gets one URL", async () => {
    const out = await executeCapability({
      verbId: "fal_edit_reference_image",
      parameters: { prompt: "warmer", image: ID.photo },
      workspaceId: null,
      userId: OWNER,
      idempotencyKey: randomUUID(),
    });
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(h.calls[0]!.image).toBe(
      `https://signed.test/${keyOf(ID.photo)}?expires=21600`
    );
    expect(fileSent()).toHaveLength(1);
    expect(fileSent()[0]!.data).toMatchObject({ urlTtlSeconds: 21_600 });
  });

  it("a verb run with no file sends none and writes no file.sent", async () => {
    const out = await post(undefined);
    expect(out.kind).toBe("run");
    expect(h.calls[0]).toEqual({ content: "Launch day" });
    expect(fileSent()).toHaveLength(0);
  });

  it("a local-storage pod refuses: no file:// link leaves, nothing runs", async () => {
    h.signerBase = "file:///var/lib/synap";
    const out = await post([ID.photo]);
    expect(out).toMatchObject({ kind: "error" });
    expect((out as { message: string }).message).toContain("no public address");
    expect(h.calls).toHaveLength(0);
    expect(fileSent()).toHaveLength(0);
  });
});

describe("ask time: only files the caller can read are proposed or run", () => {
  const refused = async (
    media: unknown,
    expected: Array<{ problem: string; fileId?: string }>
  ) => {
    const out = await post(media);
    expect(out.kind, JSON.stringify(out)).toBe("error");
    expect((out as { repair?: { files?: unknown } }).repair?.files).toEqual(
      expected.map((e) => expect.objectContaining({ field: "media", ...e }))
    );
    expect(h.calls).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
    expect(fileSent()).toHaveLength(0);
  };

  it("an unknown file, a trashed one, one with no bytes, one over the cap", async () => {
    const unknown = randomUUID();
    await refused([unknown], [{ problem: "not_found", fileId: unknown }]);
    await refused([ID.trashed], [{ problem: "not_found", fileId: ID.trashed }]);
    await refused(
      [ID.empty],
      [{ problem: "no_stored_bytes", fileId: ID.empty }]
    );
    await refused([ID.big], [{ problem: "too_large", fileId: ID.big }]);
  });

  it("a :bytes verb holds a file to the bytes cap; the same file goes by URL", async () => {
    const out = await executeCapability({
      verbId: "unipile_create_post",
      parameters: { text: "Launch day", attachments: [ID.mid] },
      workspaceId: null,
      userId: OWNER,
      idempotencyKey: randomUUID(),
    });
    expect(out).toMatchObject({
      kind: "error",
      repair: {
        files: [{ field: "attachments", fileId: ID.mid, problem: "too_large" }],
      },
    });
    expect(h.proposals).toHaveLength(0);
    // Control: a URL verb sends the same 150 MB file.
    expect((await post([ID.mid])).kind).toBe("run");
    expect(h.calls).toHaveLength(1);
  });

  it("a value that is not a list of file ids", async () => {
    await refused(ID.photo, [{ problem: "not_a_file_id" }]);
    await refused(["not-a-uuid"], [{ problem: "not_a_file_id" }]);
  });

  it("a key whose grant does not reach the file's space is refused (403 class), in-grant runs", async () => {
    const pinned = grantOfScope({
      permissions: ["*"],
      workspaceIds: [WS_A],
    } as never);
    const outside = await runWithGrant(pinned, () => post([ID.other]));
    expect(outside).toMatchObject({
      kind: "error",
      repair: {
        files: [{ field: "media", fileId: ID.other, problem: "forbidden" }],
      },
    });
    expect(h.calls).toHaveLength(0);
    // Control: the same key, a file in its space, runs.
    const inside = await runWithGrant(pinned, () => post([ID.photo]));
    expect(inside.kind, JSON.stringify(inside)).toBe("run");
    // Control: without the grant, the person reads the other space's file.
    expect((await post([ID.other])).kind).toBe("run");
  });
});

describe("an agent run carrying a pod file always proposes, ids only", () => {
  it("proposes with the file floor's reason, names the file, stores no URL", async () => {
    const out = await post([ID.photo], { agentUserId: AGENT });
    expect(out.kind, JSON.stringify(out)).toBe("proposed");
    expect(h.calls).toHaveLength(0);
    expect(fileSent()).toHaveLength(0);
    expect(h.proposals).toHaveLength(1);
    const p = h.proposals[0]!;
    expect(p.governanceReason).toBe("POD_FILE_OUTWARD");
    expect(p.data.parameters).toEqual({
      content: "Launch day",
      media: [ID.photo],
    });
    expect(p.data.files).toEqual([
      {
        field: "media",
        id: ID.photo,
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 2_202_009,
      },
    ]);
    expect(p.data.summary).toBe("Sends photo.jpg (2.1 MB) to Postiz");
    const stored = JSON.stringify(p.data);
    expect(stored).not.toContain("signed.test");
    expect(stored).not.toContain("X-Amz-Signature");
  });

  it("control: the same agent run with no file proposes for its own reason", async () => {
    const out = await post(undefined, { agentUserId: AGENT });
    expect(out.kind).toBe("proposed");
    expect(h.proposals[0]!.governanceReason).not.toBe("POD_FILE_OUTWARD");
    expect(h.proposals[0]!.data.files).toBeUndefined();
  });

  it("an agent naming a file it cannot read files nothing", async () => {
    const out = await post([randomUUID()], { agentUserId: AGENT });
    expect(out.kind).toBe("error");
    expect(h.proposals).toHaveLength(0);
  });
});

describe("after approval: the file is read again and the URL minted then", () => {
  const skillRow = async (id: string) => {
    const { rows } = await q<{
      id: string;
      name: string;
      kind: string;
      provider_spec: unknown;
      metadata: unknown;
      parameters: unknown;
      execution_mode: string;
    }>(
      `select id, name, kind, provider_spec, metadata, parameters, execution_mode from skills where id = $1`,
      [id]
    );
    const r = rows[0]!;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      providerSpec: r.provider_spec as never,
      metadata: r.metadata,
      parameters: r.parameters,
      executionMode: r.execution_mode,
    };
  };
  /** Replays an approved proposal the way the capability.run executor does. */
  const approve = async (p: (typeof h.proposals)[number]) =>
    runResolvedSkill(
      await skillRow(POST_VERB),
      p.data.parameters as Record<string, unknown>,
      {
        userId: OWNER,
        workspaceId: null,
        provenance: { agentUserId: AGENT, proposalId: p.id },
      }
    );

  it("approved two hours later, the URL is minted at approval and outlives it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const asked = new Date("2026-10-28T10:00:00.000Z");
    vi.setSystemTime(asked);
    await post([ID.later], { agentUserId: AGENT });
    const proposal = h.proposals[0]!;

    const approvedAt = new Date(asked.getTime() + 2 * 3600_000);
    vi.setSystemTime(approvedAt);
    const out = await approve(proposal);
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(h.calls[0]!.media).toEqual([
      `https://signed.test/${keyOf(ID.later)}?expires=900`,
    ]);
    const [event] = fileSent();
    expect(event).toMatchObject({
      proposalId: proposal.id,
      data: { agentUserId: AGENT, proposalId: proposal.id },
    });
    const expiresAt = Date.parse(
      (event!.data as { urlExpiresAt: string }).urlExpiresAt
    );
    expect(expiresAt).toBe(approvedAt.getTime() + 900_000);
    expect(expiresAt).toBeGreaterThan(approvedAt.getTime());
  });

  it("a file deleted before approval is not sent: a definite not-delivered", async () => {
    const victim = randomUUID();
    const docId = randomUUID();
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, size)
       values ($1,$2,$3,'v.jpg','file',$4,'image/jpeg',10)`,
      [docId, OWNER, WS_A, keyOf(victim)]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, document_id)
       values ($1,$2,$3,$4,'file','v.jpg','{}'::jsonb,'{}'::jsonb,$5)`,
      [victim, OWNER, WS_A, FILE_PROFILE, docId]
    );
    await post([victim], { agentUserId: AGENT });
    const proposal = h.proposals[0]!;
    expect(proposal.governanceReason).toBe("POD_FILE_OUTWARD");

    // Trashed, then approved.
    await q(`update entities set deleted_at = now() where id = $1`, [victim]);
    const trashed = await approve(proposal);
    expect(trashed).toMatchObject({ kind: "error" });
    expect((trashed as { message: string }).message).toContain(
      "can no longer be sent"
    );

    // Gone for good, then approved again (Retry).
    await q(`delete from entities where id = $1`, [victim]);
    expect(await approve(proposal)).toMatchObject({ kind: "error" });

    expect(h.calls).toHaveLength(0);
    expect(fileSent()).toHaveLength(0);
  });
});

describe("files as bytes only reach a code verb", () => {
  it("a declarative verb declaring :bytes is refused at run time, before any read", async () => {
    const out = await runResolvedSkill(
      {
        id: POST_VERB,
        name: "postiz_schedule_post",
        kind: "declarative",
        providerSpec: {
          tool: "postiz",
          method: "POST",
          pathTemplate: "/p",
        } as never,
        metadata: {},
        parameters: { media: "file[]:bytes" },
        executionMode: "sync",
      },
      { media: [ID.photo] },
      { userId: OWNER, workspaceId: null }
    );
    expect(out).toMatchObject({ kind: "error" });
    expect((out as { message: string }).message).toContain(
      "only a code verb run in the pod can send"
    );
    expect(h.calls).toHaveLength(0);
    expect(fileSent()).toHaveLength(0);
  });
});
