/**
 * Unit tests for the `WorkspaceResolutionService` door — the 6-rung ladder,
 * exercised against a mock db so every rung's precedence, the I2 membership/
 * archival/type floor, and the rung-6 K1 parity are proven without a live DB.
 *
 * The door filters membership/archival/routable-type in JS (see
 * loadRoutableMemberWorkspaces), so the mock returns full rows and lets the door
 * do the excluding — that is exactly the code path we want to cover.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveWorkspacePlacement,
  resolveImportEntityPlacement,
  acceptDeterministicGraphWorkspace,
  resolveGraphWorkspaceFromSlugs,
  isRoutableWorkspaceType,
  isDomainHomeWorkspace,
  resolveEntityWorkspacePlacement,
  resolveMaterializedEntityWorkspaceId,
  resolveKindWritePin,
  normalizeEntityScope,
} from "./workspace-resolution-service.js";
import { ProfileResolutionService } from "./profile-resolution-service.js";

const USER = "user-1";
const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
/** A workspace the caller is NOT a member of — the I2 floor must never surface it. */
const WS_OTHER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const WS_ADMIN = "dddddddd-dddd-dddd-dddd-dddddddddddd";

interface Seed {
  members?: string[];
  workspaces?: {
    id: string;
    name: string;
    workspaceType?: string | null;
    archivedAt?: Date | null;
    systemSlug?: string | null;
    settings?: {
      surfaceClass?: string | null;
      systemSlug?: string | null;
    } | null;
  }[];
  profiles?: {
    id: string;
    slug: string;
    scope: string;
    workspaceId?: string | null;
  }[];
  grants?: { workspaceId: string }[];
  channelWorkspaceId?: string | null;
  sessionWorkspaceId?: string | null;
  entities?: { workspaceId: string | null }[];
  podReadable?: string[];
  /** `workspace --feeds--> workspace` rows (rung-4 feeds seam). */
  feedsLinks?: {
    fromId: string;
    toId: string;
    metadata?: { profileSlug?: string | null };
  }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(seed: Seed): any {
  return {
    query: {
      workspaceMembers: {
        findMany: async () =>
          (seed.members ?? []).map((id) => ({ workspaceId: id })),
      },
      workspaces: {
        // Two callers: loadRoutableMemberWorkspaces asks for `name`;
        // loadRoutingMemberIds (rung-5 no-candidate floor) asks for `id` only.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          if (args?.columns?.name) {
            return (seed.workspaces ?? []).map((w) => ({
              id: w.id,
              name: w.name,
              workspaceType: w.workspaceType ?? "domain",
              archivedAt: w.archivedAt ?? null,
              systemSlug: w.systemSlug ?? null,
              settings: w.settings ?? {},
            }));
          }
          return (seed.podReadable ?? []).map((id) => ({ id }));
        },
      },
      profiles: {
        findMany: async () =>
          (seed.profiles ?? []).map((p) => ({
            id: p.id,
            slug: p.slug,
            scope: p.scope,
            workspaceId: p.workspaceId ?? null,
          })),
      },
      profileWorkspaceAccess: {
        findMany: async () => seed.grants ?? [],
      },
      channels: {
        findFirst: async () =>
          seed.channelWorkspaceId !== undefined
            ? { workspaceId: seed.channelWorkspaceId }
            : undefined,
      },
      focusSessions: {
        findFirst: async () =>
          seed.sessionWorkspaceId !== undefined
            ? { workspaceId: seed.sessionWorkspaceId }
            : undefined,
      },
      entities: {
        findMany: async () =>
          (seed.entities ?? []).map((e) => ({ workspaceId: e.workspaceId })),
      },
      links: {
        // Rung-4 feeds seam: `loadFeedsProviders` queries `to_id = consumer`.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          const consumerId = args?.where; // opaque drizzle expr in prod; mock filters by seed
          void consumerId;
          return (seed.feedsLinks ?? []).map((l) => ({
            fromId: l.fromId,
            metadata: l.metadata ?? {},
          }));
        },
      },
    },
  };
}

