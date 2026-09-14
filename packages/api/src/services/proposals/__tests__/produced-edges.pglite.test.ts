/**
 * THE CAPTURE → ENTITY `produced` EDGE — written by `stampMaterialized`, on a
 * real Postgres (PGlite), through the real stamp. Nothing downstream of the
 * receipt row is hand-built: the ids come from `data.sourceDocumentIds` on the
 * stored proposal, exactly as the capture doors write them (contract §1).
 *
 * The tables carry only the columns these paths touch.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { proposals, type db as DatabaseHandle } from "@synap/database";
import {
  stampMaterialized,
  writeProducedEdges,
} from "../stamp-materialized.js";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const WORKSPACE = "cccccccc-3333-4333-8333-333333333333";

const DDL = `
  create table proposals (
    id uuid primary key, workspace_id text, subject_user_id text,
    status text not null default 'auto_approved',
    proposal_type text not null default 'capture.graph',
    target_type text not null default 'entity', target_id text not null default 'x',
    data jsonb not null
  );
  create table documents (
    id uuid primary key, user_id text not null, workspace_id uuid,
    deleted_at timestamptz
  );
  create table entities (id uuid primary key, workspace_id uuid);
  create table links (
    id uuid primary key default gen_random_uuid(), workspace_id uuid,
    from_type text not null, from_id text not null,
    to_type text not null, to_id text not null, link_type text not null,
    metadata jsonb not null default '{}'::jsonb, created_by text,
    created_at timestamptz not null default now()
  );
  create unique index idx_links_unique_edge
    on links (from_type, from_id, to_type, to_id, link_type);
`;

type Database = typeof DatabaseHandle;

async function setup(opts: {
  documents: { userId: string; deleted?: boolean }[];
  entityCount: number;
  subjectUserId?: string | null;
}) {
  const client = new PGlite();
  await client.exec(DDL);
  const database = drizzle(client, {
    schema: { proposals },
  }) as unknown as Database;

  const documentIds: string[] = [];
  for (const d of opts.documents) {
    const id = randomUUID();
    documentIds.push(id);
    await client.query(
      `insert into documents (id, user_id, deleted_at) values ($1, $2, $3)`,
      [id, d.userId, d.deleted ? new Date().toISOString() : null]
    );
  }
  const entityIds: string[] = [];
  for (let i = 0; i < opts.entityCount; i++) {
    const id = randomUUID();
    entityIds.push(id);
    await client.query(
      `insert into entities (id, workspace_id) values ($1, $2)`,
      [id, WORKSPACE]
    );
  }
  const proposalId = randomUUID();
  await client.query(
    `insert into proposals (id, subject_user_id, data) values ($1, $2, $3::jsonb)`,
    [
      proposalId,
      opts.subjectUserId === undefined ? OWNER : opts.subjectUserId,
      JSON.stringify({ sourceDocumentIds: documentIds }),
    ]
  );

  const edges = async () =>
    (
      await client.query<{
        from_id: string;
        to_id: string;
        workspace_id: string | null;
        metadata: { proposalId?: string };
      }>(
        `select from_id, to_id, workspace_id, metadata from links
         where from_type = 'document' and to_type = 'entity' and link_type = 'produced'`
      )
    ).rows;

  return { database, proposalId, documentIds, entityIds, edges };
}

describe("stampMaterialized — document --produced--> entity", () => {
  it("links the receipt's capture to every entity it created", async () => {
    const { database, proposalId, documentIds, entityIds, edges } = await setup(
      { documents: [{ userId: OWNER }], entityCount: 2 }
    );

    await stampMaterialized({ proposalId, record: { entityIds }, database });

    const rows = await edges();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.to_id).sort()).toEqual([...entityIds].sort());
    for (const r of rows) {
      expect(r.from_id).toBe(documentIds[0]);
      // The edge lives where the ENTITY lives.
      expect(r.workspace_id).toBe(WORKSPACE);
      expect(r.metadata.proposalId).toBe(proposalId);
    }
  });

  it("a re-stamp writes no duplicate and adds only the missing edge", async () => {
    const { database, proposalId, entityIds, edges } = await setup({
      documents: [{ userId: OWNER }],
      entityCount: 3,
    });

    await stampMaterialized({
      proposalId,
      record: { entityIds: entityIds.slice(0, 2) },
      database,
    });
    expect(await edges()).toHaveLength(2);

    // A retry that created one more entity: the first two edges already exist.
    await stampMaterialized({ proposalId, record: { entityIds }, database });
    const rows = await edges();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.to_id).sort()).toEqual([...entityIds].sort());
  });

  it("never links a document owned by someone else", async () => {
    const { database, proposalId, documentIds, entityIds, edges } = await setup(
      {
        documents: [{ userId: OWNER }, { userId: STRANGER }],
        entityCount: 1,
      }
    );

    await stampMaterialized({ proposalId, record: { entityIds }, database });

    const rows = await edges();
    expect(rows.map((r) => r.from_id)).toEqual([documentIds[0]]);
  });

  it("never links a deleted document", async () => {
    const { database, proposalId, entityIds, edges } = await setup({
      documents: [{ userId: OWNER, deleted: true }],
      entityCount: 1,
    });
    await stampMaterialized({ proposalId, record: { entityIds }, database });
    expect(await edges()).toHaveLength(0);
  });

  it("writeProducedEdges (no proposal): owner's documents only, idempotent, counted", async () => {
    const { database, documentIds, entityIds, edges } = await setup({
      documents: [{ userId: OWNER }, { userId: STRANGER }],
      entityCount: 2,
    });

    const first = await writeProducedEdges({
      database,
      userId: OWNER,
      sourceDocumentIds: [...documentIds, "not-a-uuid"],
      entityIds,
    });
    expect(first.inserted).toBe(2);
    const rows = await edges();
    expect(rows.map((r) => r.from_id)).toEqual([
      documentIds[0],
      documentIds[0],
    ]);
    expect(rows.every((r) => r.metadata.proposalId === undefined)).toBe(true);

    const again = await writeProducedEdges({
      database,
      userId: OWNER,
      sourceDocumentIds: documentIds,
      entityIds,
    });
    expect(again.inserted).toBe(0);
    expect(await edges()).toHaveLength(2);

    const stranger = await writeProducedEdges({
      database,
      userId: STRANGER,
      sourceDocumentIds: [documentIds[0]!],
      entityIds,
    });
    expect(stranger.inserted).toBe(0);
    expect(await edges()).toHaveLength(2);
  });

  it("links nothing when the receipt has no owner to check against", async () => {
    const { database, proposalId, entityIds, edges } = await setup({
      documents: [{ userId: OWNER }],
      entityCount: 1,
      subjectUserId: null,
    });
    await stampMaterialized({ proposalId, record: { entityIds }, database });
    expect(await edges()).toHaveLength(0);
  });
});
