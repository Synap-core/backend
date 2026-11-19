/**
 * AppAccess v2 — the lift from the old pairs, the grants it makes, and the
 * v2-against-v2 comparison (app permissions W2, decision 51ad8d1e).
 *
 * The lift must NEVER widen and never narrow. Proven two ways,
 * independently of the lift's own check:
 *  - EXHAUSTIVELY, on every subset of four small pair universes (wildcards
 *    and subsumption included: `*`, `entity.read`, `entity.<kind>.read`,
 *    pod-wide reads beside the same reads per space): a lifted connection's
 *    grants (`grantScopesForAccess`) permit exactly the requests the
 *    per-space grants of its pairs permit (`legacyGrants` below is the pre-W2
 *    `grantsForApprovedRequests`, copied), asked through the engine's own
 *    oracle (`permits`), and put the app in exactly the same spaces as viewer
 *    or editor, read through the app's place parse (`parsePlace`);
 *  - and every refused lift really would have changed a permit or a place
 *    (the re-consent is never over-eager), on every universe (W3c: the lift
 *    compares by meaning, so subsumption no longer re-consents).
 * Each table row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  accessPairKey,
  appAccessWithin,
  candidateAccess,
  expandAppAccess,
  grantScopesForAccess,
  isPodWideReadPermission,
  KindsRequestError,
  liftApprovedRequests,
  pairsOfRequests,
  parseAppAccess,
  parsePermission,
  parsePlace,
  parseRequestPlace,
  permissionsForKinds,
  permissionWithin,
  permits,
  PlaceError,
  sameAppAccess,
  type AppAccess,
  type GrantRequest,
} from "./index.js";

type Pair = { permission: string; workspaceId: string | null };
type Scope = {
  permissions: string[];
  workspaceIds?: string[];
  projectIds?: string[];
};

const A = "space-a";
const B = "space-b";
const C = "space-c"; // never approved: a request there is always outside

const R_NOTE = "entity.note.read"; // pod-wide readable
const R_TASK = "entity.task.read"; // pod-wide readable
const R_TRACK = "track.read"; // a read, NOT on the pod-wide list
const W_NOTE = "entity.note.create";
const W_TASK = "entity.task.update";

/** The pre-W2 `grantsForApprovedRequests` (services/app-connect.ts), verbatim in logic. */
function legacyGrants(approved: readonly Pair[]): Scope[] {
  const byWorkspace = new Map<string, Set<string>>();
  const podWide = new Set<string>();
  for (const r of approved) {
    let place: ReturnType<typeof parseRequestPlace>;
    try {
      place = parseRequestPlace(r, "app");
    } catch (err) {
      if (err instanceof PlaceError) continue;
      throw err;
    }
    if (place.kind === "spaces") {
      const perms = byWorkspace.get(place.ids[0]) ?? new Set<string>();
      perms.add(r.permission);
      byWorkspace.set(place.ids[0], perms);
    } else if (place.kind === "pod") podWide.add(r.permission);
  }
  const grants: Scope[] = [...byWorkspace].map(([workspaceId, perms]) => ({
    permissions: [...perms],
    workspaceIds: [workspaceId],
  }));
  if (podWide.size > 0) grants.push({ permissions: [...podWide] });
  return grants;
}

/** The grants an approval makes after W2: v2 when it lifts, else per space. */
function w2Grants(approved: readonly Pair[]): Scope[] {
  const lifted = liftApprovedRequests(approved);
  return "access" in lifted
    ? grantScopesForAccess(lifted.access)
    : legacyGrants(approved);
}

function requestOf(permission: string, workspaceId?: string): GrantRequest {
  const segs = parsePermission(permission);
  return segs.length === 3
    ? {
        subject: segs[0]!,
        qualifier: segs[1] === "*" ? null : segs[1]!,
        action: segs[2]!,
        workspaceId,
      }
    : { subject: segs[0]!, qualifier: null, action: segs[1]!, workspaceId };
}

