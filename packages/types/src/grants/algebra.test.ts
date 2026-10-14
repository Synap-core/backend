/**
 * The grant algebra, checked against its oracle `permits` over a generated
 * universe — never against hand-picked expectations alone.
 *
 * The universe is built from the grammar's own constants: every pattern the
 * grammar accepts over two subjects (one qualified, one not), two kinds and
 * six verbs (the four GRANT_ACTIONS, a gate verb, a verb in neither list),
 * and every request key over those plus an unknown kind and a kind no pattern
 * names. Pattern-level properties are checked EXHAUSTIVELY over that
 * universe; scope-level ones over seeded random scopes (pinnings include
 * null, [] and overlapping sets) against every request.
 *
 * Why not fast-check: it is not installed in synap-backend, and adding it
 * moves the shared lockfile. Exhaustive enumeration of a universe that
 * contains a witness for every dimension the grammar distinguishes is a
 * stronger check than random sampling of it; the seeded part is a plain PRNG.
 *
 * Negative control (2026-10-13): with meetPermission reverted to the earlier
 * cover-only rule (a partial overlap → nothing), "meet is complete" goes red
 * on `entity.note ∧ entity.*.read` — the defect that revoked agent keys.
 */
import { describe, expect, it } from "vitest";
import {
  covers,
  meetPermission,
  meetPermissions,
  meetScope,
  normalizePinning,
  permissionWithin,
  scopeWithin,
  type ScopeBounds,
} from "./algebra.js";
import {
  GRANT_ACTIONS,
  GRANT_GATE_ACTIONS,
  QUALIFIED_GRANT_SUBJECTS,
  parsePermission,
  permits,
  type GrantRequest,
  type GrantScope,
} from "./grammar.js";

// ── the universe ───────────────────────────────────────────────────────────
const QSUBJECT = QUALIFIED_GRANT_SUBJECTS[0];
const SUBJECTS = [QSUBJECT, "proposal"];
const KINDS = ["note", "task"];
const ACTIONS = [...GRANT_ACTIONS, GRANT_GATE_ACTIONS[0], "run"];

function grammatical(p: string): boolean {
  try {
    parsePermission(p);
    return true;
  } catch {
    return false;
  }
}

const PATTERNS: string[] = (() => {
  const out = new Set<string>(["*"]);
  for (const s of SUBJECTS) {
    out.add(s);
    // an unqualified subject's second segment is a verb; a kind there would
    // name a verb no request carries and permit nothing in this universe
    const second = s === QSUBJECT ? [...KINDS, ...ACTIONS] : ACTIONS;
    for (const x of ["*", ...second]) out.add(`${s}.${x}`);
    for (const q of ["*", ...KINDS])
      for (const a of ["*", ...ACTIONS]) out.add(`${s}.${q}.${a}`);
  }
  return [...out].filter(grammatical);
})();

/**
 * Every kind a pattern names (`entity.run` parses as the KIND run — derived,
 * so no pattern permits nothing here), a kind no pattern names, and an
 * unknown kind (null).
 */
const QUALIFIERS: Array<string | null> = [
  ...new Set(
    PATTERNS.map((p) => parsePermission(p))
      .filter((s) => s[0] === QSUBJECT && s[1] && s[1] !== "*")
      .map((s) => s[1]!)
  ),
  "other",
  null,
];

/** Request keys: subject × qualifier × verb, plus a subject no pattern names
 *  (so `*` stays wider than any finite list of named subjects). */
const KEYS: GrantRequest[] = [...SUBJECTS, "other"].flatMap((subject) =>
  (subject === QSUBJECT ? QUALIFIERS : [null]).flatMap((qualifier) =>
    ACTIONS.map((action) => ({ subject, qualifier, action }))
  )
);

const W = ["w1", "w2"];
const P = ["p1", "p2"];
const E = ["e1", "e2"];
/** Every key in every place; at most one project (see the documented limit). */
const REQUESTS: GrantRequest[] = KEYS.flatMap((k) =>
  [...W, null].flatMap((workspaceId) =>
    [[], ["p1"], ["p2"]].flatMap((projectIds) =>
      [...E, null].map((entityId) => ({
        ...k,
        workspaceId,
        projectIds,
        entityId,
      }))
    )
  )
);

