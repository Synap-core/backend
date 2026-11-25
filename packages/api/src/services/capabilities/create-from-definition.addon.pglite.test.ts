/**
 * Tool ADD-ONS through the real applier (founder decision D6, document
 * b387ca45 §6; design ac700298).
 *
 * An add-on definition (`extends: "apify"`) installs as its OWN container that
 * runs through its base's tool rows:
 *   - refused, with nothing written, until its base is installed in a scope
 *     that covers it, and when it declares a tool of its own;
 *   - its skills `require` the BASE's tool (no tool of its own is created), so
 *     switching the base's access off stops them;
 *   - a skill it reuses by name that is a member of the base is MOVED to the
 *     add-on: same row, same id, same action id (run receipts, stored flows
 *     and the Library's "Read by Apify" mark key on it);
 *   - `capability --extends--> capability` is written once;
 *   - a space-scoped add-on on a pod-wide base works the same way.
 *
 * Driven through the real `createCapabilityFromDefinition`, the real
 * `skillsRouter` and the real `capabilityContainersRouter` against PGlite
 * tables generated from the Drizzle schema, asserting ROWS. The links service
 * (used by `setRequiredTools`) is an in-memory edge store, so the `requires`
 * edges are asserted there; `member_of` and `extends` are real `links` rows.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

type Edge = {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: string;
  workspaceId: string | null;
};

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  edges: [] as Edge[],
  nextEdge: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async (rows: Omit<Edge, "id">[]) => {
    for (const r of rows) h.edges.push({ ...r, id: `edge-${++h.nextEdge}` });
    return [];
  }),
  getLinksFor: vi.fn(async (_userId: string, type: string, id: string) =>
    h.edges.filter(
      (e) =>
        (e.fromType === type && e.fromId === id) ||
        (e.toType === type && e.toId === id)
    )
  ),
  deleteLink: vi.fn(async (id: string) => {
    h.edges = h.edges.filter((e) => e.id !== id);
  }),
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk =
      c.primary && type === "uuid"
        ? " primary key default gen_random_uuid()"
        : c.primary
          ? " primary key"
          : "";
    const def =
      c.name === "approved"
        ? " default false"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "metadata"
            ? " default '{}'"
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const UID = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const CTX = { userId: UID, workspaceId: WS, authenticated: true } as never;

const skill = (
  name: string,
  scope: "pod" | "workspace" = "pod",
  requires = ["apify_api"]
) => ({
  name,
  kind: "code",
  scope,
  description: `${name} action`,
  code: `return "${name}";`,
  requires,
});

/** Apify as pods have it today: the capture verb is still the base's. */
const APIFY_TODAY = {
  key: "apify",
  name: "Apify",
  vault: [],
  tools: [{ name: "apify_api", kind: "api" }],
  skills: [skill("apify_search_actors"), skill("capture_social_post")],
};
/** Apify once the capture verb moved to its add-on. */
const APIFY_NEXT = {
  ...APIFY_TODAY,
  skills: [skill("apify_search_actors")],
};
const SOCIAL_POST_CAPTURE = {
  key: "apify-social-post-capture",
  name: "Social post capture",
  extends: "apify",
  vault: [],
  tools: [],
  skills: [skill("capture_social_post")],
};
const LINKEDIN_PROFILES = {
  key: "apify-linkedin-profiles",
  name: "LinkedIn profiles",
  extends: "apify",
  vault: [],
  tools: [],
  skills: [skill("apify_linkedin_profile")],
};
/** A space-scoped add-on on the pod-wide base (D4: space now). */
const SPACE_ADDON = {
  key: "apify-space-addon",
  name: "Space add-on",
  extends: "apify",
  vault: [],
  tools: [],
  skills: [skill("space_scrape", "workspace")],
};

const install = (def: unknown) =>
  createCapabilityFromDefinition(def as never, {}, CTX);

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await h.client!.query<T>(sql, params)).rows;
const containerByKey = async (key: string) =>
  (
    await rows<{ id: string; workspace_id: string | null }>(
      `select id, workspace_id from capabilities where template_key = $1`,
      [key]
    )
  )[0];
const skillId = async (name: string) =>
  (
    await rows<{ id: string }>(`select id from skills where name = $1`, [name])
  ).map((r) => r.id);
const membersOf = async (capabilityId: string, fromType: string) =>
  (
    await rows<{ from_id: string }>(
      `select from_id from links where to_type = 'capability' and to_id = $1
         and link_type = 'member_of' and from_type = $2`,
      [capabilityId, fromType]
    )
  ).map((r) => r.from_id);
const extendsEdges = async () =>
  rows<{ from_id: string; to_id: string; workspace_id: string | null }>(
    `select from_id, to_id, workspace_id from links where link_type = 'extends'`
  );
const requiredToolIds = (skillRowId: string) =>
  h.edges
    .filter(
      (e) =>
        e.fromType === "skill" &&
        e.fromId === skillRowId &&
        e.linkType === "requires" &&
        e.toType === "tool"
    )
    .map((e) => e.toId);

beforeAll(async () => {
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(v));
  }
  expect(seen.has("links")).toBe(true);
  // The edge doors upsert on THE unique edge (`idx_links_unique_edge`).
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await h.client!.query(`insert into users (id) values ($1)`, [UID]);
  await h.client!.query(
    `insert into workspaces (id, name, system_slug) values ($1, 'WS', null)`,
    [WS]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, UID]
  );
}, 120_000);

