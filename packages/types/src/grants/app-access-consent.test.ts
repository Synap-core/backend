/**
 * The consent SAVES a v2 access (app permissions W3d): what it may store, and
 * that what it mints is exactly what it says.
 *
 * Proven EXHAUSTIVELY over a universe of 8 640 accesses (5 permissions, 6
 * read-space choices, 5 read-project choices, 3 write-space and 3
 * write-project choices) against one ceiling, with an oracle independent of
 * the code under test: the engine's own `permits`, asked about concrete
 * requests in every space and project of the universe.
 *  1. NEVER BEYOND: an access `appAccessBeyond` lets through mints grants
 *     that permit nothing the ceiling (asked ∩ the person's floor) does not,
 *     and put the app in no place, or role, the ceiling does not.
 *  2. THE DOCUMENT IS ITS GRANTS: what such an access says (read with no
 *     pod-wide filter) permits exactly what its grants permit, no phantom
 *     (pod knowledge 557a96de).
 *  3. NOT VACUOUS: the universe holds accesses that WOULD widen, and every one
 *     of them is refused.
 * Plus: the old pairs derived from v2 are never wider and are exact when
 * they say so; the short ask only adds permissions (Q4); the token narrowing
 * compares by meaning (review finding 4 of #1196) and never widens.
 */
import { describe, expect, it } from "vitest";
import {
  addPermissionsToAccess,
  reconsentProposal,
  withoutDormantPermissions,
  appAccessBeyond,
  appAccessGivesAnything,
  ceilingScopes,
  clampAppAccess,
  documentScopes,
  grantScopesForAccess,
  liftApprovedRequests,
  normalizeAppAccess,
  pairsOfAccess,
  pairsOfRequests,
  parseAppAccess,
  parsePermission,
  parsePlace,
  permits,
  sameAppAccess,
  scopesOfPairs,
  scopesWithinBound,
  type AppAccess,
  type AppAccessCeiling,
  type GrantRequest,
} from "./index.js";

type Scope = {
  permissions: string[];
  workspaceIds?: string[];
  projectIds?: string[];
};

const A = "space-a";
const B = "space-b";
const C = "space-c"; // the person may give nothing here
const P = "proj-p";
const Q = "proj-q";
const R = "proj-r"; // the person may give nothing here

const R_NOTE = "entity.note.read"; // pod-wide readable, declared pod-wide
const R_TASK = "entity.task.read"; // pod-wide readable, declared PER SPACE
const R_TRACK = "track.read"; // declared pod-wide, but NOT a pod-wide read
const W_NOTE = "entity.note.create";
const W_UNASKED = "entity.task.create"; // never asked

const CEILING: AppAccessCeiling = {
  permissions: [R_NOTE, R_TASK, R_TRACK, W_NOTE],
  allSpacesReads: [R_NOTE, R_TRACK],
  read: { spaces: [A, B], projects: [P, Q] },
  write: { spaces: [A], projects: [P] },
};
/** "all" projects at the mint: the projects the person can see now. */
const ALL_PROJECTS = [P, Q];

/** Concrete requests (a pattern is not a request). */
const ASKED = [
  R_NOTE,
  R_TASK,
  R_TRACK,
  "entity.zz.read",
  "entity.read", // a record of unknown kind
  W_NOTE,
  W_UNASKED,
  "entity.note.update",
  "playbook.run",
];

function requestOf(
  permission: string,
  workspaceId: string | undefined,
  project: string | undefined
): GrantRequest {
  const segs = parsePermission(permission);
  const where = {
    workspaceId: workspaceId ?? null,
    projectIds: project ? [project] : null,
  };
  return segs.length === 3
    ? {
        subject: segs[0]!,
        qualifier: segs[1] === "*" ? null : segs[1]!,
        action: segs[2]!,
        ...where,
      }
    : { subject: segs[0]!, qualifier: null, action: segs[1]!, ...where };
}

/** What the engine (`permits`) answers, for every request of the universe. */
function permitsTable(scopes: readonly Scope[]): Set<string> {
  const out = new Set<string>();
  for (const p of ASKED)
    for (const ws of [A, B, C, undefined])
      for (const pj of [undefined, P, Q, R])
        if (scopes.some((s) => permits(s, requestOf(p, ws, pj))))
          out.add(`${p}@${ws ?? "-"}/${pj ?? "-"}`);
  return out;
}