/** What the engine (`permits`) answers, for every request of the universe. */
function permitsTable(scopes: readonly Scope[], perms: readonly string[]) {
  const out: string[] = [];
  for (const p of perms)
    for (const ws of [A, B, C, undefined])
      if (scopes.some((s) => permits(s, requestOf(p, ws))))
        out.push(`${p}@${ws ?? "-"}`);
  return out.sort();
}

/**
 * Where the app is PUT, read the way the app doors read a scope
 * (`parsePlace`): each space or project it is in, as `viewer` when it only
 * reads there and `editor` otherwise (`syncAppAgentMemberships`), and the pod
 * (or "unbounded") for a scope with no space. A pod-wide read permits a read
 * in A without making the app a member of A, so this is checked beside the
 * permits.
 */
function placement(scopes: readonly Scope[]) {
  const roles = new Map<string, string>();
  for (const s of scopes) {
    const place = parsePlace(s, "app");
    const where =
      place.kind === "spaces" || place.kind === "projects"
        ? place.ids.map((id) => `${place.kind}:${id}`)
        : [place.kind];
    const writes = s.permissions.some(
      (p) => parsePermission(p).at(-1) !== "read"
    );
    for (const w of where)
      if (roles.get(w) !== "editor") roles.set(w, writes ? "editor" : "viewer");
  }
  return [...roles].map(([w, r]) => `${w}=${r}`).sort();
}

/** Same reach: the same permits and the same placement. */
const sameReach = (a: readonly Scope[], b: readonly Scope[]) =>
  JSON.stringify(permitsTable(a, ASKED)) ===
    JSON.stringify(permitsTable(b, ASKED)) &&
  JSON.stringify(placement(a)) === JSON.stringify(placement(b));

function* subsets<T>(items: readonly T[]): Generator<T[]> {
  for (let mask = 0; mask < 1 << items.length; mask++)
    yield items.filter((_, i) => mask & (1 << i));
}

const universe = (perms: string[]) =>
  perms.flatMap((permission) =>
    [A, B, null].map((workspaceId) => ({ permission, workspaceId }))
  );

/**
 * Concrete requests the engine is asked about (a pattern like `*` is no
 * request): every named kind, an unnamed kind (`entity.zz.read`), a record of
 * unknown kind (`entity.read` asks with no kind), each action, a gate verb.
 */
const ASKED = [
  R_NOTE,
  R_TASK,
  "entity.zz.read",
  "entity.read",
  R_TRACK,
  W_NOTE,
  W_TASK,
  "entity.note.update",
  "entity.task.delete",
  "entity.note.merge",
  "playbook.run",
];
const R_ALL_KINDS = "entity.read"; // a read, pod-wide readable, covers R_NOTE
const FULL = "*"; // a write by tier (its action is not `read`), covers everything

/** Did the pre-W3c lift (exact keys) refuse this approval? */
function keyLiftRefuses(approved: readonly Pair[]): boolean {
  const { pairs, unplaceable } = pairsOfRequests(approved);
  const held = new Set(pairs.map(accessPairKey));
  const allowed = expandAppAccess(candidateAccess(pairs)).map(accessPairKey);
  return (
    unplaceable.length > 0 ||
    allowed.some((k) => !held.has(k)) ||
    held.size !== new Set(allowed).size
  );
}

