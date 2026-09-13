/**
 * A DOUBLE APPLY LINKS, IT NEVER DUPLICATES — on a real Postgres (PGlite).
 *
 * The composite approval branch (and `import.apply`, routed through it by
 * intake D7) passes `approvalIdempotency(db, { userId, proposal })` into
 * `materializeCompositeGraph`. Driven here through the real materializer and the
 * real external-link store: materializing the same proposal twice creates the
 * graph once; a DIFFERENT proposal is a different namespace and creates its own.
 *
 * Stubbed: the create doors (they insert rows as the doors do) and the
 * post-commit fan-out — same boundary as `reversibility/__tests__/run-revert.pglite`.
 * NOT covered: that `applyProposalApproval` still passes the option (asserted
 * by the source check at the bottom, not by driving the procedure).
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/property-relation-sync.js", () => ({
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerIdentitySignals: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { db as DatabaseHandle } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import {
  approvalIdempotency,
  approvalIdempotencyNamespace,
  approvalIdempotencyProvider,
} from "../approval-idempotency.js";

const USER = "user-1";

const DDL = `
  create table entities (
    id uuid primary key, user_id text not null, workspace_id uuid,
    type text not null, title text, properties jsonb not null default '{}'::jsonb,
    source_proposal_id uuid,
    created_at timestamptz not null default now(), deleted_at timestamptz
  );
  create table relations (
    id uuid primary key, user_id text not null, source_entity_id uuid,
    target_entity_id uuid, type text not null, source_proposal_id uuid
  );
  create table entity_external_links (
    id uuid primary key default gen_random_uuid(), entity_id uuid not null,
    provider text not null, external_id text not null,
    nango_connection_id text not null, status text not null default 'active',
    sync_hash text, url text, last_synced_at timestamptz, disconnected_at timestamptz,
    created_at timestamptz not null default now()
  );
  -- The lookup's connector owner floor reads secrets (id, user_id) only.
  create table secrets (id uuid primary key default gen_random_uuid(), user_id text not null);
  -- Migration 0261's key — the writer's ON CONFLICT target (exact index match).
  create unique index entity_external_links_provider_external_id_conn_idx
    on entity_external_links (provider, external_id, nango_connection_id);
`;

type Database = typeof DatabaseHandle;

async function freshDb() {
  const client = new PGlite();
  await client.exec(DDL);
  return { client, database: drizzle(client) as unknown as Database };
}

function doors(client: PGlite) {
  return {
    entityCaller: {
      create: async (input: { title?: string }) => {
        const id = randomUUID();
        await client.query(
          `insert into entities (id, user_id, type, title) values ($1, $2, 'note', $3)`,
          [id, USER, input.title ?? "Untitled"]
        );
        return { status: "created", id };
      },
    },
    relationCaller: {
      create: async (input: {
        sourceEntityId: string;
        targetEntityId: string;
        type: string;
      }) => {
        const id = randomUUID();
        await client.query(
          `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values ($1, $2, $3, $4, $5)`,
          [id, USER, input.sourceEntityId, input.targetEntityId, input.type]
        );
        return { status: "created", id };
      },
    },
  };
}

const GRAPH = [
  { op: "create_entity", ref: "a", profileSlug: "note", title: "Alpha" },
  { op: "create_entity", ref: "b", profileSlug: "note", title: "Beta" },
  { op: "create_relation", sourceRef: "a", targetRef: "b", type: "relates_to" },
] as CompositeProposalOperation[];

async function applyOnce(
  client: PGlite,
  database: Database,
  proposal: { id: string; proposalType: string }
) {
  const d = doors(client);
  return materializeCompositeGraph(
    GRAPH,
    d.entityCaller,
    d.relationCaller,
    () => {},
    {
      idempotency: approvalIdempotency(database, { userId: USER, proposal }),
    }
  );
}

async function entityCount(client: PGlite) {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from entities where deleted_at is null`
  );
  return rows[0]!.n;
}

describe("approval idempotency — the same proposal applied twice", () => {
  it("the second apply LINKS every entity the first created; nothing is duplicated", async () => {
    const { client, database } = await freshDb();
    const proposal = { id: randomUUID(), proposalType: "import.graph" };

    const first = await applyOnce(client, database, proposal);
    const second = await applyOnce(client, database, proposal);

    expect(first.entities.map((e) => e.linked)).toEqual([false, false]);
    expect(second.entities.map((e) => e.linked)).toEqual([true, true]);
    expect(second.entities.map((e) => e.entityId).sort()).toEqual(
      first.entities.map((e) => e.entityId).sort()
    );
    expect(await entityCount(client)).toBe(2);
  });

  it("a DIFFERENT proposal is a different namespace and creates its own graph", async () => {
    const { client, database } = await freshDb();
    await applyOnce(client, database, {
      id: randomUUID(),
      proposalType: "import.graph",
    });
    const other = await applyOnce(client, database, {
      id: randomUUID(),
      proposalType: "import.graph",
    });
    expect(other.entities.every((e) => !e.linked)).toBe(true);
    expect(await entityCount(client)).toBe(4);
  });

  it("keeps import.apply's pre-D7 namespace, so a half-applied direct import still links", () => {
    // import.apply keyed `${userId}:${resolveImportIdempotencyKey(...)}` with
    // provider "import", whose default key IS the analyze proposal id.
    expect(approvalIdempotencyNamespace(USER, "p-1")).toBe(`${USER}:p-1`);
    expect(approvalIdempotencyProvider("import.graph")).toBe("import");
    expect(approvalIdempotencyProvider("capture.graph")).toBe("proposal");
  });
});

describe("the composite approval branch passes it", () => {
  it("apply-approval.ts wires approvalIdempotency into the composite materialize options", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../routers/proposals/apply-approval.ts"
      ),
      "utf8"
    );
    const call = src.indexOf(
      "await materializeCompositeGraph(\n      reconciledOperations,"
    );
    expect(call).toBeGreaterThan(-1);
    const options = src.slice(call, src.indexOf("\n    );", call));
    expect(options).toContain(
      "idempotency: approvalIdempotency(db, { userId, proposal })"
    );
  });
});
