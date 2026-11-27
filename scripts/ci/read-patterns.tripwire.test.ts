/**
 * TRIPWIRE (per-file ratchet) — three slow read patterns are never written again.
 *
 * The pod-latency wave (founder, 27 Nov 2026) fixed each one by hand on a
 * live pod; this makes a NEW occurrence fail CI. The detector is the one
 * module `./read-patterns.mjs` (TypeScript AST for the code shape, regex only
 * on SQL text); its header says what each pattern is and what it cannot see.
 *
 * - `events-unbounded`: a read of the `events` hypertable with no constant
 *   `timestamp` bound plans over every chunk (backend#1347).
 * - `key-cast-to-text`: `<pk>::text = <value>` defeats the primary-key index
 *   (backend#1341; cast the value with `uuidFromTextSql`).
 * - `proposal-data-whole`: a list or aggregate read selects the whole
 *   `proposals.data` (backend#1345; project the key the caller reads).
 *
 * Scanned set: DERIVED, every `.ts`/`.tsx` under `packages/<pkg>/src` and
 * `apps/<app>/src` minus tests, declarations and build output.
 *
 * Ratchet: `read-patterns.allowlist.json` lists today's offenders per pattern
 * per file (count + reason), taken 2026-11-27 at main ac1ba6f0. A file above
 * its count, or a new file with a site, is RED. A file BELOW its count is red
 * too, until its entry is lowered or removed: each entry is tracked debt and
 * the totals only go down. Never raise a count or add a file to pass.
 *
 * Escape hatch: a justified site carries `// read-guard: <reason>` on its line
 * or in the comment block right above it (above `.from(events)`, the selected
 * `data: proposals.data`, the `findMany`, or the line a SQL template starts
 * on). Every justified site is printed below; an empty reason or a marker that
 * justifies no site is RED.
 *
 * Granularity is the FILE: a file that fixes one site and adds another at a
 * flat count stays green (by construction: the count is all the ratchet
 * compares; not measured with a mutation).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PATTERNS,
  type ReadPattern,
  findReadPatternSites,
  listScannedFiles,
  mayHoldSite,
  scanReadPatterns,
} from "./read-patterns.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ALLOWLIST = join(here, "read-patterns.allowlist.json");

const keyOf = (abs: string) => relative(REPO, abs).split(sep).join("/");

type Allowlist = {
  taken: string;
  owner: string;
  patterns: Record<
    ReadPattern,
    Record<string, { count: number; reason: string }>
  >;
};

/** Sites of one pattern in a source text (the detector on a fixture). */
const sitesIn = (src: string, pattern: ReadPattern) =>
  findReadPatternSites("fixture.ts", src).sites.filter(
    (s) => s.pattern === pattern
  );

const IMPORTS = `import { automationRuns, events, focusSessions, links, proposals, secrets } from "@synap/database";
import { and, eq, gte, inArray } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";
`;