describe("liftApprovedRequests — never wider, never narrower (exhaustive)", () => {
  for (const [label, perms, subsumption] of [
    ["reads, one not pod-wide, and a write", [R_NOTE, R_TASK, R_TRACK, W_NOTE], false],
    ["two writes and a read", [R_NOTE, W_NOTE, W_TASK], false],
    // Wildcards and subsumption (review of #1183, W3c): `*` is a write and
    // holds where `write` says, so the tiers never mix through it;
    // `entity.read` beside `entity.note.read` adds nothing.
    ["wildcards: entity.read, entity.note.read and *", [R_ALL_KINDS, R_NOTE, FULL], true],
    // Pod-wide reads beside the same reads per space (synap-chat's shape),
    // where the app also writes, and where it does not.
    ["pod-wide and per-space reads beside a write: entity.read, entity.note.read, entity.note.create", [R_ALL_KINDS, R_NOTE, W_NOTE], true],
  ] as const) {
    it(`every subset of ${label} × {A, B, pod}: same permits, same placement`, () => {
      let lifted = 0;
      let reconsent = 0;
      let liftedByMeaning = 0;
      for (const approved of subsets(universe([...perms]))) {
        const before = legacyGrants(approved);
        const after = w2Grants(approved);
        const ctx = JSON.stringify(approved);
        expect(permitsTable(after, ASKED), ctx).toEqual(
          permitsTable(before, ASKED)
        );
        expect(placement(after), ctx).toEqual(placement(before));
        const result = liftApprovedRequests(approved);
        if ("access" in result) {
          lifted += 1;
          if (keyLiftRefuses(approved)) liftedByMeaning += 1;
          expect(
            grantScopesForAccess(result.access).length
          ).toBeLessThanOrEqual(4);
          // `*` never holds in a read place, a read never in a write place.
          for (const s of grantScopesForAccess(result.access))
            if (s.permissions.includes(FULL))
              expect(s.workspaceIds ?? [], ctx).toEqual(
                expect.arrayContaining([...result.access.write.spaces])
              );
        } else {
          reconsent += 1;
          // Never over-eager, on every universe: the naive v2 really would
          // change a permit or a placement, or a row no app may hold is there.
          const naive = grantScopesForAccess(
            candidateAccess(pairsOfRequests(approved).pairs)
          );
          const changes =
            result.reconsent.unplaceable > 0 || !sameReach(naive, before);
          expect(changes, ctx).toBe(true);
          // And the reason names a real difference.
          if (result.reconsent.reason !== "unplaceable")
            expect(
              result.reconsent.widens.length + result.reconsent.narrows.length,
              ctx
            ).toBeGreaterThan(0);
        }
      }
      // Non-vacuity: both outcomes happen.
      expect(lifted).toBeGreaterThan(10);
      expect(reconsent).toBeGreaterThan(10);
      // The subsumption universes hold rows the key comparison refused and
      // the meaning lifts (the over-eager rows of #1189).
      if (subsumption) expect(liftedByMeaning).toBeGreaterThan(1);
    });
  }

  // The over-eager rows #1189 pinned now lift, with grants that say the same.
  it.each([
    [
      "entity.read in A and B + entity.note.read in B",
      [
        { permission: R_ALL_KINDS, workspaceId: A },
        { permission: R_ALL_KINDS, workspaceId: B },
        { permission: R_NOTE, workspaceId: B },
      ],
      [{ permissions: [R_ALL_KINDS, R_NOTE], workspaceIds: [A, B] }],
    ],
    [
      "entity.read + entity.note.read in A, entity.read in B",
      [
        { permission: R_ALL_KINDS, workspaceId: A },
        { permission: R_NOTE, workspaceId: A },
        { permission: R_ALL_KINDS, workspaceId: B },
      ],
      [{ permissions: [R_ALL_KINDS, R_NOTE], workspaceIds: [A, B] }],
    ],
    [
      "entity.note.read pod-wide and in A, where it also writes",
      [
        { permission: R_NOTE, workspaceId: null },
        { permission: R_NOTE, workspaceId: A },
        { permission: W_NOTE, workspaceId: A },
      ],
      [
        { permissions: [R_NOTE] },
        { permissions: [W_NOTE], workspaceIds: [A] },
      ],
    ],
  ] as const)("now lifts: %s", (_label, approved, grants) => {
    expect(keyLiftRefuses(approved)).toBe(true);
    const r = liftApprovedRequests(approved);
    expect("access" in r && grantScopesForAccess(r.access)).toEqual(grants);
    expect(sameReach(w2Grants(approved), legacyGrants(approved))).toBe(true);
  });

  // Rules out: subsumption read as "anything a pattern covers lifts".
  it("still refuses a real widening: entity.read in A + entity.note.read in B", () => {
    const r = liftApprovedRequests([
      { permission: R_ALL_KINDS, workspaceId: A },
      { permission: R_NOTE, workspaceId: B },
    ]);
    expect("reconsent" in r && r.reconsent.reason).toBe("widens");
    if ("reconsent" in r)
      expect(r.reconsent.widens.map(accessPairKey)).toContain(
        `space:${B}\u0000${R_ALL_KINDS}`
      );
  });

  // Rules out: a pod-wide read standing in for a space the app only reads.
  it("still refuses to drop a space only read in: entity.note.read pod-wide and in A, no write", () => {
    const r = liftApprovedRequests([
      { permission: R_NOTE, workspaceId: null },
      { permission: R_NOTE, workspaceId: A },
    ]);
    expect("reconsent" in r && r.reconsent).toMatchObject({
      reason: "narrows",
      widens: [],
      narrows: [{ permission: R_NOTE, where: { kind: "space", id: A } }],
    });
  });

  it("* in a space and a read elsewhere: the tiers stay apart", () => {
    const r = liftApprovedRequests([
      { permission: FULL, workspaceId: A },
      { permission: R_NOTE, workspaceId: B },
    ]);
    expect("access" in r && grantScopesForAccess(r.access)).toEqual([
      { permissions: [R_NOTE], workspaceIds: [B] },
      { permissions: [FULL], workspaceIds: [A] },
    ]);
  });
});

