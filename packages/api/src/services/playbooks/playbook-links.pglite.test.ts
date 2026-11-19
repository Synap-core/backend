/**
 * Playbook links (W8a) against real SQL (PGlite, every table): which playbook
 * a declared link names, and the write-time loop guard.
 *
 * Rows rule out:
 *  - a link resolved to a playbook of ANOTHER space, or to an archived one;
 *  - a name that matches a pod-wide playbook AND the space's own resolving
 *    to the pod-wide one;
 *  - a pod-wide playbook resolving a link into a space;
 *  - a loop of links (two playbooks, three, a playbook following itself)
 *    let through, by id or by name (a create has no id yet);
 *  - a chain that does not come back reported as a loop.
 *
 * Cannot see: the router doors that call the guard (a 5-line call each), the
 * rule the link compiles to (`playbook-activators.test.ts`).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  findPlaybookLinkCycle,
  playbookLinkCycleMessage,
  resolveLinkedPlaybooks,
} from "./playbook-links.js";

const WS = "55555555-5555-4555-8555-555555555555";
const WS2 = "66666666-6666-4666-8666-666666666666";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}

/** A playbook whose activators follow `after` (names or ids), one link each. */
async function playbook(o: {
  name: string;
  workspaceId: string | null;
  after?: string[];
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status, subject_profile)
     values ($1,$2,'user-1',$3,'g',$4,$5::jsonb)`,
    [
      id,
      o.workspaceId,
      o.name,
      o.status ?? "active",
      JSON.stringify({
        profileSlug: "devplane_feature",
        activators: (o.after ?? []).map((p) => ({
          on: "run_ended",
          playbook: p,
          mode: "propose",
        })),
      }),
    ]
  );
  return id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  ids.ship = await playbook({ name: "Ship a change", workspaceId: WS });
  ids.shipPod = await playbook({ name: "Ship a change", workspaceId: null });
  ids.other = await playbook({ name: "Announce", workspaceId: WS2 });
  ids.archived = await playbook({
    name: "Old announce",
    workspaceId: WS,
    status: "archived",
  });
  // A chain in WS: Announce follows Ship; Recap follows Announce.
  ids.announce = await playbook({
    name: "Announce",
    workspaceId: WS,
    after: ["ship a change"],
  });
  ids.recap = await playbook({
    name: "Recap",
    workspaceId: WS,
    after: [ids.announce!],
  });
});

describe("resolveLinkedPlaybooks — the playbook a link names", () => {
  it("resolves a name (any case) to the space's own playbook before a pod-wide one, and an id as itself", async () => {
    const r = await resolveLinkedPlaybooks(
      ["SHIP A CHANGE", ids.announce!],
      WS
    );
    expect(r.get("SHIP A CHANGE")?.id).toBe(ids.ship);
    expect(r.get(ids.announce!)?.name).toBe("Announce");
  });

  it("never resolves into another space, an archived playbook, or (from a pod-wide one) a space", async () => {
    const r = await resolveLinkedPlaybooks(
      [ids.other!, "Old announce", "Announce"],
      WS2
    );
    // WS2 sees its own Announce, not WS's; the WS-archived one not at all.
    expect(r.get("Announce")?.id).toBe(ids.other);
    expect(r.has("Old announce")).toBe(false);
    const fromWs = await resolveLinkedPlaybooks([ids.other!], WS);
    expect(fromWs.size).toBe(0);
    const podWide = await resolveLinkedPlaybooks(
      ["Ship a change", "Announce"],
      null
    );
    expect(podWide.get("Ship a change")?.id).toBe(ids.shipPod);
    expect(podWide.has("Announce")).toBe(false);
  });
});

describe("findPlaybookLinkCycle — the write-time loop guard", () => {
  it("refuses a link back to the start of a chain (by id: an update)", async () => {
    // Ship ← Announce ← Recap; Ship following Recap closes the loop.
    const cycle = await findPlaybookLinkCycle({
      id: ids.ship!,
      name: "Ship a change",
      workspaceId: WS,
      activators: [{ on: "run_ended", playbook: "Recap", mode: "propose" }],
    });
    expect(cycle).toEqual([
      "Ship a change",
      "Recap",
      "Announce",
      "Ship a change",
    ]);
    expect(playbookLinkCycleMessage(cycle!)).toContain(
      "Ship a change starts after Recap starts after Announce starts after Ship a change"
    );
  });

  it("refuses it by name too (a create has no id yet), and a playbook following itself", async () => {
    expect(
      await findPlaybookLinkCycle({
        id: null,
        name: "ship a change",
        workspaceId: WS,
        activators: [{ on: "run_ended", playbook: "Announce", mode: "run" }],
      })
    ).toEqual(["ship a change", "Announce", "ship a change"]);
    expect(
      await findPlaybookLinkCycle({
        id: ids.recap!,
        name: "Recap",
        workspaceId: WS,
        activators: [{ on: "run_ended", playbook: "Recap", mode: "run" }],
      })
    ).toEqual(["Recap", "Recap"]);
  });

  it("lets a chain that does not come back through", async () => {
    expect(
      await findPlaybookLinkCycle({
        id: null,
        name: "Newsletter",
        workspaceId: WS,
        activators: [{ on: "run_ended", playbook: "Recap", mode: "propose" }],
      })
    ).toBeNull();
    // A link into another space names nothing there: no loop.
    expect(
      await findPlaybookLinkCycle({
        id: ids.other!,
        name: "Announce",
        workspaceId: WS2,
        activators: [
          { on: "run_ended", playbook: ids.recap!, mode: "propose" },
        ],
      })
    ).toBeNull();
  });
});