/** Where scopes put the app (the app place parse), as viewer or editor. */
function placement(scopes: readonly Scope[]): Map<string, string> {
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
  return roles;
}

const subsetOf = (a: Set<string>, b: Set<string>) =>
  [...a].every((x) => b.has(x));

/** Every place of `a` is in `b` with at least its role. */
const placedWithin = (a: Map<string, string>, b: Map<string, string>) =>
  [...a].every(
    ([w, role]) => b.has(w) && (role === "viewer" || b.get(w) === "editor")
  );

function* subsets<T>(items: readonly T[]): Generator<T[]> {
  for (let mask = 0; mask < 1 << items.length; mask++)
    yield items.filter((_, i) => mask & (1 << i));
}

function* accessUniverse(
  perms: readonly string[] = [R_NOTE, R_TASK, R_TRACK, W_NOTE, W_UNASKED]
): Generator<AppAccess> {
  const readSpaces: Array<"all" | string[]> = [
    "all",
    [],
    [A],
    [B],
    [A, B],
    [C],
  ];
  const readProjects: Array<"all" | string[]> = ["all", [], [P], [Q], [R]];
  const writeSpaces = [[], [A], [B]];
  const writeProjects = [[], [P], [Q]];
  for (const permissions of subsets(perms))
    for (const rs of readSpaces)
      for (const rp of readProjects)
        for (const ws of writeSpaces)
          for (const wp of writeProjects)
            yield {
              version: 2,
              permissions,
              read: { spaces: rs, projects: rp },
              write: { spaces: ws, projects: wp },
            };
}

const mint = (access: AppAccess) =>
  grantScopesForAccess(access, { allProjects: ALL_PROJECTS });

