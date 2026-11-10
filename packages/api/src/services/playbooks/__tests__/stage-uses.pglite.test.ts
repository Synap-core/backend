/**
 * A STEP THAT IS A PLAYBOOK is checked and pinned at the write door
 * (`resolveStageUses`, spec 7111934d §2.3), and every kept version of a
 * playbook can be read back (`recordPlaybookVersion` / `loadPlaybookVersion`,
 * 0416).
 *
 * Real: the `playbooks` and `playbook_versions` tables on PGlite, the door,
 * the version writer and reader. Nothing is stubbed but the pool.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
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
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

import * as schema from "@synap/database/schema";
import { resolveStageUses } from "../stage-uses.js";
import {
  PLAYBOOK_VERSION_FIELDS,
  loadPlaybookVersion,
  recordPlaybookVersion,
} from "../playbook-versions.js";

type Db = Parameters<typeof recordPlaybookVersion>[0];
const db = () =>
  h.db as Db & {
    insert: Db["insert"];
    update: (t: unknown) => {
      set: (v: unknown) => { where: (w: unknown) => Promise<unknown> };
    };
  };

const WS = randomUUID();
const OTHER_WS = randomUUID();
const USER = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  await h.init();
  // The two tables as 0416 / the baseline make them (the parts the door reads).
  await h.client!.exec(`
    create table playbooks (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid,
      created_by text not null,
      name text not null,
      description text,
      goal_template text not null,
      params jsonb not null default '[]',
      input_strategy jsonb not null default '{"kind":"none"}',
      channel_spec jsonb not null default '{}',
      expected_outputs jsonb not null default '[]',
      stages jsonb not null default '[]',
      criteria jsonb not null default '[]',
      tools jsonb not null default '[]',
      guidance jsonb not null default '[]',
      runner jsonb,
      requires jsonb not null default '[]',
      version integer not null default 1,
      schedule jsonb,
      executor text not null default 'is-agent',
      status text not null default 'draft',
      scope text,
      flow_automation_id uuid,
      subject_profile jsonb,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table playbook_versions (
      playbook_id uuid not null,
      version integer not null,
      definition jsonb not null,
      created_by text,
      created_at timestamptz not null default now(),
      primary key (playbook_id, version)
    );
  `);
});

/** A playbook row, its current version kept like the write doors keep it. */
async function playbook(opts: {
  name: string;
  workspaceId?: string | null;
  version?: number;
  status?: "draft" | "active" | "paused" | "archived";
  params?: unknown[];
  stages?: unknown[];
}): Promise<string> {
  const id = randomUUID();
  const [row] = await (h.db as any)
    .insert(schema.playbooks)
    .values({
      id,
      workspaceId: opts.workspaceId === undefined ? WS : opts.workspaceId,
      createdBy: USER,
      name: opts.name,
      goalTemplate: `Do ${opts.name}`,
      params: opts.params ?? [],
      stages: opts.stages ?? [],
      version: opts.version ?? 1,
      status: opts.status ?? "active",
    })
    .returning();
  await recordPlaybookVersion(db(), row, USER);
  return id;
}

/** Keep an EARLIER version of a playbook (a version written before an edit). */
async function keepVersion(
  id: string,
  version: number,
  definition: Record<string, unknown>
): Promise<void> {
  await (h.db as any).insert(schema.playbookVersions).values({
    playbookId: id,
    version,
    definition,
  });
}

const step = (key: string, uses?: Record<string, unknown>) => ({
  key,
  name: key,
  category: "started" as const,
  ...(uses ? { uses: uses as { playbookId: string; version?: number } } : {}),
});

