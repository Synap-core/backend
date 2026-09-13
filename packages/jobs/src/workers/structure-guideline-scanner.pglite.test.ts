/**
 * The structure-guideline scanner's DB tier, driven END TO END on PGlite.
 *
 * Real: `handleStructureGuidelineScan` → the decided-proposal load (including
 * the `jsonb_path_exists` disposition filter) → clustering → `findCurrentGuideline`
 * → `fileProposal` → `insertPendingProposal` (the ONE pending-proposal door) →
 * and, on the second pass, `latestProposalForCluster` reading the stored
 * `data->>'clusterKey'` back. Nothing is injected: the unit test injects every
 * DB access, which is exactly why a key jsonb refuses to store (NUL, 22P05)
 * shipped unseen — no test ever inserted it.
 *
 * Tables are GENERATED from the Drizzle definitions (defaults included, enum
 * columns as text), so every column the doors write exists.
 *
 * Stubbed, and why: `emitSideEffects` — realtime/notification fan-out with its
 * own suites (importOriginal + spread, never a total mock).
 *
 * NOT covered: the scan's cron/queue registration (queues-are-created tripwire)
 * and cross-connection concurrency (PGlite is one connection).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        proposals: schema.proposals,
        configSettings: schema.configSettings,
      } as never,
    }),
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, configSettings } from "@synap/database/schema";
import {
  handleStructureGuidelineScan,
  structureClusterKey,
} from "./structure-guideline-scanner.js";

// Built from code points, never escapes, so the source file stays plain text.
const NUL = String.fromCharCode(0);
const QUOTE = String.fromCharCode(34);

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";

/** An approved capture graph whose `person` item a reviewer rejected, with a reason. */
async function rejectedPersonItem(reason: string) {
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, subject_user_id, workspace_id, reviewed_at, created_at, updated_at)
     values ($1, 'approved', 'capture.graph', 'entity', $2, $3::jsonb, $4, $4, null, now(), now(), now())`,
    [
      randomUUID(),
      randomUUID(),
      JSON.stringify({
        operations: [{ op: "create_entity", profileSlug: "person", ref: "p1" }],
        dispositions: {
          p1: { status: "reject", reasonCode: "bad_data", reason },
        },
      }),
      USER,
    ]
  );
}

async function structureGuidelineProposals() {
  const { rows } = await q<{ status: string; cluster_key: string | null }>(
    `select status, data->>'clusterKey' as cluster_key
       from proposals where proposal_type = 'governance.structure_guideline'`
  );
  return rows;
}

beforeAll(async () => {
  // Touch the mocked module so the PGlite client exists before DDL runs.
  await import("@synap/database");
  await h.client!.exec(
    [proposals, configSettings].map((t) => ddlFor(t as PgTable)).join("\n")
  );
});

describe("structureClusterKey — storable and collision-safe", () => {
  it("contains no NUL and keeps an absent ref distinct from an empty one", () => {
    const absent = structureClusterKey({
      userId: USER,
      scopeKind: "default",
      scopeRef: null,
    });
    const empty = structureClusterKey({
      userId: USER,
      scopeKind: "default",
      scopeRef: "",
    });
    expect(absent.includes(NUL)).toBe(false);
    expect(absent).not.toBe(empty);
    // A value that embeds the old separator style cannot forge another key.
    const forged = ["b", "c"].join(`${QUOTE},${QUOTE}`);
    expect(
      structureClusterKey({ userId: "a", scopeKind: forged, scopeRef: null })
    ).not.toBe(
      structureClusterKey({ userId: "a", scopeKind: "b", scopeRef: "c" })
    );
  });
});

describe("structure-guideline scan — the REAL DB tier round-trips the cluster key", () => {
  it("files ONE pending proposal whose clusterKey jsonb stored, and a second scan dedups on it", async () => {
    await rejectedPersonItem("the phone number was invented");
    await rejectedPersonItem("made-up email");
    await rejectedPersonItem("wrong company name");

    await handleStructureGuidelineScan();
    const first = await structureGuidelineProposals();
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({
      status: "pending",
      cluster_key: structureClusterKey({
        userId: USER,
        scopeKind: "entityKind",
        scopeRef: "person",
      }),
    });

    // Second pass: `latestProposalForCluster` must FIND the stored key and skip.
    await handleStructureGuidelineScan();
    expect(await structureGuidelineProposals()).toHaveLength(1);
  });
});