// ── the detector, on fixtures where the right and wrong forms DIFFER ────────
describe("read-patterns: the detector", () => {
  describe("events-unbounded", () => {
    it("flags backend#1347's correlated count with no time bound (the code it replaced)", () => {
      const before = `${IMPORTS}
const rows = await db.select({
  closeEvents: drizzleSql<number>\`(
    SELECT count(*)::int FROM \${events} AS ev
    WHERE ev.type = \${T}
      AND ev.subject_id = "focus_sessions"."id"::text
  )\`,
}).from(focusSessions);`;
      expect(sitesIn(before, "events-unbounded")).toHaveLength(1);
      // The key cast there is against a COLUMN: not the key-cast pattern.
      expect(sitesIn(before, "key-cast-to-text")).toHaveLength(0);
    });

    it("passes backend#1347's bounded grouped read (the fix)", () => {
      const after = `${IMPORTS}
const rows = await database
  .select({ subjectId: events.subjectId, n: drizzleSql<number>\`count(*)::int\` })
  .from(events)
  .where(
    and(
      eq(events.type, T),
      inArray(events.subjectId, ids),
      drizzleSql\`\${events.timestamp} >= \${since.toISOString()}\`
    )
  )
  .groupBy(events.subjectId);`;
      expect(sitesIn(after, "events-unbounded")).toHaveLength(0);
    });

    it("flags a builder read with no bound, and follows a same-file where builder", () => {
      expect(
        sitesIn(
          `${IMPORTS}await db.select().from(events).where(eq(events.subjectId, id));`,
          "events-unbounded"
        )
      ).toHaveLength(1);
      expect(
        sitesIn(
          `${IMPORTS}const where = and(eq(events.userId, u), gte(events.timestamp, since));
await db.select().from(events).where(where);`,
          "events-unbounded"
        )
      ).toHaveLength(0);
      // A bound on ANOTHER table's timestamp is not a bound on events.
      expect(
        sitesIn(
          `${IMPORTS}await db.select().from(events).innerJoin(messages, eq(messages.id, events.subjectId)).where(gte(messages.timestamp, since));`,
          "events-unbounded"
        )
      ).toHaveLength(1);
    });

    it("sees an aliased import, a join, the relational API and a plain SQL string", () => {
      expect(
        sitesIn(
          `import { events as eventsTable } from "@synap/database/schema";
await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);`,
          "events-unbounded"
        )
      ).toHaveLength(1);
      expect(
        sitesIn(
          `${IMPORTS}await db.select().from(focusSessions).innerJoin(events, eq(events.sessionId, focusSessions.id));`,
          "events-unbounded"
        )
      ).toHaveLength(1);
      expect(
        sitesIn(
          `${IMPORTS}await db.query.events.findMany({ where: eq(events.type, t) });`,
          "events-unbounded"
        )
      ).toHaveLength(1);
      expect(
        sitesIn(
          `${IMPORTS}await db.query.events.findMany({ where: (e, { gte }) => gte(e.timestamp, since) });`,
          "events-unbounded"
        )
      ).toHaveLength(0);
      expect(
        sitesIn(
          `await client.query("SELECT * FROM events WHERE subject_id = $1", [id]);`,
          "events-unbounded"
        )
      ).toHaveLength(1);
    });

    it("counts a constant SQL bound, not a correlated one; ignores a DELETE", () => {
      const tpl = (bound: string) =>
        `${IMPORTS}const p = drizzleSql\`EXISTS (SELECT 1 FROM events e WHERE e.subject_id = \${id} AND ${bound})\`;`;
      expect(
        sitesIn(
          tpl("e.timestamp >= now() - interval '1 day'"),
          "events-unbounded"
        )
      ).toHaveLength(0);
      expect(
        sitesIn(tpl("e.timestamp >= ${since}"), "events-unbounded")
      ).toHaveLength(0);
      expect(
        sitesIn(tpl("e.timestamp >= fs.created_at"), "events-unbounded")
      ).toHaveLength(1);
      expect(
        sitesIn(
          tpl("e.timestamp >= ${focusSessions.createdAt}"),
          "events-unbounded"
        )
      ).toHaveLength(1);
      expect(
        sitesIn(
          `${IMPORTS}await db.execute(drizzleSql\`DELETE FROM events WHERE subject_id = \${id}\`);`,
          "events-unbounded"
        )
      ).toHaveLength(0);
    });
  });

  describe("key-cast-to-text", () => {
    it("flags backend#1341's ended-run probe (the code it replaced)", () => {
      const before = `${IMPORTS}
const ended = drizzleSql\`EXISTS (
  SELECT 1 FROM automation_runs ar
  WHERE ar.id::text = \${focusSessions.metadata} ->> 'automationRunId'
)\`;`;
      expect(sitesIn(before, "key-cast-to-text")).toHaveLength(1);
    });

    it("passes backend#1341's uuidFromTextSql probe (the fix)", () => {
      const after = `${IMPORTS}
const ended = drizzleSql\`EXISTS (
  SELECT 1 FROM automation_runs ar
  WHERE ar.id = \${uuidFromTextSql(drizzleSql\`\${focusSessions.metadata} ->> 'automationRunId'\`)}
)\`;`;
      expect(sitesIn(after, "key-cast-to-text")).toHaveLength(0);
    });

    it("a key compared with a VALUE is flagged; with a COLUMN it is a join-order choice", () => {
      const one = (sqlText: string) =>
        sitesIn(
          `${IMPORTS}const p = drizzleSql\`${sqlText}\`;`,
          "key-cast-to-text"
        ).length;
      expect(one("${secrets.id}::text = ${input.connectionId}")).toBe(1);
      expect(one("x.r->>'viewId' = v.id::text")).toBe(1);
      expect(one("CAST(v.id AS text) = x.r->>'viewId'")).toBe(1);
      expect(one("${focusSessions.id}::text IN (SELECT 1)")).toBe(1);
      expect(one("l.from_id = s.id::text")).toBe(0);
      expect(one("${links.fromId} = ${focusSessions.id}::text")).toBe(0);
      expect(one("p.id::text = b.subject_id")).toBe(0);
      expect(one("SELECT ar.id::text AS run_id FROM automation_runs ar")).toBe(
        0
      );
    });

    it("sees the eq(sql`pk::text`, …) builder form", () => {
      expect(
        sitesIn(
          `${IMPORTS}q.leftJoin(automationRuns, eq(drizzleSql\`\${automationRuns.id}::text\`, drizzleSql\`\${focusSessions.metadata}->>'automationRunId'\`));`,
          "key-cast-to-text"
        )
      ).toHaveLength(1);
      expect(
        sitesIn(
          `${IMPORTS}q.innerJoin(focusSessions, eq(drizzleSql\`\${focusSessions.id}::text\`, links.fromId));`,
          "key-cast-to-text"
        )
      ).toHaveLength(0);
    });
  });

  describe("proposal-data-whole", () => {
    it("flags backend#1345's list read of the whole data (the code it replaced)", () => {
      const before = `${IMPORTS}
await db
  .select({ status: proposals.status, data: proposals.data })
  .from(proposals)
  .where(and(eq(proposals.userId, u), inArray(proposals.status, s)));`;
      expect(sitesIn(before, "proposal-data-whole")).toHaveLength(1);
    });

    it("passes backend#1345's projection of one key (the fix)", () => {
      const after = `${IMPORTS}
await db
  .select({
    status: proposals.status,
    data: drizzleSql<unknown>\`jsonb_build_object('dispositions', \${proposals.data} -> 'dispositions')\`,
  })
  .from(proposals)
  .where(and(eq(proposals.userId, u), inArray(proposals.status, s)));`;
      expect(sitesIn(after, "proposal-data-whole")).toHaveLength(0);
    });

    it("a single-row read and a write's returning are not list reads", () => {
      const n = (src: string) =>
        sitesIn(`${IMPORTS}${src}`, "proposal-data-whole").length;
      expect(
        n(
          "await db.select({ data: proposals.data }).from(proposals).where(eq(proposals.id, id));"
        )
      ).toBe(0);
      expect(
        n(
          "await db.select({ data: proposals.data }).from(proposals).where(eq(proposals.sessionId, s)).limit(1);"
        )
      ).toBe(0);
      expect(
        n(
          "await db.update(proposals).set({ status: s }).returning({ id: proposals.id, data: proposals.data });"
        )
      ).toBe(0);
      expect(
        n(
          "await db.query.proposals.findFirst({ where: eq(proposals.id, id) });"
        )
      ).toBe(0);
    });

    it("sees select(), a join, a same-file column object and the relational API", () => {
      const n = (src: string) =>
        sitesIn(`${IMPORTS}${src}`, "proposal-data-whole").length;
      expect(
        n(
          "await db.select().from(proposals).where(eq(proposals.status, 'pending'));"
        )
      ).toBe(1);
      expect(
        n(
          "await db.select({ id: focusSessions.id, data: proposals.data }).from(focusSessions).innerJoin(proposals, eq(proposals.sessionId, focusSessions.id));"
        )
      ).toBe(1);
      expect(
        n(
          "const COLS = { id: proposals.id, data: proposals.data } as const;\nawait db.select(COLS).from(proposals).where(eq(proposals.status, s));"
        )
      ).toBe(1);
      expect(n("await db.query.proposals.findMany({ where: w });")).toBe(1);
      expect(
        n(
          "await db.query.proposals.findMany({ columns: { id: true, data: true } });"
        )
      ).toBe(1);
      expect(
        n(
          "await db.query.proposals.findMany({ columns: { id: true, status: true } });"
        )
      ).toBe(0);
      expect(
        n("await db.query.proposals.findMany({ columns: { data: false } });")
      ).toBe(0);
    });
  });

  describe("the read-guard marker", () => {
    it("justifies the site it sits on or above; an empty or orphan marker is reported", () => {
      const src = `${IMPORTS}
await db
  .select({
    // The review card renders every change in the payload.
    // read-guard: renders the whole payload, one page of 20
    data: proposals.data,
  })
  .from(proposals)
  .where(eq(proposals.status, s));
// read-guard:
const a = 1;

// read-guard: nothing here
const b = 2;`;
      const r = findReadPatternSites("fixture.ts", src);
      expect(r.sites).toHaveLength(1);
      expect(r.sites[0]).toMatchObject({
        pattern: "proposal-data-whole",
        justified: true,
        reason: "renders the whole payload, one page of 20",
      });
      expect(r.emptyMarkers).toHaveLength(1);
      expect(r.unusedMarkers).toHaveLength(1);
    });

    it("a marker separated from the site by code does not justify it", () => {
      const src = `${IMPORTS}
// read-guard: far away
const x = 1;
await db.select().from(events).where(eq(events.id, id));`;
      const r = findReadPatternSites("fixture.ts", src);
      expect(r.sites).toMatchObject([{ justified: false }]);
      expect(r.unusedMarkers).toHaveLength(1);
    });
  });
});