describe("appAccessBeyond — a stored access never grants beyond asked ∩ floor (exhaustive)", () => {
  const ceilingTable = permitsTable(ceilingScopes(CEILING));
  const ceilingPlaces = placement(ceilingScopes(CEILING));
  const all = [...accessUniverse()];

  it("covers the whole universe", () => {
    expect(all.length).toBe(32 * 6 * 5 * 3 * 3);
  });

  it("every access it lets through permits only what the ceiling permits, and places the app within it", () => {
    let valid = 0;
    for (const access of all) {
      if (appAccessBeyond(access, CEILING).length > 0) continue;
      valid++;
      const grants = mint(access);
      const table = permitsTable(grants);
      if (!subsetOf(table, ceilingTable))
        throw new Error(
          `widens: ${JSON.stringify(access)} permits ${[...table].filter((x) => !ceilingTable.has(x)).join(", ")}`
        );
      if (!placedWithin(placement(grants), ceilingPlaces))
        throw new Error(`places beyond: ${JSON.stringify(access)}`);
    }
    expect(valid).toBeGreaterThan(500);
  });

  it("every access it lets through mints exactly what its document says (no phantom)", () => {
    for (const access of all) {
      if (appAccessBeyond(access, CEILING).length > 0) continue;
      const grants = permitsTable(mint(access));
      const doc = permitsTable(documentScopes(access, ALL_PROJECTS));
      if ([...doc].sort().join() !== [...grants].sort().join())
        throw new Error(
          `document ≠ grants: ${JSON.stringify(access)}: doc-only ${[...doc].filter((x) => !grants.has(x)).join(", ")}; grants-only ${[...grants].filter((x) => !doc.has(x)).join(", ")}`
        );
    }
  });

  it("is not vacuous: the universe holds accesses that would widen, and it refuses every one", () => {
    let widening = 0;
    for (const access of all) {
      const grants = mint(access);
      const widens =
        !subsetOf(permitsTable(grants), ceilingTable) ||
        !placedWithin(placement(grants), ceilingPlaces);
      const phantom =
        [...permitsTable(documentScopes(access, ALL_PROJECTS))]
          .sort()
          .join() !== [...permitsTable(grants)].sort().join();
      if (!widens && !phantom) continue;
      widening++;
      expect(appAccessBeyond(access, CEILING).length).toBeGreaterThan(0);
    }
    expect(widening).toBeGreaterThan(100);
  });

  it("names why, by rule", () => {
    const base: AppAccess = {
      version: 2,
      permissions: [R_NOTE],
      read: { spaces: [A], projects: [] },
      write: { spaces: [], projects: [] },
    };
    expect(appAccessBeyond(base, CEILING)).toEqual([]);
    expect(
      appAccessBeyond({ ...base, permissions: [W_UNASKED] }, CEILING)
    ).toEqual([
      { reason: "not-asked", permission: W_UNASKED, where: null, tier: null },
    ]);
    // Declared per space: never All spaces.
    expect(
      appAccessBeyond(
        {
          ...base,
          permissions: [R_TASK],
          read: { spaces: "all", projects: [] },
        },
        CEILING
      )
    ).toEqual([
      {
        reason: "not-all-spaces",
        permission: R_TASK,
        where: { kind: "pod" },
        tier: "read",
      },
    ]);
    // Declared pod-wide, but no pod-wide read (D1): never All spaces.
    expect(
      appAccessBeyond(
        {
          ...base,
          permissions: [R_TRACK],
          read: { spaces: "all", projects: [] },
        },
        CEILING
      ).map((b) => b.reason)
    ).toEqual(["not-all-spaces"]);
    expect(
      appAccessBeyond(
        { ...base, read: { spaces: [C], projects: [R] } },
        CEILING
      )
    ).toEqual([
      {
        reason: "not-offered",
        permission: null,
        where: { kind: "space", id: C },
        tier: "read",
      },
      {
        reason: "not-offered",
        permission: null,
        where: { kind: "project", id: R },
        tier: "read",
      },
    ]);
    // A space only read in is no write place.
    expect(
      appAccessBeyond(
        {
          ...base,
          permissions: [W_NOTE],
          write: { spaces: [B], projects: [Q] },
        },
        CEILING
      ).map((b) => [b.reason, b.tier, b.where])
    ).toEqual([
      ["not-offered", "write", { kind: "space", id: B }],
      ["not-offered", "write", { kind: "project", id: Q }],
    ]);
  });

  it("Q1: All spaces includes every project, and a reader in All spaces reads a project-only row", () => {
    const access: AppAccess = {
      version: 2,
      permissions: [R_NOTE],
      read: { spaces: "all", projects: "all" },
      write: { spaces: [], projects: [] },
    };
    expect(normalizeAppAccess(access).read.projects).toEqual([]);
    expect(appAccessBeyond(access, CEILING)).toEqual([]);
    const table = permitsTable(mint(access));
    expect(table.has(`${R_NOTE}@-/${P}`)).toBe(true);
    expect(table.has(`${R_NOTE}@${C}/-`)).toBe(true);
  });

  it('"all" projects is a live pin: every project minted now, never pod-wide', () => {
    const access: AppAccess = {
      version: 2,
      permissions: [R_TASK],
      read: { spaces: [], projects: "all" },
      write: { spaces: [], projects: [] },
    };
    expect(appAccessBeyond(access, CEILING)).toEqual([]);
    const later = grantScopesForAccess(access, { allProjects: [P, Q, R] });
    expect(later).toEqual([{ permissions: [R_TASK], projectIds: [P, Q, R] }]);
    const table = permitsTable(later);
    expect(table.has(`${R_TASK}@-/${R}`)).toBe(true); // a project made later
    expect(table.has(`${R_TASK}@${A}/-`)).toBe(false); // not pod-wide
    expect(table.has(`${R_TASK}@-/-`)).toBe(false);
    // Without the resolved list it mints nothing (fail closed).
    expect(grantScopesForAccess(access)).toEqual([]);
  });

  it("never mints a scope that mixes spaces and projects", () => {
    for (const access of all) {
      for (const s of mint(access))
        expect(
          Boolean(s.workspaceIds?.length) && Boolean(s.projectIds?.length)
        ).toBe(false);
    }
  });
});