describe("resolveWorkspacePlacement — rung 1 (explicit / deliberate)", () => {
  it("global flag → pod-wide null, wins with no DB lookup", async () => {
    const r = await resolveWorkspacePlacement(makeDb({}), {
      userId: USER,
      globalFlag: true,
      kindSlug: "client",
    });
    expect(r).toMatchObject({ workspaceId: null, rung: 1, confidence: 1 });
  });

  it("explicit workspace wins over an ontology signal", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      profiles: [
        { id: "p", slug: "client", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      explicitWorkspaceId: WS_B,
      kindSlug: "client",
    });
    expect(r).toMatchObject({ workspaceId: WS_B, rung: 1 });
  });

  it("explicit null → deliberate pod-wide, rung 1", async () => {
    const r = await resolveWorkspacePlacement(makeDb({}), {
      userId: USER,
      explicitWorkspaceId: null,
      kindSlug: "client",
    });
    expect(r).toMatchObject({ workspaceId: null, rung: 1 });
  });
});

describe("resolveWorkspacePlacement — rung 2 (ontology)", () => {
  it("single workspace-scoped survivor → that lens, rung 2, named reason", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      profiles: [
        { id: "p", slug: "client", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.rung).toBe(2);
    expect(r.reason).toContain("CRM");
    expect(r.reason).toContain("client");
  });

  it("pod-wide kind + workspace-scoped facet slug → places via facet (create path)", async () => {
    // entities.create now passes kindSlug=person + facetSlugs=[client] so a
    // lead/client role can home the entity without the agent inventing a UUID.
    const db = makeDb({
      members: [WS_A, WS_B],
      workspaces: [
        { id: WS_A, name: "Sales CRM" },
        { id: WS_B, name: "Ops" },
      ],
      profiles: [
        { id: "pk", slug: "person", scope: "system", workspaceId: null },
        { id: "pr", slug: "client", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "person",
      facetSlugs: ["client"],
      ambientWorkspaceId: null,
      entityScope: "pod",
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.rung).toBe(2);
  });

  // NOTE: rung-2 shared-scope (profile_workspace_access), rung-3 channel, and
  // rung-3 focus-session cases can't be unit-tested in this isolated harness —
  // the `profileWorkspaceAccess`, `channels`, and `focusSessions` schema-barrel
  // bindings resolve to `undefined` under vitest's ESM source transform (a
  // pre-existing circular-import artifact in @synap/database's schema barrel;
  // the tables are fully defined in the built dist + production). Those rungs
  // are exercised through the capture / attachFacet integration hooks instead.

  it("multiple survivors → candidates carried, falls to rung 6 (ambient)", async () => {
    const db = makeDb({
      members: [WS_A, WS_B],
      workspaces: [
        { id: WS_A, name: "CRM" },
        { id: WS_B, name: "Sales" },
      ],
      profiles: [
        { id: "p1", slug: "client", scope: "workspace", workspaceId: WS_A },
        { id: "p2", slug: "client", scope: "workspace", workspaceId: WS_B },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      // Role/process kind — explicit workspace scope (omit would default pod).
      entityScope: "workspace",
    });
    expect(r.rung).toBe(6);
    expect(r.workspaceId).toBe(WS_A);
    expect(r.candidates.map((c) => c.id).sort()).toEqual([WS_A, WS_B].sort());
  });

  it("system-scope (pod-wide) kind → no ontology signal → rung 6 pod default", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      profiles: [
        { id: "p", slug: "person", scope: "system", workspaceId: null },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "person",
      entityScope: "pod",
      ambientWorkspaceId: WS_A,
    });
    expect(r.rung).toBe(6);
    expect(r.workspaceId).toBeNull();
  });

  it("I2: a role enabled only in a NON-member workspace never appears — rung 6, empty candidates, reason omits it", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }], // WS_B not a member
      profiles: [
        { id: "p", slug: "client", scope: "workspace", workspaceId: WS_B },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
    });
    expect(r.rung).toBe(6);
    expect(r.candidates).toEqual([]);
    expect(r.reason).not.toContain(WS_B);
  });

  it("archived member workspace is excluded from the ontology signal", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM", archivedAt: new Date() }],
      profiles: [
        { id: "p", slug: "client", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
    });
    // Archived → not a routable member → no rung-2 pick → default.
    expect(r.rung).toBe(6);
  });

  it("agent-type workspace (D2) is excluded from the ontology signal", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "Agent WS", workspaceType: "agent" }],
      profiles: [
        { id: "p", slug: "client", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
    });
    expect(r.rung).toBe(6);
    expect(r.candidates).toEqual([]);
  });
});