// ── the real tree ───────────────────────────────────────────────────────────
const files = listScannedFiles(REPO);
const scan = scanReadPatterns(files, keyOf);
const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;

/**
 * Each wave fix, on the REAL file: today it holds no site, and undoing the fix
 * in memory makes the scan see one. This is the seam test that the scanned
 * set, the pre-check and the detector all still reach the code that was fixed.
 */
const FIXED: Array<{
  pattern: ReadPattern;
  file: string;
  fixed: string;
  regressed: string;
}> = [
  {
    pattern: "events-unbounded",
    file: "packages/jobs/src/utils/playbook-scorecard.ts",
    fixed: "drizzleSql`${events.timestamp} >= ${since.toISOString()}`",
    regressed: "undefined",
  },
  {
    pattern: "key-cast-to-text",
    file: "packages/api/src/services/focus-sessions/session-lifecycle-sweep.ts",
    fixed:
      "ar.id = ${uuidFromTextSql(drizzleSql`${focusSessions.metadata} ->> 'automationRunId'`)}",
    regressed: "ar.id::text = ${focusSessions.metadata} ->> 'automationRunId'",
  },
  {
    pattern: "key-cast-to-text",
    file: "packages/api/src/services/runs/run-blocked-ask.ts",
    fixed: "ar.id = ${uuidFromTextSql(drizzleSql`${m} ->> 'automationRunId'`)}",
    regressed: "ar.id::text = ${m} ->> 'automationRunId'",
  },
  {
    pattern: "proposal-data-whole",
    file: "packages/api/src/services/diagnose/review-queue.ts",
    fixed:
      "drizzleSql<unknown>`jsonb_build_object('dispositions', ${proposals.data} -> 'dispositions')`",
    regressed: "proposals.data",
  },
  {
    pattern: "proposal-data-whole",
    file: "packages/api/src/services/intake/quality-by-prompt-version.ts",
    fixed:
      "drizzleSql<unknown>`jsonb_build_object('dispositions', ${proposals.data} -> 'dispositions')`",
    regressed: "proposals.data",
  },
];

