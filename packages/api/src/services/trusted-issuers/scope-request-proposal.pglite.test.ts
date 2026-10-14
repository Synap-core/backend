/**
 * D7 — the owner SEES the Control Plane's scope request, and only a person's
 * yes widens the grant. Driven end to end on PGlite: the REAL boot seed
 * (`TrustedIssuerService.seedBuiltIn`), the REAL filer
 * (`syncTrustedIssuerScopeRequest` → `insertPendingProposal`) and the REAL
 * approval executor, resolved from the live registry.
 *
 * Pinned:
 *  - one pending proposal per issuer + scope set — a second boot files nothing;
 *  - a REJECTED request is recorded on the row and never re-filed for the same
 *    set; a different set is a new request;
 *  - a request whose ask changed is WITHDRAWN, never left to be approved;
 *  - approving grants exactly the asked scopes — not a revised wider payload,
 *    and never for an acting agent;
 *  - the opt-in (`autoAcceptRequestedScopes`) files nothing.
 *
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions with no FKs, NOT NULL or enums), and the
 * notification fan-out (mocked; asserted as called).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | { exec: (sql: string) => Promise<unknown> },
  notified: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(async (o: { proposalId: string }) => {
    h.notified.push(o.proposalId);
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  db,
  eq,
  proposals,
  runWithActingAgent,
  TrustedIssuerService,
  CONTROL_PLANE_ISSUER_SCOPES,
} from "@synap/database";
import {
  syncTrustedIssuerScopeRequest,
  TRUSTED_ISSUER_TARGET_TYPE,
  TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE,
} from "./scope-request-proposal.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerTrustedIssuerExecutors } from "../../routers/proposals/executors/trusted-issuer.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const isArray = t.endsWith("[]");
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "allowed_scopes"
            ? " default '{}'"
            : "";
    return `"${c.name}" ${isArray ? "text[]" : type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const CP = "https://api.test-cp.example";
const OWNER = "owner-test-1";
const PINNED = [...CONTROL_PLANE_ISSUER_SCOPES];
const WIDER = "membership:activate";
const OTHER = "sync";
const owner = { resolveOwner: async () => OWNER };

registerTrustedIssuerExecutors();

async function boot(requested: string[], autoAccept = false) {
  await new TrustedIssuerService(db).seedBuiltIn([
    {
      issuerUrl: CP,
      displayName: "Synap Control Plane",
      allowedScopes: PINNED,
      requestedScopes: requested,
      autoAcceptRequestedScopes: autoAccept,
    },
  ]);
  return syncTrustedIssuerScopeRequest(CP, owner);
}

async function rows() {
  return db
    .select()
    .from(proposals)
    .where(
      eq(proposals.proposalType, TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE)
    );
}

async function approve(proposalId: string, userId = OWNER) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  const executor = proposalExecRegistry.resolve(
    `${proposal!.targetType}/${proposal!.proposalType}`,
    proposal!.proposalType
  );
  return executor!.execute({
    proposal: proposal as never,
    payload: proposal!.data as never,
    userId,
    input: { proposalId },
    deps: {
      db,
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
      stampProjectMembership: async () => undefined,
      resolveMessagingAccountForPlatform: async () => null,
    },
    ctx: {} as never,
  } as never);
}

beforeEach(async () => {
  h.notified = [];
  await h.client!.exec(
    `drop table if exists "trusted_issuers"; drop table if exists "proposals"; drop table if exists "notifications";` +
      ddlFor(schema.trustedIssuers as unknown as PgTable) +
      ddlFor(schema.proposals as unknown as PgTable) +
      ddlFor(schema.notifications as unknown as PgTable)
  );
});

describe("the CP's scope request reaches the owner as ONE proposal (D7)", () => {
  it("files one pending proposal naming the issuer, its grant and its ask", async () => {
    const out = await boot([...PINNED, WIDER]);
    expect(out.action).toBe("filed");
    const [p, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(p!.status).toBe("pending");
    expect(p!.targetType).toBe(TRUSTED_ISSUER_TARGET_TYPE);
    expect(p!.workspaceId).toBeNull();
    expect(p!.createdBy).toBe(OWNER);
    expect(p!.subjectUserId).toBe(OWNER);
    const data = p!.data as Record<string, unknown>;
    expect(data.issuerUrl).toBe(CP);
    expect(data.requestedScopes).toEqual([WIDER]);
    expect([...(data.grantedScopes as string[])].sort()).toEqual(
      [...PINNED].sort()
    );
    expect(data.summary).toBe(
      'Widen access for Trusted issuer "Synap Control Plane"'
    );
    expect(h.notified).toEqual([p!.id]);
  });

  it("is idempotent: the next boot files no duplicate", async () => {
    await boot([...PINNED, WIDER]);
    const again = await boot([...PINNED, WIDER]);
    expect(again.action).toBe("unchanged");
    expect(await rows()).toHaveLength(1);
  });

  it("a rejection is recorded and NOT re-filed for the same ask; a new ask is", async () => {
    await boot([...PINNED, WIDER]);
    const [p] = await rows();
    // Every reject door leaves exactly this row state.
    await db
      .update(proposals)
      .set({ status: "rejected" })
      .where(eq(proposals.id, p!.id));

    expect((await boot([...PINNED, WIDER])).action).toBe("declined");
    expect((await boot([...PINNED, WIDER])).action).toBe("none");
    expect(await rows()).toHaveLength(1);
    const issuer = (await new TrustedIssuerService(db).getByUrl(CP))!;
    expect(issuer.allowedScopes).not.toContain(WIDER);

    expect((await boot([...PINNED, WIDER, OTHER])).action).toBe("filed");
    const pending = (await rows()).filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect([
      ...(pending[0]!.data as { requestedScopes: string[] }).requestedScopes,
    ]).toEqual([WIDER, OTHER].sort());
  });

  it("a request whose ask changed is withdrawn, and the new ask filed", async () => {
    await boot([...PINNED, WIDER]);
    const [old] = await rows();
    await boot([...PINNED, OTHER]);
    const all = await rows();
    expect(all.find((r) => r.id === old!.id)!.status).toBe("withdrawn");
    expect(all.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("the opt-in grants without a proposal and withdraws an open one", async () => {
    await boot([...PINNED, WIDER]);
    const out = await boot([...PINNED, WIDER], true);
    expect(out.action).toBe("none");
    const issuer = (await new TrustedIssuerService(db).getByUrl(CP))!;
    expect(issuer.allowedScopes).toContain(WIDER);
    expect((await rows()).map((r) => r.status)).toEqual(["withdrawn"]);
  });

  it("files nothing on a pod with no owner yet (retried next boot)", async () => {
    await new TrustedIssuerService(db).seedBuiltIn([
      {
        issuerUrl: CP,
        displayName: "Synap Control Plane",
        allowedScopes: PINNED,
        requestedScopes: [...PINNED, WIDER],
      },
    ]);
    const out = await syncTrustedIssuerScopeRequest(CP, {
      resolveOwner: async () => null,
    });
    expect(out.action).toBe("no_owner");
    expect(await rows()).toEqual([]);
  });
});

describe("approving it — a person grants exactly the ask (D7)", () => {
  it("grants the asked scopes and marks the proposal approved", async () => {
    await boot([...PINNED, WIDER]);
    const [p] = await rows();
    const res = (await approve(p!.id)) as { success: boolean };
    expect(res.success).toBe(true);
    const issuer = (await new TrustedIssuerService(db).getByUrl(CP))!;
    expect(issuer.allowedScopes).toContain(WIDER);
    expect((await rows())[0]!.status).toBe("approved");
    // Granted: the next boot has nothing left to ask.
    expect((await boot([...PINNED, WIDER])).action).toBe("none");
  });

  it("a revised payload naming a wider scope widens NOTHING", async () => {
    await boot([...PINNED, WIDER]);
    const [p] = await rows();
    await db
      .update(proposals)
      .set({
        data: {
          ...(p!.data as Record<string, unknown>),
          requestedScopes: [WIDER, "provision"],
        },
      })
      .where(eq(proposals.id, p!.id));
    await expect(approve(p!.id)).rejects.toThrow(
      /no longer asks for: provision/
    );
    const issuer = (await new TrustedIssuerService(db).getByUrl(CP))!;
    expect(issuer.allowedScopes).not.toContain(WIDER);
    expect(issuer.allowedScopes).not.toContain("provision");
    expect((await rows())[0]!.status).toBe("pending");
  });

  it("an acting AGENT can never approve it", async () => {
    await boot([...PINNED, WIDER]);
    const [p] = await rows();
    await expect(
      runWithActingAgent("agent-1", () => approve(p!.id))
    ).rejects.toThrow(/A person approves/);
    const issuer = (await new TrustedIssuerService(db).getByUrl(CP))!;
    expect(issuer.allowedScopes).not.toContain(WIDER);
  });
});