describe("resolveWorkspacePlacement — rung 4 (relational)", () => {
  it("linked entities all in one workspace → rung 4", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      entities: [{ workspaceId: WS_A }, { workspaceId: WS_A }],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      relatedEntityIds: ["e1", "e2"],
    });
    expect(r).toMatchObject({ workspaceId: WS_A, rung: 4 });
  });
});

describe("resolveWorkspacePlacement — rung 4 (feeds seam)", () => {
  // Multi-candidate ontology (the kind is enabled in both A + B), ambient = A.
  // A declares it CONSUMES B (B --feeds--> A). The feeds seam tie-breaks toward
  // B, the declared source-of-truth, instead of falling to the rung-6 ambient.
  it("declared provider/feeds-source tie-breaks the candidate set (rung 4)", async () => {
    const db = makeDb({
      members: [WS_A, WS_B],
      workspaces: [
        { id: WS_A, name: "Marketing" },
        { id: WS_B, name: "Comms" },
      ],
      profiles: [
        { id: "p1", slug: "asset", scope: "workspace", workspaceId: WS_A },
        { id: "p2", slug: "asset", scope: "workspace", workspaceId: WS_B },
      ],
      // Comms (WS_B) --feeds--> Marketing (WS_A): Marketing consumes Comms.
      feedsLinks: [{ fromId: WS_B, toId: WS_A }],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "asset",
      ambientWorkspaceId: WS_A,
    });
    expect(r.rung).toBe(4);
    expect(r.workspaceId).toBe(WS_B);
    expect(r.reason).toContain("feeds edge");
  });

  // A kind-qualified feeds edge for a DIFFERENT kind must not tie-break — so a
  // declared edge never re-routes an unrelated kind's placement.
  it("kind-mismatched feeds edge is ignored → falls through to rung 6", async () => {
    const db = makeDb({
      members: [WS_A, WS_B],
      workspaces: [
        { id: WS_A, name: "Marketing" },
        { id: WS_B, name: "Comms" },
      ],
      profiles: [
        { id: "p1", slug: "asset", scope: "workspace", workspaceId: WS_A },
        { id: "p2", slug: "asset", scope: "workspace", workspaceId: WS_B },
      ],
      // The edge concerns 'lead', not the 'asset' being placed → no signal.
      feedsLinks: [
        { fromId: WS_B, toId: WS_A, metadata: { profileSlug: "lead" } },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "asset",
      ambientWorkspaceId: WS_A,
      entityScope: "workspace",
    });
    expect(r.rung).toBe(6);
    expect(r.workspaceId).toBe(WS_A);
  });
});

describe("resolveWorkspacePlacement — rung 5 (AI tie-break)", () => {
  const twoCandidateDb = () =>
    makeDb({
      members: [WS_A, WS_B],
      workspaces: [
        { id: WS_A, name: "A" },
        { id: WS_B, name: "B" },
      ],
      profiles: [
        { id: "p1", slug: "client", scope: "workspace", workspaceId: WS_A },
        { id: "p2", slug: "client", scope: "workspace", workspaceId: WS_B },
      ],
    });

  // RATIFIED: rungs 1–4 ACT, rung 5 PROPOSES. A confident AI hint is a
  // suggestion, never a placement — no comparable tool (kubectl, gcloud, AWS,
  // Azure, Pulumi, Terraform, Vercel, gh) lets a heuristic act as a scope.
  it("confident hint over candidates → PROPOSES, does not move (rung 5)", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_B, confidence: 0.9 },
      mode: "auto",
    });
    expect(r.rung).toBe(5);
    expect(r.ask).toBe(true);
    // The data STAYS PUT — a caller that ignores `ask` gets the ambient
    // workspace, i.e. where it would have landed with no AI hint at all.
    expect(r.workspaceId).toBe(WS_A);
    // CONTRACT: candidates[0] IS the suggestion (capture reads exactly this).
    expect(r.candidates[0]?.id).toBe(WS_B);
  });

  it("auto and ask now converge on the same rung-5 outcome", async () => {
    const forMode = (mode: "auto" | "ask") =>
      resolveWorkspacePlacement(twoCandidateDb(), {
        userId: USER,
        kindSlug: "client",
        ambientWorkspaceId: WS_A,
        aiHint: { workspaceId: WS_B, confidence: 0.9 },
        mode,
      });
    const auto = await forMode("auto");
    const ask = await forMode("ask");
    expect(auto.workspaceId).toBe(ask.workspaceId);
    expect(auto.ask).toBe(ask.ask);
    expect(auto.candidates[0]?.id).toBe(ask.candidates[0]?.id);
  });

  it("locked still never moves and never asks", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_B, confidence: 0.9 },
      mode: "locked",
      entityScope: "workspace",
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.ask).toBe(false);
    expect(r.rung).toBe(6);
  });

  it("a non-member hint is never proposed (I2 floor holds)", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_OTHER, confidence: 0.99 },
      mode: "auto",
    });
    expect(r.ask).toBe(false);
    expect(r.rung).toBe(6);
    expect(r.candidates.map((c) => c.id)).not.toContain(WS_OTHER);
  });

  it("below-gate hint → abstains, falls to rung 6, candidates preserved", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_B, confidence: 0.3 },
      mode: "auto",
      entityScope: "workspace",
    });
    expect(r.rung).toBe(6);
    expect(r.workspaceId).toBe(WS_A);
    expect(r.candidates.map((c) => c.id).sort()).toEqual([WS_A, WS_B].sort());
  });

  it("ask mode → ask=true, stays on ambient, does not move", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_B, confidence: 0.9 },
      mode: "ask",
    });
    expect(r.rung).toBe(5);
    expect(r.ask).toBe(true);
    expect(r.workspaceId).toBe(WS_A);
  });
});

