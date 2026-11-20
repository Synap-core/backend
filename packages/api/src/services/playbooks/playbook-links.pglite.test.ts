/**
 * Playbook links against real SQL (PGlite, every table): which playbook a
 * declared link names, and the write-time loop guard.
 *
 * Rows rule out:
 *  - a link resolved into ANOTHER space, to an archived playbook, from a
 *    pod-wide playbook into a space, or (two of one name) to the newer one;
 *  - a loop let through because "self" was only recognised among stored
 *    rows: creating B after A while A already follows the name "B" (also how
 *    an install of two playbooks that follow each other lands), renaming to
 *    a name another playbook follows, unarchiving a playbook in a loop;
 *  - a loop that mixes a link and a step that `uses` a playbook;
 *  - a legitimate chain longer than 3 reported as a loop.
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
import type { PlaybookActivator } from "@synap/playbooks";
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

const after = (...refs: string[]): PlaybookActivator[] =>
  refs.map((p) => ({ on: "run_ended", playbook: p, mode: "propose" }));

let clock = 0;
/** A playbook following `after` (names or ids); `uses` = playbooks its steps use. */
async function playbook(o: {
  name: string;
  workspaceId: string | null;
  after?: string[];
  uses?: string[];
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status, subject_profile, stages, created_at)
     values ($1,$2,'user-1',$3,'g',$4,$5::jsonb,$6::jsonb, timestamp '2026-01-01' + ($7::text || ' minutes')::interval)`,
    [
      id,
      o.workspaceId,
      o.name,
      o.status ?? "active",
      JSON.stringify({
        profileSlug: "devplane_feature",
        activators: after(...(o.after ?? [])),
      }),
      JSON.stringify(
        (o.uses ?? []).map((u, i) => ({
          key: `s${i}`,
          name: `S${i}`,
          uses: { playbookId: u, version: 1 },
        }))
      ),
      String(++clock),
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
  // Two pod-wide playbooks of one name (rows from before the name index).
  ids.twinOld = await playbook({ name: "Twin", workspaceId: null });
  ids.twinNew = await playbook({ name: "Twin", workspaceId: null });
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
  it("a name (any case) → the space's own before a pod-wide one; an id → itself; two of one name → the older", async () => {
    const r = await resolveLinkedPlaybooks(
      ["SHIP A CHANGE", ids.announce!, "twin"],
      WS
    );
    expect(r.get("SHIP A CHANGE")?.id).toBe(ids.ship);
    expect(r.get(ids.announce!)?.name).toBe("Announce");
    expect(r.get("twin")?.id).toBe(ids.twinOld);
  });

  it("never resolves into another space, an archived playbook, or (from a pod-wide one) a space", async () => {
    const r = await resolveLinkedPlaybooks(
      [ids.other!, "Old announce", "Announce"],
      WS2
    );
    expect(r.get("Announce")?.id).toBe(ids.other);
    expect(r.has("Old announce")).toBe(false);
    expect((await resolveLinkedPlaybooks([ids.other!], WS)).size).toBe(0);
    const podWide = await resolveLinkedPlaybooks(
      ["Ship a change", "Announce"],
      null
    );
    expect(podWide.get("Ship a change")?.id).toBe(ids.shipPod);
    expect(podWide.has("Announce")).toBe(false);
  });

  it("resolves a playbook of another space once it is shared with this one", async () => {
    const shared = await playbook({ name: "Shared report", workspaceId: WS2 });
    expect((await resolveLinkedPlaybooks(["shared report"], WS)).size).toBe(0);
    await h.client!.query(
      `insert into space_access (object_type, object_id, workspace_id) values ('playbook', $1, $2)`,
      [shared, WS]
    );
    const r = await resolveLinkedPlaybooks(["shared report", shared], WS);
    expect(r.get("shared report")?.id).toBe(shared);
    expect(r.get(shared)?.id).toBe(shared);
    // A grant is per space: a pod-wide playbook still reaches no space's.
    expect((await resolveLinkedPlaybooks([shared], null)).size).toBe(0);
  });
});

describe("findPlaybookLinkCycle — the write-time loop guard", () => {
  it("an update closing a chain back to itself, named in the person's words", async () => {
    const cycle = await findPlaybookLinkCycle({
      id: ids.ship!,
      name: "Ship a change",
      workspaceId: WS,
      activators: after("Recap"),
      stages: [],
    });
    expect(cycle).toEqual([
      "Ship a change",
      "Announce",
      "Recap",
      "Ship a change",
    ]);
    expect(playbookLinkCycleMessage(cycle!)).toContain(
      "Ship a change → Announce → Recap → Ship a change"
    );
  });

  it("a create (or the second of an install) whose name another playbook already follows", async () => {
    // "Alpha" follows "Beta", which does not exist yet.
    await playbook({ name: "Alpha", workspaceId: WS, after: ["Beta"] });
    expect(
      await findPlaybookLinkCycle({
        id: null,
        name: "beta",
        workspaceId: WS,
        activators: after("Alpha"),
        stages: [],
      })
    ).toEqual(["beta", "Alpha", "beta"]);
  });

  it("a rename to a name another playbook follows", async () => {
    // "Gamma" follows "Delta" (none yet); "Epsilon" follows "Gamma".
    await playbook({ name: "Gamma", workspaceId: WS, after: ["Delta"] });
    const epsilon = await playbook({
      name: "Epsilon",
      workspaceId: WS,
      after: ["Gamma"],
    });
    const as = (name: string) =>
      findPlaybookLinkCycle({
        id: epsilon,
        name,
        workspaceId: WS,
        activators: after("Gamma"),
        stages: [],
      });
    expect(await as("Epsilon")).toBeNull();
    expect(await as("Delta")).toEqual(["Delta", "Gamma", "Delta"]);
  });

  it("an archived playbook coming back into a loop", async () => {
    // Archived "Zeta" follows "Eta"; active "Eta" follows "Zeta".
    const zeta = await playbook({
      name: "Zeta",
      workspaceId: WS,
      after: ["Eta"],
      status: "archived",
    });
    await playbook({ name: "Eta", workspaceId: WS, after: ["Zeta"] });
    expect(
      await findPlaybookLinkCycle({
        id: zeta,
        name: "Zeta",
        workspaceId: WS,
        activators: after("Eta"),
        stages: [],
      })
    ).toEqual(["Zeta", "Eta", "Zeta"]);
  });

  it("a loop mixing a step that uses a playbook and a link", async () => {
    // Kappa's step uses Lambda; Kappa starts when a run of Lambda ends.
    const lambda = await playbook({ name: "Lambda", workspaceId: WS });
    const self = {
      id: null,
      name: "Kappa",
      workspaceId: WS,
      activators: after("Lambda"),
    };
    expect(
      await findPlaybookLinkCycle({
        ...self,
        stages: [{ key: "s", uses: { playbookId: lambda, version: 1 } }],
      })
    ).toEqual(["Kappa", "Lambda", "Kappa"]);
    // The link alone, or the step alone, is no loop.
    expect(await findPlaybookLinkCycle({ ...self, stages: [] })).toBeNull();
  });

  it("a legitimate chain longer than 3 is no loop", async () => {
    let prev = await playbook({ name: "C1", workspaceId: WS });
    for (const n of ["C2", "C3", "C4", "C5"])
      prev = await playbook({ name: n, workspaceId: WS, after: [prev] });
    expect(
      await findPlaybookLinkCycle({
        id: null,
        name: "C6",
        workspaceId: WS,
        activators: after("C5"),
        stages: [],
      })
    ).toBeNull();
    // A link into another space names nothing there: no loop.
    expect(
      await findPlaybookLinkCycle({
        id: ids.other!,
        name: "Announce",
        workspaceId: WS2,
        activators: after(ids.recap!),
        stages: [],
      })
    ).toBeNull();
  });
});