const one = (p: string): GrantScope => ({ permissions: [p] });
const normalized = (s: ScopeBounds): GrantScope => ({
  permissions: s.permissions,
  workspaceIds: normalizePinning(s.workspaceIds),
  projectIds: normalizePinning(s.projectIds),
  entityIds: normalizePinning(s.entityIds),
});
const allows = (s: ScopeBounds, r: GrantRequest) => permits(normalized(s), r);

// seeded PRNG (mulberry32) — reproducible samples, no dependency
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]) =>
  xs[Math.floor(r() * xs.length)]!;
const PINNINGS = (ids: string[]) => [null, [], [ids[0]!], [ids[1]!], ids];
function scope(r: () => number): ScopeBounds {
  const n = 1 + Math.floor(r() * 3);
  return {
    permissions: Array.from({ length: n }, () => pick(r, PATTERNS)),
    workspaceIds: pick(r, PINNINGS(W)),
    projectIds: pick(r, PINNINGS(P)),
    entityIds: pick(r, PINNINGS(E)),
  };
}

const SAMPLES = 300;
const SLOW = 120_000;

describe("the universe is not vacuous", () => {
  it("holds every pattern shape and every request dimension", () => {
    expect(PATTERNS.length).toBeGreaterThan(35);
    for (const p of [
      "*",
      "entity",
      "entity.note",
      "entity.read",
      "entity.*.read",
      "entity.note.read",
      "entity.approve",
      "proposal",
      "proposal.approve",
    ])
      expect(PATTERNS).toContain(p);
    expect(
      KEYS.some((k) => k.qualifier === null && k.subject === QSUBJECT)
    ).toBe(true);
    // no pattern is vacuous here: each one permits at least one request
    for (const p of PATTERNS)
      expect([p, KEYS.some((k) => permits(one(p), k))]).toEqual([p, true]);
    expect(REQUESTS.length).toBeGreaterThan(500);
  });
});

describe(
  "pattern level — exhaustive over the universe",
  { timeout: SLOW },
  () => {
    it("meet is sound and complete: permits(meet) ⇔ permits(a) ∧ permits(b)", () => {
      const failures: string[] = [];
      for (const a of PATTERNS)
        for (const b of PATTERNS) {
          const m = meetPermission(a, b);
          if (m !== null) expect(grammatical(m)).toBe(true);
          for (const r of KEYS) {
            const both = permits(one(a), r) && permits(one(b), r);
            const met = m !== null && permits(one(m), r);
            if (both !== met)
              failures.push(
                `${a} ∧ ${b} = ${m} on ${JSON.stringify(r)}: want ${both}`
              );
          }
        }
      expect(failures.slice(0, 5)).toEqual([]);
    });

    it("covers(a, b) ⇔ every request b permits, a permits", () => {
      for (const a of PATTERNS)
        for (const b of PATTERNS) {
          const oracle = KEYS.every(
            (r) => !permits(one(b), r) || permits(one(a), r)
          );
          expect([a, b, covers(a, b)]).toEqual([a, b, oracle]);
        }
    });

    it("meet is commutative (same requests) and idempotent (a ∧ a = a)", () => {
      for (const a of PATTERNS) {
        expect(meetPermission(a, a)).toBe(a);
        for (const b of PATTERNS) {
          const ab = meetPermission(a, b);
          const ba = meetPermission(b, a);
          for (const r of KEYS)
            expect(ab !== null && permits(one(ab), r)).toBe(
              ba !== null && permits(one(ba), r)
            );
        }
      }
    });

    it("permissionWithin(p, list) ⇔ every request p permits, the list permits", () => {
      const r = rng(7);
      for (let i = 0; i < SAMPLES * 4; i++) {
        const p = pick(r, PATTERNS);
        const list = Array.from({ length: 1 + Math.floor(r() * 4) }, () =>
          pick(r, PATTERNS)
        );
        const oracle = KEYS.every(
          (k) => !permits(one(p), k) || permits({ permissions: list }, k)
        );
        expect([p, list, permissionWithin(p, list)]).toEqual([p, list, oracle]);
      }
      // random lists rarely SPLIT a pattern across verbs — build those lists:
      // p cut by each one-verb pattern, minus one cut half the time
      for (const p of PATTERNS) {
        const cuts = PATTERNS.flatMap((q) => {
          const m = meetPermission(p, q);
          return m !== null && m !== p ? [m] : [];
        });
        for (const list of [cuts, cuts.slice(1)]) {
          const oracle = KEYS.every(
            (k) => !permits(one(p), k) || permits({ permissions: list }, k)
          );
          expect([p, list, permissionWithin(p, list)]).toEqual([
            p,
            list,
            oracle,
          ]);
        }
      }
    });
  }
);