describe("liftApprovedRequests — table", () => {
  const lift = (...pairs: Pair[]) => liftApprovedRequests(pairs);

  // Rules out: one union of spaces for both tiers. Reads and writes each
  // union their OWN spaces, so the brief's example does not widen here.
  it("read A in Sales + write B in Finance lifts exactly (each tier its own spaces)", () => {
    const r = lift(
      { permission: R_NOTE, workspaceId: A },
      { permission: W_TASK, workspaceId: B }
    );
    expect(r).toEqual({
      access: {
        version: 2,
        permissions: [R_NOTE, W_TASK],
        read: { spaces: [A], projects: [] },
        write: { spaces: [B], projects: [] },
      },
    });
  });

  // Rules out: the plan's widening, "write B in Sales too".
  it("two writes in two spaces each in one only: re-consent (would widen)", () => {
    const r = lift(
      { permission: W_NOTE, workspaceId: A },
      { permission: W_TASK, workspaceId: B }
    );
    expect("reconsent" in r && r.reconsent.reason).toBe("widens");
    if ("reconsent" in r)
      expect(r.reconsent.widens.map(accessPairKey).sort()).toEqual(
        [`space:${A}\u0000${W_TASK}`, `space:${B}\u0000${W_NOTE}`].sort()
      );
  });

  it("read notes in Sales + read tasks in Finance: re-consent (would read notes in Finance)", () => {
    const r = lift(
      { permission: R_NOTE, workspaceId: A },
      { permission: R_TASK, workspaceId: B }
    );
    expect("reconsent" in r && r.reconsent.reason).toBe("widens");
  });

  // Rules out: "all" dropping a per-space read (or keeping track.read pod-wide).
  it("a pod-wide read beside a space read of another kind: re-consent", () => {
    const r = lift(
      { permission: R_NOTE, workspaceId: null },
      { permission: R_TASK, workspaceId: A }
    );
    expect("reconsent" in r && r.reconsent.reason).toBe("widens");
  });

  it("a pod-wide read beside the same read in a space: re-consent (would lose the space read)", () => {
    const r = lift(
      { permission: R_NOTE, workspaceId: null },
      { permission: R_NOTE, workspaceId: A }
    );
    expect("reconsent" in r && r.reconsent.reason).toBe("narrows");
  });

  it("a row no app may hold (a write with no space): re-consent, as unplaceable", () => {
    const r = lift(
      { permission: R_NOTE, workspaceId: A },
      { permission: W_NOTE, workspaceId: null }
    );
    expect("reconsent" in r && r.reconsent).toMatchObject({
      reason: "unplaceable",
      unplaceable: 1,
    });
  });

  it("uniform per-space rows (Content Studio, CRM) lift into one scope", () => {
    const pairs = [A, B].flatMap((ws) =>
      [R_NOTE, W_NOTE].map((permission) => ({ permission, workspaceId: ws }))
    );
    const r = liftApprovedRequests(pairs);
    expect("access" in r).toBe(true);
    if ("access" in r)
      expect(grantScopesForAccess(r.access)).toEqual([
        { permissions: [R_NOTE, W_NOTE], workspaceIds: [A, B] },
      ]);
  });

  it("pod-wide reads + writes in a space (a chat app) lift: All reads, writes Select", () => {
    const r = lift(
      { permission: R_NOTE, workspaceId: null },
      { permission: R_TASK, workspaceId: null },
      { permission: W_NOTE, workspaceId: A }
    );
    expect(r).toEqual({
      access: {
        version: 2,
        permissions: [R_NOTE, R_TASK, W_NOTE],
        read: { spaces: "all", projects: [] },
        write: { spaces: [A], projects: [] },
      },
    });
    if ("access" in r)
      expect(grantScopesForAccess(r.access)).toEqual([
        { permissions: [R_NOTE, R_TASK] },
        { permissions: [W_NOTE], workspaceIds: [A] },
      ]);
  });

  // synap-chat as it asks today (site.config.ts, 18 Nov 2026): 36 reads
  // pod-wide (7 subjects, 29 kinds), and in each chosen space 5 reads
  // (entity.read, document.read, relation.read, track.read, agent.read) and
  // 3 acts. v2 holds ONE read place for all of a connection's reads, and
  // these reads sit at two widths, so neither fits: "all" spaces would read
  // every kind, document and relation everywhere (entity.read & co. are
  // pod-wide readable: WIDENS), and would drop track.read and agent.read,
  // which are not (NARROWS); a list of spaces would drop the 36 pod-wide
  // reads everywhere else. It re-consents, by meaning, not by key.
  it("synap-chat's shape re-consents: it reads at two widths", () => {
    const kinds = Array.from({ length: 29 }, (_, i) => `kind${i}`);
    const podReads = [
      ...["playbook", "session", "proposal", "automation", "view", "channel", "project"].map(
        (s) => `${s}.read`
      ),
      ...kinds.map((k) => `entity.${k}.read`),
    ];
    const perSpace = [
      "playbook.run",
      "session.update",
      "agent.read",
      "track.read",
      "entity.read",
      "document.read",
      "relation.read",
      "chat.stream",
    ];
    const r = lift(
      ...podReads.map((permission) => ({ permission, workspaceId: null })),
      ...[A, B].flatMap((ws) =>
        perSpace.map((permission) => ({ permission, workspaceId: ws }))
      )
    );
    expect("reconsent" in r && r.reconsent.reason).toBe("widens");
    if (!("reconsent" in r)) return;
    expect(r.reconsent.widens).toContainEqual({
      permission: "entity.read",
      where: { kind: "pod" },
    });
    expect(r.reconsent.narrows).toContainEqual({
      permission: "track.read",
      where: { kind: "space", id: A },
    });
  });

  it("nothing approved lifts to nothing", () => {
    const r = lift();
    expect("access" in r && grantScopesForAccess(r.access)).toEqual([]);
  });
});

