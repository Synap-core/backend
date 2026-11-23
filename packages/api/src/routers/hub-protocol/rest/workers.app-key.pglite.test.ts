/**
 * A pod app's "Runs on its own" (Content Studio, plan e51783ca J2-be): the
 * app reads a playbook's workers, pauses and resumes them, and runs one now,
 * with its own scoped key, through the REAL hub auth door (its W1 fence, the
 * app-token write baseline, `runWithGrant`), the REAL denial middleware, the
 * REAL `/workers` routes, worker doors and worker service, on PGlite.
 *
 * Before: `GET /workers` was undeclared in the fence (every scoped key got
 * 403 GRANT_DOOR_UNSUPPORTED), it listed only by goal, project or session (a
 * space-wide worker, Plan Next Content's, could not be listed at all), and
 * the pause and run routes sat in the unclassified write baseline, which
 * refuses every app token.
 *
 * Rows rule out:
 *   - `?playbookId=` refused (400) or ignored (another playbook's worker);
 *   - the app refused the workers of a playbook its grant reads;
 *   - the app reading a worker of a space it was not granted;
 *   - a key without `playbook.read` let through (403, never an empty list);
 *   - a key that reads the playbook but not its runs and approvals given the
 *     worker anyway, or an empty list that hides it (it is `withheld`);
 *   - an app's pause or resume refused when its grant holds `playbook.update`
 *     in the worker's space, or applied when it holds neither that nor
 *     `rule.update` (403 GRANT_DENIED, the worker still running);
 *   - an app's "run now" refused at the fence, or let past without
 *     `playbook.run`.
 *
 * Stubbed, each proven elsewhere: the key lookup (`getApiKeyStatus`; the
 * grant rows are real), the guest check, the activator pass after a pause.
 * The rule door (`updateRuleGoverned`) and the playbook run door are cut at
 * rung 0: each stub runs the REAL `grantWriteDenial` with exactly what the
 * real door hands `checkPermissionOrPropose` (the named permission
 * included), then records the write. What a person's role and the agent
 * ladder decide after rung 0 is the gate's own suite. Cannot see: production
 * Postgres, a real minted app token, the automation the pause archives.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
  /** Where each fixture playbook lives (what the run door resolves). */
  playbookSpace: new Map<string, string>(),
  runs: [] as Array<{ playbookId: string }>,
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
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));
vi.mock(
  "../../../services/playbooks/playbook-activators.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    applyPlaybookActivators: vi.fn(async () => ({
      status: "applied",
      outcomes: [],
    })),
  })
);
// The ONE rule door, cut at rung 0: the real grant check with what the real
// door passes `checkPermissionOrPropose` (`rule.update` in the rule's space,
// plus the caller's named permission), then the draft flag it writes.
vi.mock("../../../services/rules/update.js", async () => {
  const { grantWriteDenial } =
    await import("../../../utils/grant-write-check.js");
  return {
    updateRuleGoverned: async (input: {
      ruleId: string;
      workspaceId?: string | null;
      scope: { kind: string; workspaceId?: string | null };
      draft?: boolean;
      grantNamedPermission?: {
        subject: string;
        action: string;
        workspaceId: string | null;
      };
    }) => {
      const workspaceId =
        input.scope.kind === "workspace"
          ? (input.scope.workspaceId ?? input.workspaceId ?? null)
          : (input.workspaceId ?? null);
      const denied = await grantWriteDenial({
        subjectType: "rule",
        action: "update",
        workspaceId,
        ...(input.grantNamedPermission
          ? { namedPermission: input.grantNamedPermission }
          : {}),
      });
      if (denied) return { status: "denied", reason: denied };
      await h.client!.query(
        input.draft
          ? `update skills set metadata = jsonb_set(metadata, '{rule,draft}', 'true') where id = $1`
          : `update skills set metadata = metadata #- '{rule,draft}' where id = $1`,
        [input.ruleId]
      );
      return { status: "updated", ruleId: input.ruleId, automationIds: [] };
    },
  };
});
// The playbook run door, cut at rung 0: `playbooks.run` checks `playbook.run`
// in the run's space through `checkPermissionOrPropose`, and a refusal is a
// FORBIDDEN the route answers 403.
vi.mock("../playbook-doors.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  const { grantWriteDenial } =
    await import("../../../utils/grant-write-check.js");
  return {
    runPlaybookDoor: async (
      _identity: unknown,
      input: { playbookId: string }
    ) => {
      const denied = await grantWriteDenial({
        subjectType: "playbook",
        action: "run",
        workspaceId: h.playbookSpace.get(input.playbookId) ?? null,
      });
      if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
      h.runs.push({ playbookId: input.playbookId });
      return {
        kind: "result",
        result: { status: "started", sessionId: randomUUID() },
      };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { grantDenialCodeMiddleware } from "../_middleware/grant-denial-code.js";
import { registerWorkersRoutes } from "./workers.js";
import type { HubHono, HubVariables } from "./_shared.js";
import { activatorKey } from "../../../schemas/playbook-process.js";
import { activatorSeedTemplate } from "../../../services/playbooks/playbook-activators.js";

const OWNER = randomUUID();
/** Content OS: the space the app was given. */
const CS = randomUUID();
const OTHER = randomUUID();
const PB_CS = randomUUID();
const PB_CS_2 = randomUUID();
const PB_OTHER = randomUUID();
const RULE_CS = randomUUID();
const RULE_CS_2 = randomUUID();
const RULE_OTHER = randomUUID();
const MONDAY = { on: "schedule", cron: "0 9 * * 1", mode: "propose" } as const;

interface Key {
  id: string;
  keyType: string;
  permissions: string[];
  workspaceIds: string[] | null;
  clientId: string | null;
}
const APP = "content-studio";
const KEYS = {
  /** Content Studio as the person, pinned to Content OS. */
  app: {
    id: randomUUID(),
    keyType: "app_person",
    permissions: [
      "playbook.read",
      "playbook.update",
      "playbook.run",
      "automation.read",
      "proposal.read",
    ],
    workspaceIds: [CS],
    clientId: APP,
  },
  /** The same app before it asks for `automation.read`. */
  noRuns: {
    id: randomUUID(),
    keyType: "app_person",
    permissions: ["playbook.read", "proposal.read"],
    workspaceIds: [CS],
    clientId: APP,
  },
  /** Reads runs, never granted `playbook.read`. */
  noPlaybook: {
    id: randomUUID(),
    keyType: "app_person",
    permissions: ["automation.read", "proposal.read"],
    workspaceIds: [CS],
    clientId: APP,
  },
  /** Reads everything, but neither `playbook.update` nor `playbook.run`. */
  readOnly: {
    id: randomUUID(),
    keyType: "app_person",
    permissions: ["playbook.read", "automation.read", "proposal.read"],
    workspaceIds: [CS],
    clientId: APP,
  },
  /** The owner, unbounded. */
  full: {
    id: randomUUID(),
    keyType: "hub_inbound",
    permissions: ["*"],
    workspaceIds: null,
    clientId: null,
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function playbook(id: string, name: string, workspaceId: string) {
  h.playbookSpace.set(id, workspaceId);
  await q(
    `insert into playbooks (id, name, status, workspace_id, created_by, goal_template, subject_profile)
     values ($1,$2,'active',$3,$4,'g',$5::jsonb)`,
    [id, name, workspaceId, OWNER, JSON.stringify({ activators: [MONDAY] })]
  );
}

/** The space-wide worker the activator pass compiles for `pb` (its rule). */
async function spaceWorker(ruleId: string, pb: string, workspaceId: string) {
  await q(
    `insert into skills (id, user_id, workspace_id, name, category, metadata)
     values ($1,$2,$3,'Plan weekly','rule',$4::jsonb)`,
    [
      ruleId,
      OWNER,
      workspaceId,
      JSON.stringify({
        rule: {
          v: 1,
          intent: "Plan the week every Monday",
          scope: { kind: "workspace", workspaceId },
          seed: {
            template: activatorSeedTemplate(pb),
            key: activatorKey(MONDAY),
          },
          behaviours: [],
        },
      }),
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));

  await q(
    `insert into users (id, email, user_type, name) values ($1,$2,'human','Owner')`,
    [OWNER, "owner@example.test"]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [ws, name] of [
    [CS, "Content OS"],
    [OTHER, "Sales"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await playbook(PB_CS, "Plan Next Content", CS);
  await playbook(PB_CS_2, "Weekly build notes", CS);
  await playbook(PB_OTHER, "Pipeline review", OTHER);
  await spaceWorker(RULE_CS, PB_CS, CS);
  await spaceWorker(RULE_CS_2, PB_CS_2, CS);
  await spaceWorker(RULE_OTHER, PB_OTHER, OTHER);

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,null,true)`,
      [k.id, OWNER]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$3,$4::text[],$5::uuid[],$3,$6)`,
      [
        randomUUID(),
        k.id,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
        k.clientId,
      ]
    );
  }
}, 120_000);

beforeEach(async () => {
  h.runs.length = 0;
  // Every worker starts running.
  await q(`update skills set metadata = metadata #- '{rule,draft}'`);
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: OWNER,
        linkedUserId: null,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: key.keyType,
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", grantDenialCodeMiddleware as never);
  hub.use("/*", hubAuthMiddleware as never);
  registerWorkersRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}
const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
const post = (key: KeyName, path: string, body: unknown) =>
  app().request(`/api/hub${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer synap_${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

interface ListBody {
  items: Array<{ ruleId: string; playbookId: string; state: string }>;
  withheld?: { workers: number; needs: string[] };
}
async function list(key: KeyName, query: string): Promise<ListBody> {
  const res = await get(key, `/workers?${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ListBody;
}
/** A worker's state, read with the person's full key. */
async function stateOf(pb: string, ruleId: string): Promise<string> {
  const { items } = await list("full", `playbookId=${pb}`);
  return items.find((x) => x.ruleId === ruleId)!.state;
}

describe("GET /workers?playbookId= — a pod app reads a playbook's workers", () => {
  it("the app lists the space-wide worker of a Content OS playbook, and only that playbook's", async () => {
    const body = await list("app", `playbookId=${PB_CS}`);
    expect(body.items.map((w) => [w.ruleId, w.playbookId, w.state])).toEqual([
      [RULE_CS, PB_CS, "running"],
    ]);
    expect(body.withheld).toBeUndefined();
  });

  it("a playbook of a space it was not given lists nothing, and withholds nothing", async () => {
    // The playbook is outside its grant: no row of it is read at all.
    expect(await list("app", `playbookId=${PB_OTHER}`)).toEqual({ items: [] });
  });

  it("reading the playbook but not its runs: the worker is withheld and said, never an empty list alone", async () => {
    expect(await list("noRuns", `playbookId=${PB_CS}`)).toEqual({
      items: [],
      withheld: { workers: 1, needs: ["automation.read", "proposal.read"] },
    });
  });

  it("without playbook.read the door is refused (403), never an empty list", async () => {
    const res = await get("noPlaybook", `/workers?playbookId=${PB_CS}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "GRANT_DOOR_UNSUPPORTED"
    );
  });

  it("no filter at all is a 400 naming playbookId among the filters", async () => {
    const res = await get("app", "/workers");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /playbookId/
    );
  });

  it("CONTROL: the person's full key reads the other space's worker by its playbook", async () => {
    const body = await list("full", `playbookId=${PB_OTHER}`);
    expect(body.items.map((w) => w.ruleId)).toEqual([RULE_OTHER]);
  });
});

describe("POST /workers/:ruleId/paused — what an app's press answers", () => {
  it("with playbook.update in the worker's space, the app's pause APPLIES (200 updated), and its resume too", async () => {
    const paused = await post("app", `/workers/${RULE_CS}/paused`, {
      paused: true,
    });
    expect(paused.status, await paused.clone().text()).toBe(200);
    expect(await paused.json()).toEqual({ status: "updated", state: "paused" });
    expect(await stateOf(PB_CS, RULE_CS)).toBe("paused");
    // The other Content OS worker is untouched.
    expect(await stateOf(PB_CS_2, RULE_CS_2)).toBe("running");

    const resumed = await post("app", `/workers/${RULE_CS}/paused`, {
      paused: false,
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({
      status: "updated",
      state: "running",
    });
    expect(await stateOf(PB_CS, RULE_CS)).toBe("running");
  });

  it("without playbook.update it is refused 403 GRANT_DENIED, and the worker keeps running", async () => {
    const res = await post("readOnly", `/workers/${RULE_CS}/paused`, {
      paused: true,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      status?: string;
      code?: string;
      action?: string;
    };
    expect(body.status).toBe("denied");
    expect(body.code).toBe("GRANT_DENIED");
    expect(body.action).toBe("rule.update");
    expect(await stateOf(PB_CS, RULE_CS)).toBe("running");
  });

  it("a worker of a space it was not given is a 404 to it, and is not paused", async () => {
    const res = await post("app", `/workers/${RULE_OTHER}/paused`, {
      paused: true,
    });
    expect(res.status).toBe(404);
    expect(await stateOf(PB_OTHER, RULE_OTHER)).toBe("running");
  });
});

describe("POST /workers/:ruleId/run — run now from the app", () => {
  it("with playbook.run, the worker's playbook runs (the fence lets the app token through)", async () => {
    const res = await post("app", `/workers/${RULE_CS}/run`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("started");
    expect(h.runs).toEqual([{ playbookId: PB_CS }]);
  });

  it("without playbook.run it is refused 403 GRANT_DENIED and nothing runs", async () => {
    const res = await post("readOnly", `/workers/${RULE_CS}/run`, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "GRANT_DENIED"
    );
    expect(h.runs).toEqual([]);
  });
});
