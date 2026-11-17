/**
 * TRIPWIRE — ONE LINK PER RELATION for a playbook's automations (0425, Process
 * wave plan 0adf8352, W2).
 *
 * The relation had three stored carriers (`playbooks.flow_automation_id`, the
 * `playbook_automations` join table, the legacy `automation --member_of-->
 * playbook` link) and readers that each read a different subset, so "this
 * process's automations" had several answers. Now the join table is the ONE
 * store. This holds it:
 *
 *  1. NO backend source READS `flowAutomationId` / `flow_automation_id`. It is
 *     still WRITTEN for one release (the old browser reads it), only by
 *     `services/playbooks/playbook-automation-links.ts`. The scan covers every
 *     non-test `.ts` of packages/api/src and packages/jobs/src (DERIVED by a
 *     walk, so a new file joins it by existing); the schema declaration and the
 *     boot coherence check live in packages/database and are not scanned.
 *  2. A link write of the legacy shape lands as the join row and writes NO
 *     `links` row (behavioural: the real `createLinks` / `createLink` over a
 *     recording db).
 *
 * NOT COVERED: a raw SQL string naming the column outside the scanned
 * packages, and a reader of the legacy `member_of` rows written as a links
 * query (none exists at 0425; the trigger matcher's fallback was removed).
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const recorded = vi.hoisted(() => ({
  tables: [] as string[],
  values: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const db = {
    insert: (table: Parameters<typeof getTableConfig>[0]) => {
      recorded.tables.push(getTableConfig(table).name);
      const chain = {
        values: (v: unknown) => {
          recorded.values.push(v);
          return chain;
        },
        onConflictDoNothing: () => chain,
        returning: () => Promise.resolve([]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
  };
  return { ...actual, getDb: async () => db };
});

const { createLinks, createLink } =
  await import("../services/links/links-service.js");

const API_SRC = join(__dirname, "..");
const JOBS_SRC = join(__dirname, "../../../jobs/src");
const WRITER = "services/playbooks/playbook-automation-links.ts";
const COLUMN = /\bflowAutomationId\b|\bflow_automation_id\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(name) &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      out.push(p);
  }
  return out;
}

/** Comments may name the column (they explain the deprecation); code may not. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("tripwire: one link per playbook → automation relation", () => {
  it("self-check: the scan sees the column in code and not in comments", () => {
    expect(COLUMN.test(stripComments("x.flowAutomationId"))).toBe(true);
    expect(
      COLUMN.test(
        stripComments("// flowAutomationId\n/* flow_automation_id */")
      )
    ).toBe(false);
  });

  it("no backend source reads flowAutomationId; only the link module writes it", () => {
    const files = [...walk(API_SRC), ...walk(JOBS_SRC)];
    expect(files.length).toBeGreaterThan(500); // non-vacuity (0425: ~2,700)
    const hits = files
      .filter((f) => COLUMN.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(API_SRC, f));
    expect(hits).toEqual([WRITER]);
  });

  it("a legacy member_of link write lands as the join row, never as a links row", async () => {
    recorded.tables.length = 0;
    recorded.values.length = 0;
    const edge = {
      workspaceId: "ws-1",
      fromType: "automation" as const,
      fromId: "a-1",
      toType: "playbook" as const,
      toId: "p-1",
      linkType: "member_of" as const,
    };
    await createLinks([
      edge,
      { ...edge, toType: "capability" as const, toId: "c-1" },
    ]);
    expect(recorded.tables).toEqual(["playbook_automations", "links"]);
    expect(recorded.values[0]).toEqual({
      playbookId: "p-1",
      automationId: "a-1",
    });
    // The other edge still lands in links (only the playbook composition moved).
    expect(recorded.values[1]).toEqual([
      expect.objectContaining({ toType: "capability", toId: "c-1" }),
    ]);

    recorded.tables.length = 0;
    await expect(createLink(edge)).resolves.toBeUndefined();
    expect(recorded.tables).toEqual(["playbook_automations"]);
  });
});