describe(
  "scope level — seeded scopes × every request",
  { timeout: SLOW },
  () => {
    it("meetScope is sound and complete (objects in at most one project)", () => {
      const r = rng(42);
      for (let i = 0; i < SAMPLES; i++) {
        const a = scope(r);
        const b = scope(r);
        const m = meetScope(a, b);
        for (const req of REQUESTS) {
          const both = allows(a, req) && allows(b, req);
          const met = m !== null && permits(m, req);
          if (both !== met) expect({ a, b, m, req, both }).toBeNull();
        }
      }
    });

    it("meetScope is commutative and idempotent", () => {
      const r = rng(43);
      for (let i = 0; i < SAMPLES; i++) {
        const a = scope(r);
        const b = scope(r);
        const ab = meetScope(a, b);
        const ba = meetScope(b, a);
        const aa = meetScope(a, a);
        for (const req of REQUESTS) {
          expect(ab !== null && permits(ab, req)).toBe(
            ba !== null && permits(ba, req)
          );
          expect(aa !== null && permits(aa, req)).toBe(allows(a, req));
        }
      }
    });

    it("scopeWithin(a, b) ⇔ every request a permits, b permits", () => {
      const r = rng(44);
      let trues = 0;
      for (let i = 0; i < SAMPLES * 2; i++) {
        const a = scope(r);
        // half the time b is a widening of a, so the TRUE branch is exercised
        const b =
          r() < 0.5
            ? scope(r)
            : {
                ...a,
                permissions: [...a.permissions, pick(r, PATTERNS)],
                projectIds: null,
              };
        const oracle = REQUESTS.every(
          (req) => !allows(a, req) || allows(b, req)
        );
        if (oracle) trues++;
        expect([a, b, scopeWithin(a, b)]).toEqual([a, b, oracle]);
      }
      expect(trues).toBeGreaterThan(SAMPLES / 4);
    });
  }
);

describe("the cases that revoked keys before (literal)", () => {
  it("a partial overlap meets at its greatest lower bound, not nothing", () => {
    expect(meetPermission("entity.note", "entity.read")).toBe(
      "entity.note.read"
    );
    expect(meetPermission("entity.note", "entity.*.read")).toBe(
      "entity.note.read"
    );
    expect(meetPermission("entity.*.read", "entity.note")).toBe(
      "entity.note.read"
    );
    expect(meetPermission("entity.note", "entity.task")).toBeNull();
    expect(meetPermission("entity.note", "entity.approve")).toBeNull();
  });

  it("a kind split into its four verbs is within them", () => {
    expect(
      permissionWithin(
        "entity.note",
        GRANT_ACTIONS.map((a) => `entity.note.${a}`)
      )
    ).toBe(true);
    expect(permissionWithin("entity", ["entity.note", "entity.task"])).toBe(
      false
    );
  });

  it("meetPermissions keeps only the maximal meets", () => {
    expect(
      meetPermissions(["entity.note"], ["entity.read", "entity.*.read"])
    ).toEqual(["entity.note.read"]);
  });

  it("KNOWN LIMIT: an object in two projects, one per side, falls outside the meet", () => {
    const a = { permissions: ["*"], projectIds: ["p1"] };
    const b = { permissions: ["*"], projectIds: ["p2"] };
    const req: GrantRequest = {
      subject: "entity",
      action: "read",
      projectIds: ["p1", "p2"],
    };
    expect(permits(a, req) && permits(b, req)).toBe(true);
    expect(meetScope(a, b)).toBeNull(); // fail closed, by design
  });
});