describe("grantScopesForAccess — v2 with projects (no lift makes one yet)", () => {
  const access = (over: Partial<AppAccess>): AppAccess => ({
    version: 2,
    permissions: [R_NOTE, W_NOTE],
    read: { spaces: [], projects: [] },
    write: { spaces: [], projects: [] },
    ...over,
  });

  it("emits at most four scopes: reads/writes × spaces/projects", () => {
    expect(
      grantScopesForAccess(
        access({
          read: { spaces: [A], projects: ["p1"] },
          write: { spaces: [B], projects: ["p2"] },
        })
      )
    ).toEqual([
      { permissions: [R_NOTE], workspaceIds: [A] },
      { permissions: [W_NOTE], workspaceIds: [B] },
      { permissions: [R_NOTE], projectIds: ["p1"] },
      { permissions: [W_NOTE], projectIds: ["p2"] },
    ]);
  });

  // Rules out: one scope carrying both workspaceIds and projectIds. Inside a
  // scope `permits` ANDs its limits (the intersection); F3 is a UNION, which
  // only separate scopes (ORed) give.
  it("spaces [A] and projects [P] are a union: a row in A only and a row in P only are both permitted", () => {
    const scopes = grantScopesForAccess(
      access({
        read: { spaces: [A], projects: ["P"] },
        write: { spaces: [A], projects: ["P"] },
      })
    );
    for (const s of scopes)
      expect(s.workspaceIds && s.projectIds, JSON.stringify(s)).toBeFalsy();
    for (const permission of [R_NOTE, W_NOTE]) {
      const req = requestOf(permission);
      const inAOnly = { ...req, workspaceId: A, projectIds: ["Q"] };
      const inPOnly = { ...req, workspaceId: B, projectIds: ["P"] };
      const inNeither = { ...req, workspaceId: B, projectIds: ["Q"] };
      expect(
        scopes.some((s) => permits(s, inAOnly)),
        permission
      ).toBe(true);
      expect(
        scopes.some((s) => permits(s, inPOnly)),
        permission
      ).toBe(true);
      expect(
        scopes.some((s) => permits(s, inNeither)),
        permission
      ).toBe(false);
    }
  });

  it("no v2 access ever mints a scope with both spaces and projects", () => {
    const lists: Array<"all" | string[]> = ["all", [], [A], [A, B]];
    const plists: Array<"all" | string[]> = ["all", [], ["P"], ["P", "Q"]];
    for (const rs of lists)
      for (const rp of plists)
        for (const ws of lists.filter((l): l is string[] => l !== "all"))
          for (const wp of plists.filter((l): l is string[] => l !== "all"))
            for (const s of grantScopesForAccess(
              access({
                read: { spaces: rs, projects: rp },
                write: { spaces: ws, projects: wp },
              })
            ))
              expect(Boolean(s.workspaceIds && s.projectIds)).toBe(false);
  });

  it('"only project X": no space at all, the project pinned', () => {
    expect(
      grantScopesForAccess(
        access({
          read: { spaces: [], projects: ["px"] },
          write: { spaces: [], projects: ["px"] },
        })
      )
    ).toEqual([{ permissions: [R_NOTE, W_NOTE], projectIds: ["px"] }]);
  });

  // Rules out: "all" reads granting a read that is not on the pod-wide list.
  it("All reads hold only the pod-wide reads; another read is not granted pod-wide", () => {
    expect(
      grantScopesForAccess(
        access({
          permissions: [R_NOTE, R_TRACK],
          read: { spaces: "all", projects: [] },
        })
      )
    ).toEqual([{ permissions: [R_NOTE] }]);
    expect(isPodWideReadPermission(R_TRACK)).toBe(false);
  });

  // Rules out: "all projects" read as the pod.
  it('"all" projects makes no scope yet (fail closed until the engine pins every project)', () => {
    expect(
      grantScopesForAccess(
        access({ permissions: [R_NOTE], read: { spaces: [], projects: "all" } })
      )
    ).toEqual([]);
  });

  it("splits a list past 64 ids (the grant door's limit)", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `s${i}`);
    const scopes = grantScopesForAccess(
      access({
        permissions: [R_NOTE],
        read: { spaces: ids, projects: [] },
      })
    );
    expect(scopes.map((s) => s.workspaceIds?.length)).toEqual([64, 6]);
  });
});

