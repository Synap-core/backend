/**
 * Behavioral test for the automation + command reconcile steps added to
 * `reconcileWorkspaceFromDefinition` (Wave 1 of the report-automation one-door).
 *
 * This drives the REAL door with a definition carrying ONLY `flowAutomations`
 * and `commands` (no profiles/views/links), against a mocked `client-pg`. With
 * no profiles, every other door step is a pure no-op (the profile loop is empty
 * and `resolvePropertyTargetProfiles` early-returns before any DB access), so
 * the only DB writes this exercises are the two steps under test — we assert on
 * the exact rows the door would insert/update and on the returned report.
 *
 * Not a vacuous pass: the assertions read the CAPTURED write payloads, so if the
 * decision (create / overwrite-on-drift / skip) or the hash stamping regressed,
 * these fail.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createHash } from "crypto";
import type { FlowDefinition } from "../schema/automations.js";

// ── Mutable mock state (mirrors persist-assistant-reply.test.ts pattern) ──────
type Row = Record<string, unknown> | undefined;
let existingAutomation: Row = undefined;
let existingCommandTitles: string[] = [];
let existingRelationDefSlugs: string[] = [];
const captured: {
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} = { inserts: [], updates: [] };

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      workspaces: { findFirst: async () => ({ id: "ws-1", settings: {} }) },
      automations: { findFirst: async () => existingAutomation },
      intelligenceCommands: {
        findMany: async () => existingCommandTitles.map((title) => ({ title })),
      },
      // RelationDefRepository.list() → findMany; .create() → findFirst (dedup).
      relationDefs: {
        findMany: async () =>
          existingRelationDefSlugs.map((slug) => ({ slug })),
        findFirst: async () => undefined,
      },
      views: { findMany: async () => [] },
    },
    // `.values(v)` is awaited directly by the automations/commands steps AND
    // chained with `.returning()` by RelationDefRepository — support both: a
    // thenable that also carries a `.returning()` method.
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.inserts.push(v);
        const rows = [{ id: "new-id", ...v }];
        const p = Promise.resolve(rows) as Promise<unknown[]> & {
          returning: () => Promise<unknown[]>;
        };
        p.returning = async () => rows;
        return p;
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          captured.updates.push(v);
          const rows = [{ id: "upd-id", ...v }];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>;
          };
          p.returning = async () => rows;
          return p;
        },
      }),
    }),
  };
  return { getDb: async () => db, sql: {} };
});

const { reconcileWorkspaceFromDefinition } =
  await import("./reconcile-workspace-from-definition.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────
const FLOW: FlowDefinition = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "manual", label: "Start", config: {} },
    },
  ],
  edges: [],
};

const AUTO = {
  name: "Generate report",
  description: "The report automation",
  triggerType: "manual" as const,
  triggerConfig: {},
  flowDefinition: FLOW as unknown as {
    nodes: unknown[];
    edges: unknown[];
    precondition?: string;
  },
  status: "active" as const,
};

/** Recompute the door's seed hash for assertion coupling (this IS the contract). */
function seedHashOf(auto: typeof AUTO): string {
  const flowDefinition = auto.flowDefinition ?? { nodes: [], edges: [] };
  return createHash("sha256")
    .update(
      JSON.stringify({ flowDefinition, description: auto.description ?? null })
    )
    .digest("hex");
}

async function runWith(definition: Record<string, unknown>, dryRun = false) {
  return reconcileWorkspaceFromDefinition({
    workspaceId: "ws-1",
    userId: "user-1",
    definition,
    dryRun,
  });
}

beforeEach(() => {
  existingAutomation = undefined;
  existingCommandTitles = [];
  existingRelationDefSlugs = [];
  captured.inserts = [];
  captured.updates = [];
});

