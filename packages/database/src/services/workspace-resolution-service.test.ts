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
} from "./workspace-resolution-service.js";
import { ProfileResolutionService } from "./profile-resolution-service.js";

const USER = "user-1";
const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface Seed {
  members?: string[];
  workspaces?: {
    id: string;
    name: string;
    workspaceType?: string | null;
    archivedAt?: Date | null;
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

  it("confident hint over candidates → moves (rung 5)", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_B, confidence: 0.9 },
      mode: "auto",
    });
    expect(r).toMatchObject({ workspaceId: WS_B, rung: 5 });
  });

  it("below-gate hint → abstains, falls to rung 6, candidates preserved", async () => {
    const r = await resolveWorkspacePlacement(twoCandidateDb(), {
      userId: USER,
      kindSlug: "client",
      ambientWorkspaceId: WS_A,
      aiHint: { workspaceId: WS_B, confidence: 0.3 },
      mode: "auto",
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
