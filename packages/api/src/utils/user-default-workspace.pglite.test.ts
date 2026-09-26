/**
 * D7 — the user's default-workspace FALLBACK never picks the pod-admin console
 * (or an archived workspace), and says `null` when there is no real one.
 *
 * Before: nine call sites did an unordered `workspaceMembers.findFirst` by
 * userId. A new owner (D7: no auto-created blank workspace) has ONLY the
 * pod-admin membership, so chat channels, API keys, import proposals and
 * attachments were filed into the operator console — a calm, wrong answer.
 *
 * Second half: a SOURCE tripwire over every api/src file (derived by glob, not a
 * hand list) — no bare "first membership by userId" fallback may reappear.
 * It cannot see a fallback written as a raw `select().from(workspaceMembers)`
 * with a different variable layout; the helper pglite cases cover behaviour.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { findUserDefaultWorkspaceId } from "./user-default-workspace.js";

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function workspace(opts: {
  owner: string;
  system?: string;
  archived?: boolean;
  joinedAt: string;
  updatedAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, archived_at, updated_at) values ($1,'w',$2,$3,$4,$5)`,
    [
      id,
      opts.owner,
      opts.system ?? null,
      opts.archived ? new Date() : null,
      opts.updatedAt ?? opts.joinedAt,
    ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role, joined_at) values ($1,$2,$3,'owner',$4)`,
    [randomUUID(), id, opts.owner, opts.joinedAt]
  );
  return id;
}

beforeAll(async () => {
  await h.client!.exec(`
    create table workspaces (id uuid primary key, name text, owner_id text, system_slug text, archived_at timestamptz, updated_at timestamptz);
    create table workspace_members (id uuid primary key, workspace_id uuid, user_id text, role text, joined_at timestamptz);
  `);
});

const db = () => h.db as never;

describe("findUserDefaultWorkspaceId (D7)", () => {
  it("a new owner with ONLY the pod-admin console has no default workspace", async () => {
    const u = randomUUID();
    await workspace({ owner: u, system: "pod-admin", joinedAt: "2026-01-01" });
    await workspace({ owner: u, archived: true, joinedAt: "2026-01-02" });
    expect(await findUserDefaultWorkspaceId(db(), u)).toBeNull();
  });

  it("picks the first-joined DOMAIN workspace, even when pod-admin was joined first", async () => {
    const u = randomUUID();
    await workspace({ owner: u, system: "pod-admin", joinedAt: "2026-01-01" });
    const first = await workspace({ owner: u, joinedAt: "2026-02-01" });
    await workspace({ owner: u, joinedAt: "2026-03-01" });
    expect(await findUserDefaultWorkspaceId(db(), u)).toBe(first);
  });

  it("`recent` picks the most recently updated domain workspace", async () => {
    const u = randomUUID();
    await workspace({
      owner: u,
      joinedAt: "2026-02-01",
      updatedAt: "2026-02-01",
    });
    const recent = await workspace({
      owner: u,
      joinedAt: "2026-01-01",
      updatedAt: "2026-09-01",
    });
    await workspace({
      owner: u,
      system: "pod-admin",
      joinedAt: "2026-01-01",
      updatedAt: "2026-12-01",
    });
    expect(await findUserDefaultWorkspaceId(db(), u, "recent")).toBe(recent);
  });
});

describe("tripwire: no bare first-membership fallback by userId", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  // A bare lookup: findFirst whose ONLY where-clause is the userId (no
  // workspaceId in the predicate) — the shape of the defaulting fallback.
  const BARE =
    /workspaceMembers\.findFirst\(\{\s*where:\s*eq\(workspaceMembers\.userId,[^)]*\),/g;
  // Existence checks that do NOT pick a default (they ask "any membership?"),
  // each read and justified:
  const EXEMPT = new Set([
    "routers/workspaces/invites.ts", // stale-user / removal: "still a member anywhere?"
    "routers/hub-protocol/rest/setup.ts", // accept-invite: existing-user existence check
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") && !p.includes(".test.")) out.push(p);
    }
    return out;
  }
  const files = walk(SRC);

  it("scans a plausible number of files and can still see the pattern (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    const sample =
      "workspaceMembers.findFirst({\n      where: eq(workspaceMembers.userId, userId),";
    expect(sample.match(BARE)).toHaveLength(1);
  });

  it("every default-picking fallback goes through findUserDefaultWorkspaceId", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      if (EXEMPT.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      const hits = src.match(BARE);
      if (hits) offenders.push(`${rel} (${hits.length})`);
    }
    expect(offenders).toEqual([]);
  });
});
