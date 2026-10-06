/**
 * APP ATTRIBUTION (App Connect v1) — the review projection renders "via <app>".
 *
 * `enrichProposalsForDisplay` batch-resolves the app NAME for every proposal on
 * the page whose row carries an `appId` (the app's `public_id`), floored to the
 * VIEWER's own apps. Pinned: an app-attributed proposal resolves `appName`; a
 * bare proposal (appId null) resolves none; an app the viewer does NOT own
 * resolves no name (no name oracle).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "human-1";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

function proposalRow(appId: string | null) {
  return {
    id: randomUUID(),
    workspaceId: null,
    targetType: "entity",
    targetId: randomUUID(),
    proposalType: "create",
    data: { title: "a note" },
    status: "pending",
    createdBy: null,
    proposedByUserId: null,
    subjectUserId: VIEWER,
    threadId: null,
    commandRunId: null,
    sourceMessageId: null,
    agentUserId: null,
    correlationId: null,
    requestedEventId: null,
    sessionId: null,
    stepRunId: null,
    nodeId: null,
    projectId: null,
    dedupHash: null,
    expiresAt: null,
    reviewedBy: null,
    reviewedAt: null,
    externalDispatchedAt: null,
    rejectionReason: null,
    reasonCode: null,
    governanceReason: null,
    appId,
    comments: [],
    revisionHistory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function seedApp(ownerUserId: string, name: string): Promise<string> {
  const publicId = `app_${randomUUID().toLowerCase()}`;
  await h.client!.query(
    `insert into apps (owner_user_id, public_id, name) values ($1, $2, $3)`,
    [ownerUserId, publicId, name]
  );
  return publicId;
}

describe("proposal display resolves the app name (App Connect v1)", () => {
  it("resolves appName for an app the viewer owns", async () => {
    const publicId = await seedApp(VIEWER, "synap.live");
    const [enriched] = await enrichProposalsForDisplay(
      [proposalRow(publicId)] as never,
      VIEWER
    );
    expect(enriched!.appId).toBe(publicId);
    expect(enriched!.appName).toBe("synap.live");
  });

  it("leaves appId null and appName absent for a bare proposal", async () => {
    const [enriched] = await enrichProposalsForDisplay(
      [proposalRow(null)] as never,
      VIEWER
    );
    expect(enriched!.appId ?? null).toBeNull();
    expect(enriched!.appName).toBeUndefined();
  });

  it("does NOT resolve a name for an app the viewer does not own (no oracle)", async () => {
    const publicId = await seedApp("someone-else", "Their App");
    const [enriched] = await enrichProposalsForDisplay(
      [proposalRow(publicId)] as never,
      VIEWER
    );
    expect(enriched!.appId).toBe(publicId); // the machine field still rides the row
    expect(enriched!.appName).toBeUndefined();
  });
});