describe("resolveStageUses — a step that is a playbook, pinned at the write door", () => {
  it("leaves a stage list with no `uses` exactly as it was (the same array)", async () => {
    const stages = [step("a"), step("b")];
    const out = await resolveStageUses({
      stages,
      selfId: null,
      workspaceId: WS,
    });
    expect(out).toBe(stages);
    expect(
      await resolveStageUses({
        stages: undefined,
        selfId: null,
        workspaceId: WS,
      })
    ).toBeUndefined();
  });

  it("pins an absent version to the used playbook's CURRENT version", async () => {
    const used = await playbook({ name: "Transcribe a take", version: 4 });
    const out = await resolveStageUses({
      stages: [step("transcribe", { playbookId: used })],
      selfId: null,
      workspaceId: WS,
    });
    expect(out![0]!.uses).toEqual({ playbookId: used, version: 4 });
  });

  it("refuses a playbook that does not exist, or is archived", async () => {
    await expect(
      resolveStageUses({
        stages: [step("x", { playbookId: randomUUID() })],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/does not exist/);
    const archived = await playbook({ name: "Old cut", status: "archived" });
    await expect(
      resolveStageUses({
        stages: [step("x", { playbookId: archived })],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/is archived/);
  });

  it("answers a playbook the author cannot see like one that does not exist", async () => {
    const theirs = await playbook({ name: "Someone else's mix" });
    const { eq } = await import("drizzle-orm");
    await expect(
      resolveStageUses({
        stages: [step("mix", { playbookId: theirs })],
        selfId: null,
        workspaceId: WS,
        // The author's floor: only playbooks another person created.
        visibility: () => eq(schema.playbooks.createdBy, "someone-else"),
      })
    ).rejects.toThrow(/does not exist/);
    await expect(
      resolveStageUses({
        stages: [step("mix", { playbookId: theirs })],
        selfId: null,
        workspaceId: WS,
        visibility: () => eq(schema.playbooks.createdBy, USER),
      })
    ).resolves.toBeDefined();
  });

  it("uses a playbook of the same space or a pod-wide one, never another space's", async () => {
    const podWide = await playbook({ name: "Pod render", workspaceId: null });
    const elsewhere = await playbook({
      name: "Their render",
      workspaceId: OTHER_WS,
    });
    await expect(
      resolveStageUses({
        stages: [step("r", { playbookId: podWide })],
        selfId: null,
        workspaceId: WS,
      })
    ).resolves.toBeDefined();
    await expect(
      resolveStageUses({
        stages: [step("r", { playbookId: elsewhere })],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/another space/);
    // A pod-wide playbook runs in any space, so it may only use pod-wide ones.
    const local = await playbook({ name: "Local render" });
    await expect(
      resolveStageUses({
        stages: [step("r", { playbookId: local })],
        selfId: null,
        workspaceId: null,
      })
    ).rejects.toThrow(/pod-wide playbook runs in any space/);
  });

  it("refuses a version later than today's, and an earlier one the pod does not keep", async () => {
    const used = await playbook({ name: "Sound", version: 3 });
    await keepVersion(used, 2, { name: "Sound", stages: [], params: [] });
    await expect(
      resolveStageUses({
        stages: [step("s", { playbookId: used, version: 5 })],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/current version is 3/);
    await expect(
      resolveStageUses({
        stages: [step("s", { playbookId: used, version: 1 })],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/does not keep\. Pin one of: 2, 3\./);
    const kept = await resolveStageUses({
      stages: [step("s", { playbookId: used, version: 2 })],
      selfId: null,
      workspaceId: WS,
    });
    expect(kept![0]!.uses!.version).toBe(2);
  });

  it("checks `with` against the params of the PINNED version, not today's", async () => {
    const used = await playbook({
      name: "Export",
      version: 2,
      params: [{ name: "format", type: "text" }],
    });
    await keepVersion(used, 1, {
      name: "Export",
      stages: [],
      params: [{ name: "codec", type: "text" }],
    });
    await expect(
      resolveStageUses({
        stages: [
          step("e", { playbookId: used, version: 1, with: { format: "fmt" } }),
        ],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/declares no such param\. Its params: codec\./);
    await expect(
      resolveStageUses({
        stages: [
          step("e", { playbookId: used, version: 2, with: { format: "fmt" } }),
        ],
        selfId: null,
        workspaceId: WS,
      })
    ).resolves.toBeDefined();
  });

  it("refuses a step that runs its own playbook, and a chain that comes back to it", async () => {
    const self = await playbook({ name: "Make a reel" });
    await expect(
      resolveStageUses({
        stages: [step("loop", { playbookId: self })],
        selfId: self,
        workspaceId: WS,
      })
    ).rejects.toThrow(/its own playbook/);
    // B already uses A (self); A now wants to use B.
    const b = await playbook({
      name: "Shared step",
      stages: [step("back", { playbookId: self, version: 1 })],
    });
    await expect(
      resolveStageUses({
        stages: [step("b", { playbookId: b })],
        selfId: self,
        workspaceId: WS,
      })
    ).rejects.toThrow(/makes a loop/);
  });

  it("refuses a chain of steps-that-are-playbooks deeper than 3", async () => {
    const d4 = await playbook({ name: "D4" });
    const d3 = await playbook({
      name: "D3",
      stages: [step("s", { playbookId: d4, version: 1 })],
    });
    const d2 = await playbook({
      name: "D2",
      stages: [step("s", { playbookId: d3, version: 1 })],
    });
    const d1 = await playbook({
      name: "D1",
      stages: [step("s", { playbookId: d2, version: 1 })],
    });
    // top → d2 → d3 → d4: three hops, the most allowed.
    await expect(
      resolveStageUses({
        stages: [step("s", { playbookId: d2 })],
        selfId: null,
        workspaceId: WS,
      })
    ).resolves.toBeDefined();
    // top → d1 → d2 → d3 → d4: four hops, refused.
    await expect(
      resolveStageUses({
        stages: [step("s", { playbookId: d1 })],
        selfId: null,
        workspaceId: WS,
      })
    ).rejects.toThrow(/too deep/);
  });
});

describe("playbook_versions — every kept version, read back", () => {
  it("keeps the definition fields, idempotently, and reads a kept version", async () => {
    const id = await playbook({
      name: "Kept",
      params: [{ name: "topic", type: "text" }],
    });
    const kept = await loadPlaybookVersion(db(), id, 1);
    expect(kept).not.toBeNull();
    expect(Object.keys(kept!).sort()).toEqual(
      [...PLAYBOOK_VERSION_FIELDS].sort()
    );
    expect(kept!.name).toBe("Kept");
    expect(kept!.params).toEqual([{ name: "topic", type: "text" }]);
    // A version, once kept, never changes: a second write is a no-op.
    const [row] = await (h.db as any)
      .select()
      .from(schema.playbooks)
      .where((await import("@synap/database")).eq(schema.playbooks.id, id));
    await recordPlaybookVersion(db(), { ...row, name: "Renamed" }, USER);
    expect((await loadPlaybookVersion(db(), id, 1))!.name).toBe("Kept");
    expect(await loadPlaybookVersion(db(), id, 9)).toBeNull();
  });
});