describe("reconcile: automations (version-aware)", () => {
  it("absent → creates the automation, stamping seedVersion = content hash", async () => {
    existingAutomation = undefined;
    const report = await runWith({ flowAutomations: [AUTO] });

    expect(report.automations.created).toEqual(["Generate report"]);
    expect(report.automations.updated).toEqual([]);
    expect(report.automations.skipped).toEqual([]);

    expect(captured.updates).toHaveLength(0);
    expect(captured.inserts).toHaveLength(1);
    const row = captured.inserts[0];
    expect(row.name).toBe("Generate report");
    expect(row.status).toBe("active");
    expect(row.flowDefinition).toEqual(FLOW);
    expect((row.metadata as { seedVersion: string }).seedVersion).toBe(
      seedHashOf(AUTO)
    );
  });

  it("stored hash differs → overwrites flow, merges metadata, bumps version", async () => {
    existingAutomation = {
      id: "auto-1",
      version: 3,
      // A pre-existing hash that will not match + sibling metadata that MUST survive.
      metadata: {
        seedVersion: "deadbeef",
        tags: ["keep-me"],
        createdVia: "template",
      },
    };
    const report = await runWith({ flowAutomations: [AUTO] });

    expect(report.automations.updated).toEqual(["Generate report"]);
    expect(report.automations.created).toEqual([]);
    expect(report.automations.skipped).toEqual([]);

    expect(captured.inserts).toHaveLength(0);
    expect(captured.updates).toHaveLength(1);
    const upd = captured.updates[0];
    expect(upd.flowDefinition).toEqual(FLOW);
    expect(upd.version).toBe(4); // (3 ?? 1) + 1
    const meta = upd.metadata as Record<string, unknown>;
    expect(meta.seedVersion).toBe(seedHashOf(AUTO));
    // Never clobber the rest of the metadata bag.
    expect(meta.tags).toEqual(["keep-me"]);
    expect(meta.createdVia).toBe("template");
  });

  it("MIGRATION: a legacy int seedVersion (5) differs from any hash → overwrites (self-heals the v5 freeze)", async () => {
    existingAutomation = {
      id: "auto-1",
      version: 1,
      metadata: { seedVersion: 5 }, // the frozen int, as shipped
    };
    const report = await runWith({ flowAutomations: [AUTO] });

    expect(report.automations.updated).toEqual(["Generate report"]);
    expect(captured.updates).toHaveLength(1);
    const upd = captured.updates[0];
    expect(upd.version).toBe(2); // (1 ?? 1) + 1
    expect((upd.metadata as { seedVersion: string }).seedVersion).toBe(
      seedHashOf(AUTO)
    );
    // The load-bearing assertion: 5 (number) is never equal to the hex hash.
    expect((upd.metadata as { seedVersion: unknown }).seedVersion).not.toBe(5);
  });

  it("stored hash equals → skips (no write)", async () => {
    existingAutomation = {
      id: "auto-1",
      version: 7,
      metadata: { seedVersion: seedHashOf(AUTO) },
    };
    const report = await runWith({ flowAutomations: [AUTO] });

    expect(report.automations.skipped).toEqual(["Generate report"]);
    expect(report.automations.created).toEqual([]);
    expect(report.automations.updated).toEqual([]);
    expect(captured.inserts).toHaveLength(0);
    expect(captured.updates).toHaveLength(0);
  });

  it("dryRun → reports the create decision but writes nothing", async () => {
    existingAutomation = undefined;
    const report = await runWith({ flowAutomations: [AUTO] }, true);
    expect(report.automations.created).toEqual(["Generate report"]);
    expect(captured.inserts).toHaveLength(0);
    expect(captured.updates).toHaveLength(0);
  });

  it("the seed hash changes when the flow (or description) changes", () => {
    const other = { ...AUTO, description: "a different description" };
    expect(seedHashOf(other)).not.toBe(seedHashOf(AUTO));
  });
});

describe("reconcile: commands (create-if-missing)", () => {
  const CMD = {
    title: "Summarize Selection",
    promptTemplate: "Summarize @{context:text}",
    derivedInputs: [],
    outputMode: "text",
    canCreateViews: false,
    permissionsProfile: "read_only",
  };

  it("title absent → creates the command", async () => {
    existingCommandTitles = [];
    const report = await runWith({ commands: [CMD] });

    expect(report.commands.created).toEqual(["Summarize Selection"]);
    expect(report.commands.skipped).toEqual([]);

    expect(captured.inserts).toHaveLength(1);
    const row = captured.inserts[0];
    expect(row.title).toBe("Summarize Selection");
    expect(row.promptTemplate).toBe("Summarize @{context:text}");
    expect(row.outputMode).toBe("text");
    expect(row.permissionsProfile).toBe("read_only");
    expect(row.sharedScope).toBe("workspace");
  });

  it("title present → skips (no write, user-owned after first seed)", async () => {
    existingCommandTitles = ["Summarize Selection"];
    const report = await runWith({ commands: [CMD] });

    expect(report.commands.skipped).toEqual(["Summarize Selection"]);
    expect(report.commands.created).toEqual([]);
    expect(captured.inserts).toHaveLength(0);
  });

  it("defaults outputMode/permissionsProfile when omitted", async () => {
    existingCommandTitles = [];
    const report = await runWith({
      commands: [{ title: "Bare", promptTemplate: "do it" }],
    });
    expect(report.commands.created).toEqual(["Bare"]);
    const row = captured.inserts[0];
    expect(row.outputMode).toBe("text");
    expect(row.permissionsProfile).toBe("propose_writes");
  });
});

describe("reconcile: relationDefs (create-if-missing, full metadata)", () => {
  const REL = {
    slug: "assigned_to",
    displayName: "Assigned To",
    description: "Person assigned to task/project",
    isDirectional: true,
    uiHints: { category: "workflow" as const },
  };

  it("slug absent → creates the relation def, preserving ALL metadata", async () => {
    existingRelationDefSlugs = [];
    const report = await runWith({ relationDefs: [REL] });

    expect(report.relationDefs.created).toEqual(["assigned_to"]);
    expect(report.relationDefs.skipped).toEqual([]);

    expect(captured.inserts).toHaveLength(1);
    const row = captured.inserts[0];
    expect(row.slug).toBe("assigned_to");
    expect(row.displayName).toBe("Assigned To");
    // The fields the entityLinks path drops — proven to survive here.
    expect(row.description).toBe("Person assigned to task/project");
    expect(row.isDirectional).toBe(true);
    expect(row.uiHints).toEqual({ category: "workflow" });
  });

  it("slug present (workspace or pod-wide) → skips (no write)", async () => {
    existingRelationDefSlugs = ["assigned_to"];
    const report = await runWith({ relationDefs: [REL] });

    expect(report.relationDefs.skipped).toEqual(["assigned_to"]);
    expect(report.relationDefs.created).toEqual([]);
    expect(captured.inserts).toHaveLength(0);
  });

  it("dryRun → reports the create decision but writes nothing", async () => {
    existingRelationDefSlugs = [];
    const report = await runWith({ relationDefs: [REL] }, true);
    expect(report.relationDefs.created).toEqual(["assigned_to"]);
    expect(captured.inserts).toHaveLength(0);
  });
});
