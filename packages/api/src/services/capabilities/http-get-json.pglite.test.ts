/**
 * `http.get_json` and its allow-list door `http.allow_host` (agent report
 * 25a60263; founder answer 12, 21 Nov 2026).
 *
 * Real: the run core (`executeCapability`), the capability gate
 * (`gateCapabilityExecution`, with its `proposeOnly` floor read off the
 * seeded verb's own metadata), the post-gate runner an approval re-enters
 * (`runResolvedSkill`), the allow-list on `config_settings` and the pod-admin
 * read, as SQL on PGlite; the pinned outbound door (`safePublicFetch`, via
 * `fetchGuardedBytes`) against a local server, with a stub resolver so test
 * names land on 127.0.0.1 (treated as public) or 10.0.0.5 (private).
 *
 * Stubbed: the proposal row write (the VERDICT is the real gate's), the event
 * log, the grant lookup, the origin-trust read, and the stored rule lookup,
 * which answers a person's `auto` rule naming the verb, the strongest
 * widening there is.
 *
 * Rows rule out:
 *  - a GET to a host not on the list (refused, nothing sent, the sentence says
 *    how to ask for it), through the agent's real run too;
 *  - a redirect from an allowed host to a private address, or to a host not
 *    on the list;
 *  - a body that is not JSON, or larger than the cap;
 *  - a header other than Accept / Accept-Language, credentials in the URL,
 *    plain http by default;
 *  - an agent adding a host directly, even under an `auto` rule;
 *  - a member who is not a pod admin adding one.
 *
 * Cannot see: real DNS, TLS, production Postgres.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  proposals: [] as Array<Record<string, unknown>>,
  /** The stored rule the gate reads for an agent run (null = none). */
  rule: null as null | { verdict: "auto" },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const events = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : async () => ({ id: globalThis.crypto.randomUUID() }),
    }
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: events,
    knowledgeRepository: { saveFact: async () => undefined },
    findCapabilityGrant: async () => ({ ok: false }),
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGovernanceRule: async () => h.rule ?? undefined,
  resolveOriginTrust: async () => undefined,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: async () => new Array(1536).fill(0),
}));
vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    const id = globalThis.crypto.randomUUID();
    h.proposals.push({ id, ...input });
    return { id };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { AddressResolver } from "@synap/shared-utils";
import "../../access/grant-read.js";
import {
  executeCapability,
  runResolvedSkill,
  type ResolvedSkillRow,
} from "./execute-capability.js";
import { BUILTIN_VERBS } from "./builtin-verbs.js";
import { SYNAP_CORE_DEFINITION } from "./ensure-synap-core.js";
import {
  allowHost,
  httpGetJson,
  listAllowedHosts,
  type HttpGetJsonDeps,
} from "./http-get-json.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const MEMBER = randomUUID();
const AGENT = randomUUID();
const GET_JSON = randomUUID();
const ALLOW_HOST = randomUUID();

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** The seeded definition of a Synap Core verb: what a pod really stores. */
function coreSkill(name: string) {
  const def = SYNAP_CORE_DEFINITION.skills.find((s) => s.name === name);
  if (!def) throw new Error(`${name} is not in SYNAP_CORE_DEFINITION`);
  return def as typeof def & {
    metadata?: Record<string, unknown>;
    intent?: string;
  };
}

// ── the local "internet" ────────────────────────────────────────────────────
let server: http.Server;
let port = 0;
const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];

const resolve: AddressResolver = async (host) => {
  const table: Record<string, string> = {
    "api.example.test": "127.0.0.1",
    "elsewhere.example.test": "127.0.0.1",
    "data.example.test": "10.0.0.5",
  };
  const address = table[host];
  return address ? [{ address, family: 4 }] : [];
};
/** The test server is on loopback: treat ONLY it as public. */
const deps: HttpGetJsonDeps = {
  fetchDeps: {
    resolve,
    isAllowedAddress: (a) => a === "127.0.0.1",
    allowedPorts: "any",
    httpsOnly: false,
  },
};
/**
 * Past the 2 MB cap the founder's default names, as a literal: read off the
 * module's own constant, a raised cap would raise the test's body with it and
 * the test could never go red (seen in this file's negative control).
 */