describe("resolveWorkspacePlacement — rung 6 (K1 parity)", () => {
  it("pod-scope profile → NULL, ignoring the ambient workspace", async () => {
    const r = await resolveWorkspacePlacement(makeDb({}), {
      userId: USER,
      entityScope: "pod",
      ambientWorkspaceId: WS_A,
    });
    expect(r).toMatchObject({ workspaceId: null, rung: 6, confidence: 1 });
  });

  it("workspace-scope profile → the ambient workspace", async () => {
    const r = await resolveWorkspacePlacement(makeDb({}), {
      userId: USER,
      entityScope: "workspace",
      ambientWorkspaceId: WS_A,
    });
    expect(r).toMatchObject({ workspaceId: WS_A, rung: 6 });
  });

  it("workspaceScoped flag overrides a pod default → ambient", async () => {
    const r = await resolveWorkspacePlacement(makeDb({}), {
      userId: USER,
      entityScope: "pod",
      workspaceScopedFlag: true,
      ambientWorkspaceId: WS_A,
    });
    expect(r).toMatchObject({ workspaceId: WS_A, rung: 6 });
  });

  it("no ambient workspace → pod-wide null", async () => {
    const r = await resolveWorkspacePlacement(makeDb({}), {
      userId: USER,
      entityScope: "workspace",
      ambientWorkspaceId: null,
    });
    expect(r).toMatchObject({ workspaceId: null, rung: 6 });
  });
});

describe("isRoutableWorkspaceType / isDomainHomeWorkspace", () => {
  it("type-only predicate excludes operational + agent", () => {
    expect(isRoutableWorkspaceType("operational")).toBe(false);
    expect(isRoutableWorkspaceType("agent")).toBe(false);
    expect(isRoutableWorkspaceType("personal")).toBe(true);
  });

  it("domain-home excludes surfaceClass admin and systemSlug pod-admin", () => {
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        settings: { surfaceClass: "admin" },
      })
    ).toBe(false);
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        systemSlug: "pod-admin",
      })
    ).toBe(false);
    expect(isDomainHomeWorkspace({ workspaceType: "personal" })).toBe(true);
  });
});

