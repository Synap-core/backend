/**
 * `resolveViewTrust` on PGlite, with real `views` and `widget_definitions`
 * rows (Surfaces P0-fix, finding d3f3e0df).
 *
 * The discriminating row is the first: a `generated` cell drawing a view the
 * acting person owns. The old rule (view ownership first) trusted it, so the
 * cell's writes skipped the propose gate; the cell's trust now bounds the
 * write. The others pin what must not change.
 *
 * Does NOT cover: the doors that pass the issuer to the gate (`entities.create`
 * / `update` / `delete`, `relations.create`); those are
 * `view-trust.delete-and-relation.test.ts` and the gate's own tests.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { views, widgetDefinitions } from "@synap/database/schema";
import { pgliteTableDdl } from "../__tests__/pglite-ddl.js";
import { resolveViewTrust } from "./view-trust-service.js";

const OWNER = randomUUID();
const OTHER = randomUUID();
const WS = randomUUID();
const OWN_VIEW = randomUUID();
const OTHERS_VIEW = randomUUID();

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteTableDdl(views));
  await h.client!.exec(pgliteTableDdl(widgetDefinitions));
  await q(
    `insert into views (id, user_id, workspace_id, name, type) values ($1, $2, $3, 'mine', 'kanban'), ($4, $5, $3, 'theirs', 'kanban')`,
    [OWN_VIEW, OWNER, WS, OTHERS_VIEW, OTHER]
  );
  await q(
    `insert into widget_definitions (type_key, workspace_id, name, renderer_type, trust_level) values
       ('generated:board', $1, 'board', 'frame', 'generated'),
       ('cell:pkg:board', $1, 'board', 'frame', 'installed'),
       ('trusted-board', null, 'board', 'frame', 'trusted')`,
    [WS]
  );
}, 60_000);

const trusted = (
  identity: { viewId?: string; typeKey?: string },
  userId = OWNER
) => resolveViewTrust(identity, userId, WS).then((t) => t.trusted);

describe("resolveViewTrust: the cell drawing the frame bounds the write", () => {
  it("a generated cell on the person's OWN view: untrusted (proposes)", async () => {
    expect(
      await trusted({ viewId: OWN_VIEW, typeKey: "generated:board" })
    ).toBe(false);
  });

  it("an installed (not trusted) cell on the person's own view: untrusted", async () => {
    expect(await trusted({ viewId: OWN_VIEW, typeKey: "cell:pkg:board" })).toBe(
      false
    );
  });

  it("a cell type with no row on the person's own view: untrusted", async () => {
    expect(await trusted({ viewId: OWN_VIEW, typeKey: "no-such-cell" })).toBe(
      false
    );
  });

  it("a trusted cell on the person's own view: trusted", async () => {
    expect(await trusted({ viewId: OWN_VIEW, typeKey: "trusted-board" })).toBe(
      true
    );
  });

  it("the person's own view, no cell named: trusted (unchanged)", async () => {
    expect(await trusted({ viewId: OWN_VIEW })).toBe(true);
  });

  it("someone else's view, no cell named: untrusted (unchanged)", async () => {
    expect(await trusted({ viewId: OTHERS_VIEW })).toBe(false);
  });

  it("a trusted cell on someone else's view: trusted (unchanged)", async () => {
    expect(
      await trusted({ viewId: OTHERS_VIEW, typeKey: "trusted-board" })
    ).toBe(true);
  });
});