/** One real offender per pattern the scan must keep seeing (fix it: pin another). */
const KNOWN_POSITIVE: Record<ReadPattern, string> = {
  "events-unbounded": "packages/database/src/repositories/event-repository.ts",
  "key-cast-to-text":
    "packages/api/src/services/focus-sessions/session-interactions.ts",
  "proposal-data-whole":
    "packages/database/src/repositories/proposal-repository.ts",
};

describe("read-patterns: the scan reaches the tree (non-vacuity)", () => {
  it("scans a plausible number of files, tests excluded", () => {
    // 3,223 files on 2026-11-27 (main ac1ba6f0).
    expect(files.length).toBeGreaterThan(2500);
    const keys = files.map(keyOf);
    expect(keys).toEqual(
      expect.arrayContaining([
        "apps/api/src/index.ts",
        "packages/api/src/index.ts",
        ...FIXED.map((f) => f.file),
        ...Object.values(KNOWN_POSITIVE),
      ])
    );
    expect(keys.some((k) => /\.test\.tsx?$|__tests__\//.test(k))).toBe(false);
  });

  it.each(FIXED)(
    "$file: the $pattern fix holds no site, and undoing it in memory makes one",
    ({ pattern, file, fixed, regressed }) => {
      const text = readFileSync(join(REPO, file), "utf8");
      expect(text, `${file} no longer holds the fix text: re-pin`).toContain(
        fixed
      );
      const now = findReadPatternSites(file, text).sites.filter(
        (s) => s.pattern === pattern
      );
      expect(now).toHaveLength(0);
      const undone = text.replace(fixed, regressed);
      expect(undone).not.toBe(text);
      expect(mayHoldSite(undone)).toBe(true);
      const after = findReadPatternSites(file, undone).sites.filter(
        (s) => s.pattern === pattern
      );
      expect(after.length).toBeGreaterThanOrEqual(1);
    }
  );

  it.each(PATTERNS)("still sees the pinned real %s offender", (pattern) => {
    const file = KNOWN_POSITIVE[pattern];
    const text = readFileSync(join(REPO, file), "utf8");
    expect(mayHoldSite(text)).toBe(true);
    expect(
      findReadPatternSites(file, text).sites.filter(
        (s) => s.pattern === pattern
      ).length
    ).toBeGreaterThanOrEqual(1);
    expect(scan.counts[pattern][file] ?? 0).toBeGreaterThanOrEqual(1);
  });
});

// ── the ratchet, one test per pattern so a red names its pattern ───────────
describe("read-patterns: no new slow read (per-file ratchet)", () => {
  it.each(PATTERNS)(
    "%s: every file matches its allowlisted count",
    (pattern) => {
      const listed = allowlist.patterns[pattern];
      const current = scan.counts[pattern];
      const problems: string[] = [];
      for (const [file, n] of Object.entries(current)) {
        const allowed = listed[file]?.count ?? 0;
        if (n > allowed)
          problems.push(
            `NEW ${file}: ${n} site(s), allowlist ${allowed}. Fix the read (see read-patterns.mjs for the fix of each pattern), or mark a justified one with \`// read-guard: <reason>\`. Never raise the allowlist.`
          );
        else if (n < allowed)
          problems.push(
            `FEWER ${file}: ${n} site(s), allowlist ${allowed}. Lower its "count" to ${n} in read-patterns.allowlist.json: the debt went down.`
          );
      }
      for (const file of Object.keys(listed))
        if (!(file in current))
          problems.push(
            `GONE ${file}: no site left. Remove its entry from read-patterns.allowlist.json.`
          );
      expect(problems, problems.join("\n")).toEqual([]);
    }
  );

  it("every allowlist entry is a positive count with a reason", () => {
    const bad: string[] = [];
    for (const pattern of PATTERNS) {
      expect(allowlist.patterns[pattern], pattern).toBeDefined();
      for (const [file, e] of Object.entries(allowlist.patterns[pattern]))
        if (!(e.count > 0) || !e.reason?.trim()) bad.push(`${pattern} ${file}`);
    }
    expect(Object.keys(allowlist.patterns).sort()).toEqual(
      [...PATTERNS].sort()
    );
    expect(bad).toEqual([]);
  });

  it("every read-guard marker has a reason and justifies a site", () => {
    const totals = PATTERNS.map(
      (p) =>
        `${p}: ${Object.values(scan.counts[p]).reduce((a, b) => a + b, 0)} allowlisted in ${Object.keys(scan.counts[p]).length} file(s)`
    );
    console.log(
      `read-patterns: ${files.length} files scanned; ${totals.join("; ")}; ${scan.justified.length} justified by a marker${scan.justified.length ? ":\n  " + scan.justified.join("\n  ") : ""}`
    );
    expect(scan.emptyMarkers, "a `// read-guard:` with no reason").toEqual([]);
    expect(
      scan.unusedMarkers,
      "a `// read-guard:` that justifies no site (move it onto the site's line or the comment block above it, or delete it)"
    ).toEqual([]);
  });
});