describe("pairsOfAccess — the old pairs, for what still reads them", () => {
  it("are never wider than the access, and exact when they say so", () => {
    let exact = 0;
    for (const access of accessUniverse()) {
      if (appAccessBeyond(access, CEILING).length > 0) continue;
      const { pairs, exact: isExact } = pairsOfAccess(access);
      const fromPairs = scopesOfPairs(pairsOfRequests(pairs).pairs);
      const grants = mint(access);
      expect(subsetOf(permitsTable(fromPairs), permitsTable(grants))).toBe(
        true
      );
      if (!isExact) continue;
      exact++;
      expect([...permitsTable(fromPairs)].sort()).toEqual(
        [...permitsTable(grants)].sort()
      );
      // And the old pairs lift back to this very access (W2 readers agree).
      if (pairs.length > 0) {
        const lifted = liftApprovedRequests(pairs);
        expect("access" in lifted).toBe(true);
        if ("access" in lifted) {
          expect(
            [...permitsTable(grantScopesForAccess(lifted.access))].sort()
          ).toEqual([...permitsTable(grants)].sort());
        }
      }
    }
    expect(exact).toBeGreaterThan(50);
  });

  it("a project is never a pair: projects-only access has no pairs and is not exact", () => {
    expect(
      pairsOfAccess({
        version: 2,
        permissions: [R_NOTE, W_NOTE],
        read: { spaces: [], projects: [P] },
        write: { spaces: [], projects: [P] },
      })
    ).toEqual({ pairs: [], exact: false });
  });
});

describe("addPermissionsToAccess — the short ask only adds permissions (Q4)", () => {
  const reader: AppAccess = {
    version: 2,
    permissions: [R_NOTE],
    read: { spaces: [A], projects: [P] },
    write: { spaces: [], projects: [] },
  };

  it("adds a read where it already reads; the places do not change", () => {
    const out = addPermissionsToAccess(reader, [R_TASK]);
    expect(out).toEqual({
      access: { ...reader, permissions: [R_NOTE, R_TASK] },
    });
  });

  it("a first write with no write place needs the person's pick, and lands only there", () => {
    expect(addPermissionsToAccess(reader, [W_NOTE])).toEqual({
      needsWritePlace: true,
    });
    expect(
      addPermissionsToAccess(reader, [W_NOTE], { spaces: [], projects: [] })
    ).toEqual({ needsWritePlace: true });
    const out = addPermissionsToAccess(reader, [W_NOTE], {
      spaces: [A],
      projects: [],
    });
    expect(out).toEqual({
      access: {
        ...reader,
        permissions: [R_NOTE, W_NOTE],
        write: { spaces: [A], projects: [] },
      },
    });
  });

  it("a write place is refused when it is not the first write", () => {
    const writer: AppAccess = {
      ...reader,
      permissions: [R_NOTE, W_NOTE],
      write: { spaces: [A], projects: [] },
    };
    expect(
      addPermissionsToAccess(writer, ["entity.note.update"], {
        spaces: [A],
        projects: [],
      })
    ).toEqual({ writePlaceNotNeeded: true });
    expect(addPermissionsToAccess(writer, ["entity.note.update"])).toEqual({
      access: {
        ...writer,
        permissions: [R_NOTE, W_NOTE, "entity.note.update"],
      },
    });
  });

  it("a read with no read place has nowhere to hold", () => {
    const writer: AppAccess = {
      version: 2,
      permissions: [W_NOTE],
      read: { spaces: [], projects: [] },
      write: { spaces: [A], projects: [] },
    };
    expect(addPermissionsToAccess(writer, [R_NOTE])).toEqual({
      noReadPlace: [R_NOTE],
    });
  });

  it("what it adds stays within the ceiling when the added permission was asked and the place was given", () => {
    for (const access of accessUniverse()) {
      if (appAccessBeyond(access, CEILING).length > 0) continue;
      for (const p of CEILING.permissions) {
        const out = addPermissionsToAccess(access, [p]);
        if (!("access" in out)) continue;
        // Adding a per-space read to an All-spaces reader is refused later
        // by the ceiling, never minted silently.
        const beyond = appAccessBeyond(out.access, CEILING);
        if (beyond.length === 0) continue;
        expect(beyond.every((b) => b.reason === "not-all-spaces")).toBe(true);
      }
    }
  });
});

describe("clampAppAccess — a re-consent's pre-fill is always valid", () => {
  it("is within the ceiling for every access of the universe, and never adds a permission", () => {
    for (const access of accessUniverse()) {
      const clamped = clampAppAccess(access, CEILING);
      expect(appAccessBeyond(clamped, CEILING)).toEqual([]);
      expect(
        clamped.permissions.every((p) => access.permissions.includes(p))
      ).toBe(true);
    }
  });
});