const OVERSIZE_BYTES = 2 * 1024 * 1024;
const at = (host: string, path: string) => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const path = (req.url ?? "").split("?")[0];
    if (path === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          query: Object.fromEntries(new URL(req.url!, "http://x").searchParams),
          items: [1, 2, 3],
        })
      );
      return;
    }
    if (path === "/html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>not json</body></html>");
      return;
    }
    if (path === "/big") {
      // No Content-Length: the cap must cut the stream itself.
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const write = (): void => {
        while (sent <= OVERSIZE_BYTES) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", write);
            return;
          }
        }
        res.end("1");
      };
      write();
      return;
    }
    if (path === "/long") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          Array.from({ length: 5000 }, (_, i) => ({ i, name: "x".repeat(40) }))
        )
      );
      return;
    }
    if (path === "/to-private") {
      res.writeHead(302, { location: at("data.example.test", "/secret") });
      res.end();
      return;
    }
    if (path === "/to-elsewhere") {
      res.writeHead(302, { location: at("elsewhere.example.test", "/json") });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    MEMBER,
    "member@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'), ($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), MEMBER]
  );
  // The pod admin is the owner of the pod-admin system space (isPodAdmin).
  const podAdmin = randomUUID();
  await q(
    `insert into workspaces (id, name, system_slug) values ($1,'Pod admin','pod-admin')`,
    [podAdmin]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), podAdmin, OWNER]
  );

  for (const [id, name] of [
    [GET_JSON, "http.get_json"],
    [ALLOW_HOST, "http.allow_host"],
  ] as const) {
    const def = coreSkill(name);
    await q(
      `insert into skills (id, user_id, name, kind, scope, status, approved, execution_mode, parameters, metadata, intent)
       values ($1,$2,$3,'builtin','pod','active',true,'sync',$4::jsonb,$5::jsonb,$6)`,
      [
        id,
        OWNER,
        name,
        JSON.stringify(def.parameters ?? {}),
        JSON.stringify(def.metadata ?? {}),
        def.intent ?? null,
      ]
    );
  }

  await allowHost("api.example.test", OWNER);
  await allowHost("data.example.test", OWNER);
}, 120_000);

afterAll(
  () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    })
);

beforeEach(() => {
  seen.length = 0;
  h.proposals.length = 0;
  h.rule = null;
});

const run = (
  verbId: string,
  parameters: Record<string, unknown>,
  over: Record<string, unknown> = {}
) =>
  executeCapability({
    verbId,
    parameters,
    workspaceId: null,
    userId: OWNER,
    idempotencyKey: randomUUID(),
    ...over,
  });

