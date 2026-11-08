/**
 * An agent's install of a catalog capability that runs on a computer, from
 * the proposal to an installation request, on PGlite through the REAL
 * container door (`capabilityContainers.create`), the REAL approve executor
 * (`capability/create`), the REAL installable read
 * (`loadInstallableCapability`) and the REAL request route. The definition
 * is the one the catalog serves for `media-ffmpeg` 0.35.0 (the fixture is
 * the Control Plane's `/api/marketplace/capabilities` entry, verbatim).
 * Stubbed: the gate's outcome (an agent's ask is proposed, a person's is
 * granted, as the ladder answers).
 *
 * Dogfood, 2026-11-08: `synap market install media-ffmpeg` with the
 * computer's key filed "Create Tool ffmpeg on your computer" as a proposal
 * whose data was `{name, description, templateKey, workspaceId}` only. The
 * applier writes the computer blocks into `metadata.computer` only when the
 * container exists at apply time, so an approved container had none, and
 * every `POST /installations/request` for it answered 404 NOT_INSTALLABLE.
 *
 * Rows rule out: the proposal dropping the computer blocks, the executor
 * dropping them, and the container's metadata address disagreeing with its
 * column. The applier half (`createCapabilityFromDefinition` hands the
 * declared metadata to the container door) is
 * create-from-definition.computer-blocks.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  gate: [] as Array<Record<string, unknown>>,
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

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gate.push(opts);
      return opts.agentUserId
        ? {
            granted: false,
            proposalId: randomUUID(),
            proposalType: "create",
            reviewUrl: "https://pod.example/review",
          }
        : { granted: true };
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { pickComputerSpec } from "@synap-core/types/capability-manifest";
import { capabilityContainersRouter } from "../../routers/capability-containers.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import type { ProposalExecutorArgs } from "../../routers/proposals/execution-registry.js";
import { registerCapabilityExecutors } from "../../routers/proposals/executors/capability.js";
import { registerInstallationsRoutes } from "../../routers/hub-protocol/rest/installations.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";
import { loadInstallableCapability } from "./installations.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import type { Context } from "../../types/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(
  readFileSync(
    resolve(here, "__fixtures__/media-ffmpeg.0.35.0.definition.json"),
    "utf8"
  )
) as Record<string, unknown>;

const PERSON = randomUUID();
const MAC = randomUUID();
const RW = ["hub-protocol.read", "hub-protocol.write"];

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', NULL, NULL, '{}'::jsonb),
      ($2, 'm@x', 'Mac', 'machine', $1, $3::jsonb)`,
    [
      PERSON,
      MAC,
      JSON.stringify({
        platform: "darwin",
        arch: "arm64",
        hostsServices: true,
      }),
    ]
  );
  registerCapabilityExecutors();
}, 60_000);

function routes(vars: { userId: string; agentUserId?: string }) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", RW);
    c.set("userId", vars.userId);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerInstallationsRoutes(app);
  return app;
}

const ask = (app: HubHono, body: Record<string, unknown>) =>
  app.request("/installations/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ computer: "me", ...body }),
  });

describe("an agent's install of media-ffmpeg 0.35.0, approved, is installable", () => {
  it("the fixture is the catalog's definition: a tool for a computer", () => {
    const computer = pickComputerSpec(DEF);
    expect(Object.keys(computer ?? {})).toEqual(
      expect.arrayContaining(["placement", "install", "verify", "uninstall"])
    );
    expect(DEF.key).toBe("media-ffmpeg");
  });

  it("the proposal carries the computer blocks, the approval writes them, and the request is taken", async () => {
    // What the applier hands the container door (create-from-definition.ts).
    const metadata = {
      computer: pickComputerSpec(DEF),
      templateKey: DEF.key,
      contentHash: DEF.contentHash,
    };
    const res = await capabilityContainersRouter
      .createCaller({
        authenticated: true,
        userId: PERSON,
      } as unknown as Context)
      .create({
        name: DEF.name as string,
        description: DEF.description as string,
        templateKey: DEF.key as string,
        metadata,
        agentUserId: MAC,
      });
    expect(res.status).toBe("proposed");
    // Nothing exists before the person approves.
    expect(await loadInstallableCapability("media-ffmpeg")).toBeNull();

    const filed = h.gate.at(-1)!;
    expect(filed).toMatchObject({
      subjectType: "capability",
      action: "create",
    });
    const data = filed.data as Record<string, unknown>;
    expect(data.metadata).toEqual(metadata);

    const proposalId = randomUUID();
    await q(
      `INSERT INTO proposals (id, target_type, target_id, proposal_type, data, status, revision_history, created_at, updated_at)
       VALUES ($1, 'capability', $2, 'create', $3::jsonb, 'pending', '[]'::jsonb, now(), now())`,
      [proposalId, randomUUID(), JSON.stringify({ data })]
    );
    const executor = proposalExecRegistry.resolve(
      "capability/create",
      "create"
    );
    expect(executor, "capability/create executor").toBeDefined();
    await executor!.execute({
      proposal: {
        id: proposalId,
        targetType: "capability",
        targetId: randomUUID(),
        proposalType: "create",
        workspaceId: null,
        sessionId: null,
        projectId: null,
        agentUserId: MAC,
        sourceMessageId: null,
        data: { data },
      },
      payload: data,
      userId: PERSON,
      input: { proposalId },
      ctx: {} as ProposalExecutorArgs["ctx"],
      deps: {
        db: null,
        emitProposalReviewed: () => {},
        reportProposalOutcome: () => {},
        stampProjectMembership: async () => {},
        resolveMessagingAccountForPlatform: async () => null,
      },
    } as unknown as ProposalExecutorArgs);

    const row = (
      await q<{ template_key: string; metadata: Record<string, unknown> }>(
        `SELECT template_key, metadata FROM capabilities WHERE template_key = 'media-ffmpeg'`
      )
    ).rows;
    expect(row).toHaveLength(1);
    expect(row[0]!.metadata.templateKey).toBe(row[0]!.template_key);
    expect(row[0]!.metadata.computer).toEqual(metadata.computer);

    const installable = await loadInstallableCapability("media-ffmpeg");
    expect(installable?.kind).toBe("tool");

    // The computer's own ask: a check of a tool not installed yet is refused
    // as NOT_INSTALLED (the door knows the capability), and its install is
    // filed for the person; the person's own install applies with a job.
    const computer = routes({ userId: PERSON, agentUserId: MAC });
    const verify = await ask(computer, {
      capabilityKey: "media-ffmpeg",
      action: "verify",
    });
    expect(verify.status, await verify.clone().text()).toBe(409);
    expect(await verify.json()).toMatchObject({ code: "NOT_INSTALLED" });
    const install = await ask(computer, {
      capabilityKey: "media-ffmpeg",
      action: "install",
    });
    expect(install.status, await install.clone().text()).toBe(202);
    const mine = await ask(routes({ userId: PERSON }), {
      capabilityKey: "media-ffmpeg",
      action: "install",
      computer: MAC,
    });
    expect(mine.status, await mine.clone().text()).toBe(200);
    const body = (await mine.json()) as { status: string; jobId: string };
    expect(body.status).toBe("approved");
    expect(typeof body.jobId).toBe("string");
  });
});