describe("scopesWithinBound — a token narrowed by meaning (finding 4)", () => {
  const SCOPES: Scope[] = [
    { permissions: ["entity.read"], workspaceIds: [A] },
    { permissions: [R_NOTE], workspaceIds: [A, B] },
    { permissions: [R_NOTE], projectIds: [P] },
    { permissions: [W_NOTE, R_NOTE], workspaceIds: [A] },
    { permissions: [R_NOTE] },
  ];

  it("keeps entity.note.read in A beside a bound of entity.read in A (a literal key compare dropped it)", () => {
    expect(
      scopesWithinBound(
        [{ permissions: [R_NOTE], workspaceIds: [A] }],
        [{ permissions: ["entity.read"], workspaceIds: [A] }]
      )
    ).toEqual([{ permissions: [R_NOTE], workspaceIds: [A] }]);
  });

  it("splits what is only partly within: the piece in A stays, the piece in B goes", () => {
    expect(
      scopesWithinBound(
        [{ permissions: [R_NOTE], workspaceIds: [A, B] }],
        [{ permissions: [R_NOTE], workspaceIds: [A] }]
      )
    ).toEqual([{ permissions: [R_NOTE], workspaceIds: [A] }]);
  });

  it("a pod-wide read in the bound never makes a space read: the app is no member of A", () => {
    expect(
      scopesWithinBound(
        [{ permissions: [R_NOTE], workspaceIds: [A] }],
        [{ permissions: [R_NOTE] }]
      )
    ).toEqual([]);
  });

  it("is sound and complete on every pair of subsets (exhaustive)", () => {
    for (const candidates of subsets(SCOPES))
      for (const bound of subsets(SCOPES)) {
        const out = scopesWithinBound(candidates, bound);
        const t = permitsTable(out);
        // SOUND: never more than both sides.
        expect(subsetOf(t, permitsTable(candidates))).toBe(true);
        expect(subsetOf(t, permitsTable(bound))).toBe(true);
        expect(placedWithin(placement(out), placement(bound))).toBe(true);
        // COMPLETE at piece grain: one permission in one place, within the
        // bound by the oracle, is kept.
        for (const c of candidates)
          for (const permission of c.permissions) {
            const places = c.workspaceIds?.length
              ? c.workspaceIds.map((id) => ({ workspaceIds: [id] }))
              : c.projectIds?.length
                ? c.projectIds.map((id) => ({ projectIds: [id] }))
                : [{}];
            for (const place of places) {
              const piece = [{ permissions: [permission], ...place }];
              if (
                subsetOf(permitsTable(piece), permitsTable(bound)) &&
                placedWithin(placement(piece), placement(bound))
              )
                expect(subsetOf(permitsTable(piece), t)).toBe(true);
            }
          }
      }
  });
});

describe("normalizeAppAccess / parseAppAccess / appAccessGivesAnything", () => {
  it("All spaces stores no project list; ids and permissions once", () => {
    const parsed = parseAppAccess({
      version: 2,
      permissions: [R_NOTE, R_NOTE],
      read: { spaces: "all", projects: [P] },
      write: { spaces: [A, A], projects: [] },
    });
    expect(parsed).toEqual({
      version: 2,
      permissions: [R_NOTE],
      read: { spaces: "all", projects: [] },
      write: { spaces: [A], projects: [] },
    });
    expect(
      sameAppAccess(parsed!, {
        version: 2,
        permissions: [R_NOTE],
        read: { spaces: "all", projects: "all" },
        write: { spaces: [A], projects: [] },
      })
    ).toBe(true);
  });

  it("gives anything only with a permission in a place of its tier", () => {
    const none: AppAccess = {
      version: 2,
      permissions: [W_NOTE],
      read: { spaces: [A], projects: [] },
      write: { spaces: [], projects: [] },
    };
    expect(appAccessGivesAnything(none)).toBe(false);
    expect(
      appAccessGivesAnything({ ...none, write: { spaces: [], projects: [P] } })
    ).toBe(true);
    expect(
      appAccessGivesAnything({
        ...none,
        permissions: [R_NOTE],
        read: { spaces: [], projects: "all" },
      })
    ).toBe(true);
  });
});