describe("http.get_json reads only hosts the pod allows", () => {
  it("a host not on the list is refused, nothing is sent, and the sentence says how to ask", async () => {
    const out = await httpGetJson(
      { url: at("elsewhere.example.test", "/json") },
      deps
    );
    expect(out).toMatchObject({
      status: "refused",
      reason: "host_not_allowed",
      allowedHosts: ["api.example.test", "data.example.test"],
    });
    expect(out.status === "refused" && out.message).toContain(
      'run http.allow_host with { host: "elsewhere.example.test" }'
    );
    expect(seen).toHaveLength(0);
  });

  it("an agent's run auto-runs as a read and meets the same refusal", async () => {
    const out = await run(
      "http.get_json",
      { url: "https://not-listed.example.org/v1/x" },
      { agentUserId: AGENT }
    );
    expect(out).toMatchObject({
      kind: "run",
      result: { status: "refused", reason: "host_not_allowed" },
    });
    expect(h.proposals).toHaveLength(0);
  });

  it("an allowed host answers parsed JSON; query and Accept-Language are sent, no cookie or credential", async () => {
    const out = await httpGetJson(
      {
        url: at("api.example.test", "/json"),
        query: { q: "synap", page: 2, active: true },
        headers: { "Accept-Language": "fr-FR" },
      },
      deps
    );
    expect(out).toMatchObject({
      status: "ok",
      truncated: false,
      json: {
        query: { q: "synap", page: "2", active: "true" },
        items: [1, 2, 3],
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["accept-language"]).toBe("fr-FR");
    expect(seen[0]!.headers.accept).toBe("application/json");
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("a redirect to a private address is refused before it is reached", async () => {
    const out = await httpGetJson(
      { url: at("api.example.test", "/to-private") },
      deps
    );
    expect(out).toMatchObject({ status: "refused", reason: "blocked" });
    expect(seen.map((s) => s.url)).toEqual(["/to-private"]);
  });

  it("a redirect to a host not on the list is refused, and named", async () => {
    const out = await httpGetJson(
      { url: at("api.example.test", "/to-elsewhere") },
      deps
    );
    expect(out).toMatchObject({
      status: "refused",
      reason: "redirect_host_not_allowed",
    });
    expect(out.status === "refused" && out.message).toContain(
      "elsewhere.example.test"
    );
    expect(seen.map((s) => s.url)).toEqual(["/to-elsewhere"]);
  });

  it("a body that is not JSON is refused and says what it was", async () => {
    const out = await httpGetJson(
      { url: at("api.example.test", "/html") },
      deps
    );
    expect(out).toMatchObject({ status: "refused", reason: "not_json" });
    expect(out.status === "refused" && out.message).toContain("text/html");
  });

  it("a body past the size cap is refused, not read whole", async () => {
    const out = await httpGetJson(
      { url: at("api.example.test", "/big") },
      deps
    );
    expect(out).toMatchObject({ status: "refused", reason: "too_large" });
  });

  it("a long answer comes back cut, with a marker", async () => {
    const out = await httpGetJson(
      { url: at("api.example.test", "/long") },
      deps
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.truncated).toBe(true);
    const items = out.json as unknown[];
    expect(items.length).toBeLessThan(5000);
    expect(items[items.length - 1]).toMatch(/^…\[truncated: \d+ more items\]$/);
    expect(JSON.stringify(out.json).length).toBeLessThan(70_000);
  });

  it("refuses any other header, and credentials in the URL, before sending anything", async () => {
    await expect(
      httpGetJson(
        {
          url: at("api.example.test", "/json"),
          headers: { Authorization: "Bearer x" },
        },
        deps
      )
    ).resolves.toMatchObject({
      status: "refused",
      reason: "header_not_allowed",
    });
    await expect(
      httpGetJson({ url: `http://u:p@api.example.test:${port}/json` }, deps)
    ).resolves.toMatchObject({
      status: "refused",
      reason: "credentials_in_url",
    });
    expect(seen).toHaveLength(0);
  });

  it("by default only https is read (the production door)", async () => {
    const out = await httpGetJson({ url: "http://api.example.test/json" });
    expect(out).toMatchObject({ status: "refused", reason: "blocked" });
  });
});

describe("http.allow_host: an agent never adds a host itself", () => {
  it("an agent's ask is a proposal, even under a person's auto rule naming the verb", async () => {
    h.rule = { verdict: "auto" };
    const out = await run(
      "http.allow_host",
      { host: "recherche-entreprises.api.gouv.fr", reason: "SIREN lookups" },
      { agentUserId: AGENT }
    );
    expect(out.kind).toBe("proposed");
    expect(h.proposals).toHaveLength(1);
    expect(await listAllowedHosts()).not.toContain(
      "recherche-entreprises.api.gouv.fr"
    );
  });

  it("the person's approval re-runs it as the person, and the host is added", async () => {
    const row = {
      id: ALLOW_HOST,
      name: "http.allow_host",
      kind: "builtin",
      providerSpec: null,
      metadata: coreSkill("http.allow_host").metadata ?? {},
      parameters: {},
      executionMode: "sync",
      intent: null,
      inputMap: null,
    } as ResolvedSkillRow;
    const out = await runResolvedSkill(
      row,
      { host: "bodacc-datadila.opendatasoft.com" },
      {
        userId: OWNER,
        workspaceId: null,
        provenance: { agentUserId: AGENT, proposalId: randomUUID() },
      }
    );
    expect(out).toMatchObject({
      kind: "run",
      result: { status: "allowed", host: "bodacc-datadila.opendatasoft.com" },
    });
    expect(await listAllowedHosts()).toContain(
      "bodacc-datadila.opendatasoft.com"
    );
  });

  it("a pod admin's own run adds it at once, normalised", async () => {
    const out = await run("http.allow_host", {
      host: "  Geo.API.Gouv.FR ",
    });
    expect(out).toMatchObject({
      kind: "run",
      result: {
        status: "allowed",
        host: "geo.api.gouv.fr",
        alreadyAllowed: false,
      },
    });
    expect(await listAllowedHosts()).toContain("geo.api.gouv.fr");
  });

  it("the handler itself refuses an agent and a member who is not a pod admin", async () => {
    const handler = BUILTIN_VERBS["http.allow_host"]!;
    /** The refusal's name and class, or "ran" when nothing was thrown. */
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
        return "ran";
      } catch (e) {
        const err = e as { name?: string; errorClass?: string };
        return `${err.name}:${err.errorClass}`;
      }
    };
    expect(
      await refusal(
        handler(
          { host: "a.example.org" },
          { userId: OWNER, workspaceId: null, agentUserId: AGENT }
        )
      )
    ).toBe("VerbRefusal:permission");
    expect(
      await refusal(
        handler(
          { host: "a.example.org" },
          { userId: MEMBER, workspaceId: null }
        )
      )
    ).toBe("VerbRefusal:permission");
    expect(
      await refusal(
        handler(
          { host: "https://a.example.org/x" },
          { userId: OWNER, workspaceId: null }
        )
      )
    ).toBe("VerbRefusal:validation");
    expect(await listAllowedHosts()).not.toContain("a.example.org");
  });
});