describe("appAccessWithin — v2 against v2, place by place", () => {
  const legacyWithin = (approved: Pair[], asked: Pair[]) =>
    approved.every((a) =>
      permissionWithin(
        a.permission,
        asked
          .filter((b) => b.workspaceId === a.workspaceId)
          .map((b) => b.permission)
      )
    );

  it("equals the pair comparison whenever both sides lift (exhaustive)", () => {
    const u = universe([R_NOTE, W_NOTE]);
    let compared = 0;
    for (const approved of subsets(u))
      for (const asked of subsets(u)) {
        const a = liftApprovedRequests(approved);
        const b = liftApprovedRequests(asked);
        if (!("access" in a) || !("access" in b)) continue;
        compared += 1;
        expect(
          appAccessWithin(a.access, b.access),
          JSON.stringify({ approved, asked })
        ).toBe(legacyWithin(approved, asked));
      }
    expect(compared).toBeGreaterThan(100);
  });

  // Rules out: a pod-wide ask covering a read in one space (a membership).
  it("a pod-wide ask never covers the same read in one space", () => {
    const all: AppAccess = {
      version: 2,
      permissions: [R_NOTE],
      read: { spaces: "all", projects: [] },
      write: { spaces: [], projects: [] },
    };
    const inA: AppAccess = { ...all, read: { spaces: [A], projects: [] } };
    expect(appAccessWithin(all, all)).toBe(true);
    expect(appAccessWithin(inA, all)).toBe(false);
  });

  it("a project ask covers the same project only", () => {
    const inP = (p: string): AppAccess => ({
      version: 2,
      permissions: [W_NOTE],
      read: { spaces: [], projects: [] },
      write: { spaces: [], projects: [p] },
    });
    expect(appAccessWithin(inP("p1"), inP("p1"))).toBe(true);
    expect(appAccessWithin(inP("p2"), inP("p1"))).toBe(false);
  });
});