describe("normalizeEntityScope / resolveEntityWorkspacePlacement / resolveKindWritePin", () => {
  const AMBIENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("normalizeEntityScope: only explicit workspace pins; else pod", () => {
    expect(normalizeEntityScope("workspace")).toBe("workspace");
    expect(normalizeEntityScope("pod")).toBe("pod");
    expect(normalizeEntityScope(null)).toBe("pod");
    expect(normalizeEntityScope(undefined)).toBe("pod");
    expect(normalizeEntityScope("garbage")).toBe("pod");
  });

  it("omitted entityScope → pod-wide NULL (not ambient)", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        workspaceScoped: false,
        profileEntityScope: undefined,
        ambientWorkspaceId: AMBIENT,
      })
    ).toBeNull();
  });

  it("resolveKindWritePin: pod kind never takes routed home", () => {
    expect(
      resolveKindWritePin({
        entityScope: "pod",
        routedWorkspaceId: AMBIENT,
      })
    ).toEqual({ targetWorkspaceId: undefined, workspaceScoped: false });
  });

  it("resolveKindWritePin: workspace kind pins to routed home", () => {
    expect(
      resolveKindWritePin({
        entityScope: "workspace",
        routedWorkspaceId: AMBIENT,
      })
    ).toEqual({ targetWorkspaceId: AMBIENT, workspaceScoped: true });
  });

  it("resolveKindWritePin: explicit target wins over pod scope", () => {
    expect(
      resolveKindWritePin({
        entityScope: "pod",
        targetWorkspaceId: AMBIENT,
      })
    ).toEqual({ targetWorkspaceId: AMBIENT, workspaceScoped: true });
  });
});

describe("resolveMaterializedEntityWorkspaceId (I3 read-back)", () => {
  const AMBIENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const EXPLICIT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("present null wins over ambient (four-door bug)", () => {
    expect(
      resolveMaterializedEntityWorkspaceId(
        { resolvedWorkspaceId: null, global: false },
        AMBIENT
      )
    ).toBeNull();
  });

  it("persisted explicit target is read back verbatim", () => {
    expect(
      resolveMaterializedEntityWorkspaceId(
        { resolvedWorkspaceId: EXPLICIT },
        AMBIENT
      )
    ).toBe(EXPLICIT);
  });

  it("legacy (no key): non-global falls back to ambient; global → null", () => {
    expect(
      resolveMaterializedEntityWorkspaceId({ global: false }, AMBIENT)
    ).toBe(AMBIENT);
    expect(
      resolveMaterializedEntityWorkspaceId({ global: true }, AMBIENT)
    ).toBeNull();
  });
});

describe("resolveWorkspacePlacement — admin/surfaceClass exclusion from candidates", () => {
  it("does not place onto a personal-typed pod-admin (systemSlug) via ontology", async () => {
    // Legacy seed bug: create-admin stamped workspaceType=personal. The door
    // must still exclude it via systemSlug, not display name.
    const db = makeDb({
      members: [WS_ADMIN],
      workspaces: [
        {
          id: WS_ADMIN,
          name: "Pod Admin",
          workspaceType: "personal",
          systemSlug: "pod-admin",
        },
      ],
      profiles: [
        {
          id: "p",
          slug: "client",
          scope: "workspace",
          workspaceId: WS_ADMIN,
        },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
    });
    // Only candidate was non-domain → no ontology survivor; falls through.
    expect(r.workspaceId).not.toBe(WS_ADMIN);
  });

  it("does not place onto surfaceClass=admin personal workspace via ontology", async () => {
    const db = makeDb({
      members: [WS_A, WS_ADMIN],
      workspaces: [
        { id: WS_A, name: "CRM", workspaceType: "personal" },
        {
          id: WS_ADMIN,
          name: "Operator Console",
          workspaceType: "personal",
          settings: { surfaceClass: "admin" },
        },
      ],
      profiles: [
        {
          id: "p",
          slug: "client",
          scope: "workspace",
          workspaceId: WS_ADMIN,
        },
      ],
    });
    const r = await resolveWorkspacePlacement(db, {
      userId: USER,
      kindSlug: "client",
    });
    expect(r.workspaceId).not.toBe(WS_ADMIN);
  });
});

// ── Ingestion-door glue (D1) — imported things route through the door, source
// workspace is a CONTEXT signal, never a hard pin. Mocks getEntityScope so the
// wiring (scope fetched → threaded into the resolver) is proven; the rung logic
// itself is covered by the resolveWorkspacePlacement suites above.
describe("resolveImportEntityPlacement (D1 ingestion glue)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pod-scope import → NULL entity, even though a source workspace was supplied", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEntityScope"
    ).mockResolvedValue("pod");
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      profiles: [
        { id: "p", slug: "person", scope: "system", workspaceId: null },
      ],
    });
    const r = await resolveImportEntityPlacement(db, {
      userId: USER,
      profileSlug: "person",
      sourceWorkspaceId: WS_A,
    });
    expect(r).toBeNull();
  });

  it("workspace-scope import stays in its ontology lens (rung 2), not hard-pinned", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEntityScope"
    ).mockResolvedValue("workspace");
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      profiles: [
        { id: "p", slug: "contact", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveImportEntityPlacement(db, {
      userId: USER,
      profileSlug: "contact",
      sourceWorkspaceId: WS_A,
    });
    expect(r).toBe(WS_A);
  });
});