describe("appAccessBeyond — ceiling variants (review of #1197)", () => {
  const variants: Array<[string, AppAccessCeiling, string[]]> = [
    [
      "an empty floor (no space, no project to give)",
      {
        ...CEILING,
        read: { spaces: [], projects: [] },
        write: { spaces: [], projects: [] },
      },
      [R_NOTE, R_TASK, W_NOTE, W_UNASKED],
    ],
    [
      "no projects at all (all projects mints nothing)",
      {
        ...CEILING,
        read: { spaces: [A, B], projects: [] },
        write: { spaces: [A], projects: [] },
      },
      [R_NOTE, R_TASK, W_NOTE, W_UNASKED],
    ],
    [
      "wildcards asked: *, entity.*.read, entity.read declared pod-wide",
      {
        permissions: ["*", "entity.*.read", "entity.read"],
        allSpacesReads: ["entity.*.read", "entity.read"],
        read: { spaces: [A, B], projects: [P, Q] },
        write: { spaces: [A], projects: [P] },
      },
      ["*", "entity.*.read", "entity.read", W_UNASKED],
    ],
  ];
  it.each(variants)("%s: never beyond, no phantom", (_label, ceiling, perms) => {
    const allProjects = [...ceiling.read.projects];
    const mintIt = (a: AppAccess) => grantScopesForAccess(a, { allProjects });
    const ceilingTable = permitsTable(ceilingScopes(ceiling));
    const ceilingPlaces = placement(ceilingScopes(ceiling));
    let valid = 0;
    for (const access of accessUniverse(perms)) {
      if (appAccessBeyond(access, ceiling).length > 0) continue;
      valid++;
      const grants = mintIt(access);
      const table = permitsTable(grants);
      if (
        !subsetOf(table, ceilingTable) ||
        !placedWithin(placement(grants), ceilingPlaces)
      )
        throw new Error(`widens: ${JSON.stringify(access)}`);
      const doc = permitsTable(documentScopes(access, allProjects));
      if ([...doc].sort().join() !== [...table].sort().join())
        throw new Error(`phantom: ${JSON.stringify(access)}`);
    }
    expect(valid).toBeGreaterThan(0);
  });
});

describe("withoutDormantPermissions — Q4 never switches on a stored dormant write", () => {
  it("a write stored with no write place is dropped, and a first write place switches on only what the ask adds", () => {
    const dormant: AppAccess = {
      version: 2,
      permissions: [R_NOTE, W_NOTE],
      read: { spaces: [A], projects: [] },
      write: { spaces: [], projects: [] },
    };
    expect(withoutDormantPermissions(dormant).permissions).toEqual([R_NOTE]);
    expect(
      addPermissionsToAccess(dormant, ["entity.note.update"], {
        spaces: [A],
        projects: [],
      })
    ).toEqual({
      access: {
        ...dormant,
        permissions: [R_NOTE, "entity.note.update"],
        write: { spaces: [A], projects: [] },
      },
    });
  });
});

describe("reconsentProposal — a re-consent pre-fill is never wider than the old pairs (exhaustive)", () => {
  const universe = [R_NOTE, R_TASK, W_NOTE].flatMap((permission) =>
    [A, B, null].map((workspaceId) => ({ permission, workspaceId }))
  );
  it("on every subset, with and without the ceiling", () => {
    let nonEmpty = 0;
    for (const rows of subsets(universe)) {
      const { pairs } = pairsOfRequests(rows);
      const before = scopesOfPairs(pairs);
      for (const ceiling of [null, CEILING]) {
        const proposed = reconsentProposal(pairs, ceiling);
        if (proposed.permissions.length > 0) nonEmpty++;
        const after = grantScopesForAccess(proposed);
        if (!subsetOf(permitsTable(after), permitsTable(before)))
          throw new Error(`widens: ${JSON.stringify(rows)}`);
        expect(placedWithin(placement(after), placement(before))).toBe(true);
        if (ceiling) expect(appAccessBeyond(proposed, ceiling)).toEqual([]);
      }
    }
    expect(nonEmpty).toBeGreaterThan(100);
  });

  it("keeps what the pairs hold exactly; drops what one place does not hold", () => {
    expect(
      reconsentProposal(
        pairsOfRequests([
          { permission: R_NOTE, workspaceId: A },
          { permission: R_NOTE, workspaceId: B },
        ]).pairs
      )
    ).toEqual({
      version: 2,
      permissions: [R_NOTE],
      read: { spaces: [A, B], projects: [] },
      write: { spaces: [], projects: [] },
    });
    // Notes in A and tasks in B: neither in both, so neither is pre-filled.
    expect(
      reconsentProposal(
        pairsOfRequests([
          { permission: R_NOTE, workspaceId: A },
          { permission: R_TASK, workspaceId: B },
        ]).pairs
      ).permissions
    ).toEqual([]);
  });
});