describe("parseAppAccess — a stored v2, or nothing", () => {
  const ok = {
    version: 2,
    permissions: [R_NOTE],
    read: { spaces: "all", projects: [] },
    write: { spaces: [A], projects: [] },
  };
  it("reads a whole v2 access", () => {
    expect(parseAppAccess(ok)).toEqual(ok);
    expect(sameAppAccess(parseAppAccess(ok)!, ok as AppAccess)).toBe(true);
  });
  it.each([
    ["null", null],
    ["another version", { ...ok, version: 3 }],
    ["writes that say all", { ...ok, write: { spaces: "all", projects: [] } }],
    [
      "write projects that say all",
      { ...ok, write: { spaces: [], projects: "all" } },
    ],
    ["a blank id", { ...ok, read: { spaces: [""], projects: [] } }],
    ["a missing tier", { version: 2, permissions: [R_NOTE], read: ok.read }],
    ["permissions that are not strings", { ...ok, permissions: [1] }],
  ])("refuses %s", (_label, raw) => {
    expect(parseAppAccess(raw)).toBeNull();
  });
});

describe("expandAppAccess", () => {
  it("each permission in its tier's places, once", () => {
    const keys = expandAppAccess({
      version: 2,
      permissions: [R_NOTE, W_NOTE, W_NOTE],
      read: { spaces: "all", projects: ["p"] },
      write: { spaces: [A], projects: [] },
    }).map(accessPairKey);
    expect(keys.sort()).toEqual(
      [
        `pod\u0000${R_NOTE}`,
        `project:p\u0000${R_NOTE}`,
        `space:${A}\u0000${W_NOTE}`,
      ].sort()
    );
  });
});

describe("permissionsForKinds (F4)", () => {
  it("spells one per-kind permission per kind, each once", () => {
    expect(
      permissionsForKinds("entity.read", ["note", "task", "note"])
    ).toEqual(["entity.note.read", "entity.task.read"]);
    expect(permissionsForKinds("entity.create", ["deal"])).toEqual([
      "entity.deal.create",
    ]);
  });
  it.each([
    ["a kind-specific permission", "entity.note.read", ["task"]],
    ["another subject", "playbook.read", ["x"]],
    ["every action", "entity.*", ["note"]],
    ["no kinds", "entity.read", []],
    ["a kind that is no slug", "entity.read", ["Note"]],
    ["a kind that is no string", "entity.read", [null]],
  ])("refuses %s", (_label, permission, kinds) => {
    expect(() => permissionsForKinds(permission, kinds)).toThrow(
      KindsRequestError
    );
  });
});