// ── Graph-batch placement policy (capture.graph + import.analyze) ────────────
// Pure accept rule is the lock: deterministic hit only; never invent membership[0].
// The async helper's empty-slug short-circuit is free; rung wiring reuses the door
// suites above (ontology single-hit / multi-candidate / rung 6).
describe("acceptDeterministicGraphWorkspace (graph batch policy)", () => {
  it("accepts a definitive rung≤4 hit with empty candidates + workspaceId", () => {
    expect(
      acceptDeterministicGraphWorkspace({
        workspaceId: WS_A,
        rung: 2,
        candidates: [],
      })
    ).toBe(WS_A);
  });

  it("accepts rung 4 (relational / feeds) the same way as rung 2", () => {
    expect(
      acceptDeterministicGraphWorkspace({
        workspaceId: WS_B,
        rung: 4,
        candidates: [],
      })
    ).toBe(WS_B);
  });

  it("abstains when candidates are present (ambiguous — never picks membership[0])", () => {
    expect(
      acceptDeterministicGraphWorkspace({
        workspaceId: null,
        rung: 2,
        candidates: [
          { id: WS_A, name: "CRM" },
          { id: WS_B, name: "Sales" },
        ],
      })
    ).toBeNull();
  });

  it("abstains on rung 5 (AI proposes, never acts) even if a workspaceId slipped in", () => {
    expect(
      acceptDeterministicGraphWorkspace({
        workspaceId: WS_A,
        rung: 5,
        candidates: [{ id: WS_A, name: "CRM" }],
      })
    ).toBeNull();
  });

  it("abstains on rung 6 (no ontology signal → stay pod-wide)", () => {
    expect(
      acceptDeterministicGraphWorkspace({
        workspaceId: null,
        rung: 6,
        candidates: [],
      })
    ).toBeNull();
  });

  it("abstains when workspaceId is null even on a low rung", () => {
    expect(
      acceptDeterministicGraphWorkspace({
        workspaceId: null,
        rung: 2,
        candidates: [],
      })
    ).toBeNull();
  });
});

describe("resolveGraphWorkspaceFromSlugs", () => {
  it("returns null immediately when routingSlugs is empty (no door call needed)", async () => {
    // Empty seed — any accidental door call that hits the mock would throw or
    // return null either way; the contract under test is the short-circuit.
    const r = await resolveGraphWorkspaceFromSlugs(makeDb({}), {
      userId: USER,
      routingSlugs: [],
    });
    expect(r).toBeNull();
  });

  it("returns the ontology workspace on a deterministic single-candidate hit", async () => {
    const db = makeDb({
      members: [WS_A],
      workspaces: [{ id: WS_A, name: "CRM" }],
      profiles: [
        { id: "p", slug: "client", scope: "workspace", workspaceId: WS_A },
      ],
    });
    const r = await resolveGraphWorkspaceFromSlugs(db, {
      userId: USER,
      routingSlugs: ["client"],
    });
    expect(r).toBe(WS_A);
  });

  it("abstains (null) when the role is enabled in >1 member workspace", async () => {
    const db = makeDb({
      members: [WS_A, WS_B],
      workspaces: [
        { id: WS_A, name: "CRM" },
        { id: WS_B, name: "Sales" },
      ],
      profiles: [
        { id: "p1", slug: "client", scope: "workspace", workspaceId: WS_A },
        { id: "p2", slug: "client", scope: "workspace", workspaceId: WS_B },
      ],
    });
    const r = await resolveGraphWorkspaceFromSlugs(db, {
      userId: USER,
      routingSlugs: ["client"],
    });
    // Never invent membership[0] — multi-candidate → stay pod-wide.
    expect(r).toBeNull();
  });
});
