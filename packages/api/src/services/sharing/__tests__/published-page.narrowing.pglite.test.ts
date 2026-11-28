/**
 * What a publish may freeze onto the public web (decision D2 default,
 * surfaces review D2 / security M2 / code-quality S7, 27 Nov 2026):
 *   - only reads on the publish allowlist run (`publishedReadRefusal`):
 *     entity, document, view and kind reads; `entities.list` names its kind;
 *   - when an agent is in the chain (it proposed the publish, or it wrote the
 *     page), each read runs with the agent's identity, its key's grant and
 *     its key's binding; an agent whose key cannot be found reads nothing.
 *
 * Driven through the REAL `buildPublishedPage` and the REAL key and grant
 * reads (`api_keys`, `grants`, `GrantRepository.resolveForKey`) on PGlite.
 * The frame read door is replaced by a recorder of what each read ran WITH
 * (its context and the grant in force), which is what this test is about.
 *
 * Rows, each ruling out a wrong outcome:
 *  - a page declaring `sessions.list`, `entities.list` of every kind ("*")
 *    and `entities.list` of deals: only the deal read runs, the two others are
 *    kept as errors naming why (rules out "anything declared is published");
 *  - the person's own page: read as the person, no grant (rules out "every
 *    publish is narrowed");
 *  - an agent-written page: read as that agent, under its key's grant and
 *    binding (rules out "publish reads at the owner's whole floor");
 *  - an agent-proposed publish: the proposing key wins;
 *  - an agent-written page whose key is revoked: nothing runs, every read is
 *    an error (rules out "no key found = the owner's floor").
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  reads: [] as Array<{
    op: string;
    agentUserId: unknown;
    keyWorkspaceId: unknown;
    grant: unknown;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../surfaces/frame-read.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { getRequestGrant } = await import("@synap/database");
  return {
    ...actual,
    frameRead: vi.fn(
      async (
        ctx: { agentUserId?: unknown; keyWorkspaceId?: unknown },
        input: { op: string }
      ) => {
        h.reads.push({
          op: input.op,
          agentUserId: ctx.agentUserId ?? null,
          keyWorkspaceId: ctx.keyWorkspaceId ?? null,
          grant: getRequestGrant() ?? null,
        });
        return [];
      }
    ),
  };
});
vi.mock("../../surfaces/surface-context.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSurfaceContext: vi.fn(async () => ({ ok: true, context: {} })),
}));

import { getDb } from "@synap/database";
import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { buildPublishedPage } from "../published-page.js";

const A = randomUUID(); // the publisher
const AGENT = randomUUID();
const W = randomUUID();
const KEY = randomUUID(); // the agent's key, bound to W
const OLD_KEY = randomUUID(); // a revoked key
const PROPOSING_KEY = randomUUID();
const P_WROTE = randomUUID(); // the proposal that created the agent's page
const P_OLD = randomUUID(); // the proposal of a page written with the revoked key

const READS = [
  { op: "sessions.list" },
  { op: "entities.list", params: { profileSlug: "*" } },
  { op: "entities.list", params: { profileSlug: "deal" } },
];

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function page(
  agentUserId: string | null,
  sourceProposalId: string | null,
  reads: unknown = READS
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, mime_type, metadata, agent_user_id, source_proposal_id, current_version, content_revision)
     values ($1,$2,$3,'Page','html','text/html',$4::jsonb,$5,$6,1,1)`,
    [id, A, W, JSON.stringify({ reads }), agentUserId, sourceProposalId]
  );
  return id;
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into api_keys (id, user_id, key_name, key_prefix, key_hash, key_type, is_active, usage_count, workspace_id, revoked_at)
     values ($1,$2,'agent','synap_','h1','hub_inbound',true,0,$3,null),
            ($4,$2,'old','synap_','h2','hub_inbound',false,0,null,now()),
            ($5,$2,'proposer','synap_','h3','hub_inbound',true,0,null,null)`,
    [KEY, AGENT, W, OLD_KEY, PROPOSING_KEY]
  );
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, created_by)
     values (gen_random_uuid(), $1, $2, $3, ARRAY['entity.read'], $3),
            (gen_random_uuid(), $4, $2, $3, ARRAY['document.read'], $3)`,
    [KEY, AGENT, A, PROPOSING_KEY]
  );
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, status, data, api_key_id)
     values ($1,'document',$2,'create','approved','{}'::jsonb,$3), ($4,'document',$5,'create','approved','{}'::jsonb,$6)`,
    [P_WROTE, P_WROTE, KEY, P_OLD, P_OLD, OLD_KEY]
  );
}, 120_000);

beforeEach(() => {
  h.reads.length = 0;
});

const permissionsOf = (grant: unknown) =>
  (
    grant as { scopes: Array<{ permissions: string[] }> } | null
  )?.scopes.flatMap((s) => s.permissions) ?? null;

describe("only publishable reads are frozen public", () => {
  it("sessions.list and entities.list of every kind are withheld, the deal read runs", async () => {
    const payload = await buildPublishedPage(await getDb(), {
      publisherUserId: A,
      documentId: await page(null, null),
    });
    expect(h.reads.map((r) => r.op)).toEqual(["entities.list"]);
    expect(payload.reads.map((r) => r.ok)).toEqual([false, false, true]);
    expect(payload.reads[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a read a published page may carry"),
    });
    expect(payload.reads[1]).toMatchObject({
      ok: false,
      error: expect.stringContaining("ONE kind"),
    });
  });

  it("the person's own page: read as the person, no grant", async () => {
    await buildPublishedPage(await getDb(), {
      publisherUserId: A,
      documentId: await page(null, null),
    });
    expect(h.reads).toEqual([
      {
        op: "entities.list",
        agentUserId: null,
        keyWorkspaceId: null,
        grant: null,
      },
    ]);
  });
});

describe("an agent in the chain narrows the reads to its key", () => {
  it("an agent-written page: read as the agent, under its key's grant and binding", async () => {
    await buildPublishedPage(await getDb(), {
      publisherUserId: A,
      documentId: await page(AGENT, P_WROTE),
    });
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toMatchObject({ agentUserId: AGENT, keyWorkspaceId: W });
    expect(permissionsOf(h.reads[0]!.grant)).toEqual(["entity.read"]);
  });

  it("an agent-proposed publish: the proposing key's grant wins", async () => {
    await buildPublishedPage(await getDb(), {
      publisherUserId: A,
      documentId: await page(AGENT, P_WROTE),
      proposedBy: { agentUserId: AGENT, apiKeyId: PROPOSING_KEY },
    });
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toMatchObject({
      agentUserId: AGENT,
      keyWorkspaceId: null,
    });
    expect(permissionsOf(h.reads[0]!.grant)).toEqual(["document.read"]);
  });

  it("an agent-written page whose key is revoked: nothing runs, every read is an error", async () => {
    const payload = await buildPublishedPage(await getDb(), {
      publisherUserId: A,
      documentId: await page(AGENT, P_OLD),
    });
    expect(h.reads).toEqual([]);
    expect(payload.reads.every((r) => !r.ok)).toBe(true);
    expect(payload.reads).toHaveLength(3);
  });
});