describe("an add-on whose base is not installed", () => {
  it("is refused, and nothing is written", async () => {
    await expect(install(SOCIAL_POST_CAPTURE)).rejects.toThrow(
      /add-on of "apify".*Install apify/
    );
    expect(await rows(`select id from capabilities`)).toEqual([]);
    expect(await rows(`select id from skills`)).toEqual([]);
    expect(await extendsEdges()).toEqual([]);
  });
});

describe("an add-on on an installed base", () => {
  let baseId = "";
  let baseToolId = "";
  let captureId = "";

  beforeAll(async () => {
    await install(APIFY_TODAY);
    baseId = (await containerByKey("apify"))!.id;
    [baseToolId] = await membersOf(baseId, "tool");
    [captureId] = await skillId("capture_social_post");
  });

  it("declaring a tool of its own is refused", async () => {
    // Its own key and action, so a refusal that fails to happen cannot hand
    // a later test a tool or a skill it should have made itself.
    await expect(
      install({
        key: "apify-own-tool",
        name: "Own tool",
        extends: "apify",
        vault: [],
        tools: [{ name: "own_tool_api", kind: "api" }],
        skills: [skill("own_tool_action", "pod", ["own_tool_api"])],
      })
    ).rejects.toThrow(/declares no tool or credential of its own/);
    expect(await containerByKey("apify-own-tool")).toBeUndefined();
    expect(await skillId("own_tool_action")).toEqual([]);
  });

  it("installs as its own container and records which tool it extends", async () => {
    const result = await install(SOCIAL_POST_CAPTURE);
    const addOn = (await containerByKey("apify-social-post-capture"))!;
    expect(addOn.id).not.toBe(baseId);
    expect(result.created.container?.addOnOf).toEqual({
      id: baseId,
      name: "Apify",
      partsNotMoved: 0,
    });
    expect(await extendsEdges()).toEqual([
      { from_id: addOn.id, to_id: baseId, workspace_id: null },
    ]);
  });

  it("MOVES the base's action: same row, member of the add-on only", async () => {
    const addOn = (await containerByKey("apify-social-post-capture"))!;
    // One row, the one the base made: its id (and its name, the action id)
    // did not change.
    expect(await skillId("capture_social_post")).toEqual([captureId]);
    expect(await membersOf(addOn.id, "skill")).toEqual([captureId]);
    expect(await membersOf(baseId, "skill")).not.toContain(captureId);
  });

  it("owns no tool: its action requires the BASE's tool row", async () => {
    const addOn = (await containerByKey("apify-social-post-capture"))!;
    expect(await membersOf(addOn.id, "tool")).toEqual([]);
    expect(
      await rows(`select id from tools where name = 'apify_api'`)
    ).toHaveLength(1);
    expect(requiredToolIds(captureId)).toEqual([baseToolId]);
  });

  it("a new add-on action requires the base's tool and is listed on it", async () => {
    await install(LINKEDIN_PROFILES);
    const [linkedinId] = await skillId("apify_linkedin_profile");
    expect(requiredToolIds(linkedinId!)).toEqual([baseToolId]);
    const [tool] = await rows<{ capabilities: Array<{ id: string }> }>(
      `select capabilities from tools where id = $1`,
      [baseToolId]
    );
    expect(tool!.capabilities.map((v) => v.id)).toContain(
      "apify_linkedin_profile"
    );
  });

  it("re-applying the base and the add-on moves nothing back and adds no twin", async () => {
    await install(APIFY_NEXT);
    await install(SOCIAL_POST_CAPTURE);
    const addOn = (await containerByKey("apify-social-post-capture"))!;
    expect(await membersOf(baseId, "skill")).not.toContain(captureId);
    expect(await membersOf(addOn.id, "skill")).toEqual([captureId]);
    expect(await skillId("capture_social_post")).toEqual([captureId]);
    expect(
      (await extendsEdges()).filter((e) => e.from_id === addOn.id)
    ).toHaveLength(1);
  });

  it("a space-scoped add-on installs in the space, on the pod-wide base", async () => {
    await install(SPACE_ADDON);
    const addOn = (await containerByKey("apify-space-addon"))!;
    expect(addOn.workspace_id).toBe(WS);
    expect(
      (await extendsEdges()).filter((e) => e.from_id === addOn.id)
    ).toEqual([{ from_id: addOn.id, to_id: baseId, workspace_id: WS }]);
    const [spaceSkill] = await skillId("space_scrape");
    expect(requiredToolIds(spaceSkill!)).toEqual([baseToolId]);
  });
});

describe("a base installed in one space only", () => {
  const SPACE_BASE = {
    key: "space-base",
    name: "Space base",
    vault: [],
    tools: [{ name: "space_base_api", kind: "api" }],
    skills: [skill("space_base_read", "workspace", ["space_base_api"])],
  };

  it("covers an add-on in that space, not one for the whole pod", async () => {
    await install(SPACE_BASE);
    expect((await containerByKey("space-base"))!.workspace_id).toBe(WS);
    await expect(
      install({
        key: "space-base-pod-addon",
        name: "Pod add-on",
        extends: "space-base",
        vault: [],
        tools: [],
        skills: [skill("pod_wide_extra", "pod", ["space_base_api"])],
      })
    ).rejects.toThrow(/Install space-base for the whole pod first/);
    await install({
      key: "space-base-addon",
      name: "Space base add-on",
      extends: "space-base",
      vault: [],
      tools: [],
      skills: [skill("space_extra", "workspace", ["space_base_api"])],
    });
    expect((await containerByKey("space-base-addon"))!.workspace_id).toBe(WS);
  });
});
