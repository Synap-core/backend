import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE (T3) — cross-door verb parity, by ACKNOWLEDGEMENT not symmetry.
 *
 * THE FAILURE THIS CATCHES: Synap exposes the same objects through four doors
 * (CLI, MCP, Hub REST, tRPC) that are maintained independently. A verb reachable
 * through one door and simply *forgotten* on another is indistinguishable, from
 * the outside, from a verb deliberately withheld. Both look like "the CLI can't
 * do that". Observed live, both shapes at once, on ONE object:
 *   • MCP had no `approve` — CORRECT. `rejectAgentReviewer`
 *     (hub-protocol/rest/_shared.ts) 403s any agent-linked key on /approve, by
 *     design: approval is the human step.
 *   • MCP had no `reject` — a GAP. `rest/proposals.ts` documents that reject is
 *     intentionally NOT agent-guarded ("rejection only prevents a pending change
 *     from landing, so it carries no self-approval / undo risk") and the CLI
 *     proves an agent key rejects successfully. The authority existed; only the
 *     tool declaration was missing.
 * Nothing distinguished the two until a human read four files.
 *
 * WHAT THIS ASSERTS: for a hand-curated object × verb × door matrix, every cell
 * is either PRESENT on that door, or listed in {@link ACKNOWLEDGED_GAPS} WITH A
 * ONE-LINE REASON. It does NOT force symmetry — asymmetry is often right. It
 * forces every asymmetry to be written down and justified, so the next reader
 * sees "withheld, because X" instead of silence.
 *
 * It is also self-cleaning: an ACKNOWLEDGED_GAPS entry whose cell has since
 * become PRESENT FAILS ("this gap is closed, remove the entry"), and an entry
 * naming a cell outside the matrix FAILS. Otherwise the table accumulates dead
 * rows and the contract erodes into decoration.
 *
 * ── LIMIT — READ THIS BEFORE TRUSTING IT ────────────────────────────────────
 * This is DECLARATION-level detection: it proves a verb is *declared* on a door,
 * never that a caller can actually execute it. It CANNOT detect "the door
 * advertises the verb and then 403s at runtime" — that is a runtime-authorization
 * property and needs an integration test against a live pod with a real key.
 * A green T3 means "written down", not "works".
 *
 * ── ANTI-STALENESS (the documented `tripwires-lose-coverage-silently` failure) ─
 * A source-scanning tripwire that greps a FIXED file list stays green forever
 * once the code it guards moves. Four rules, all enforced below:
 *   1. Scan directory ROOTS RECURSIVELY — never a list of file paths.
 *   2. Assert every required root EXISTS — a renamed directory fails loudly
 *      instead of scanning nothing and passing.
 *   3. SELF-GUARD on a known-positive per door — a broken detector reads red,
 *      not clean.
 *   4. Assert the corpus SIZE per root — a root that still exists but was
 *      emptied (or an extension/skip filter that ate everything) fails.
 *
 * The CLI lives in a SIBLING REPO (`synap-cli/`), so its root is OPTIONAL: when
 * it is absent from the checkout, its cells are SKIPPED and the skip is reported
 * loudly in a dedicated test — never silently treated as "present" or "gap".
 */

// ── Scan roots ───────────────────────────────────────────────────────────────

type Door = "cli" | "mcp" | "hub_rest" | "trpc";

interface Root {
  /** Absolute directory scanned recursively for `.ts` sources. */
  dir: string;
  /** Minimum number of files a healthy scan must find (rule 4). */
  fileFloor: number;
  /** Sibling-repo roots may be absent from a backend-only checkout. */
  optional?: boolean;
}

const API_SRC = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "../../../../..");

const ROOTS: Record<Door, Root> = {
  // Sibling repo — present in the monorepo checkout, absent in a
  // backend-only one. See the OPTIONAL note in the header.
  cli: { dir: join(REPO_ROOT, "synap-cli/src"), fileFloor: 30, optional: true },
  mcp: { dir: join(API_SRC, "routers/mcp"), fileFloor: 5 },
  hub_rest: { dir: join(API_SRC, "routers/hub-protocol/rest"), fileFloor: 40 },
  trpc: { dir: join(API_SRC, "routers"), fileFloor: 40 },
};

const DOORS = Object.keys(ROOTS) as Door[];

// ── The matrix ───────────────────────────────────────────────────────────────

/**
 * A cell detector. `present` = some scanned file matches `pattern` (optionally
 * within a slice of that file, and optionally only in files matching `file`).
 *
 * For a cell that is EXPECTED ABSENT, the pattern is the one that WOULD match if
 * someone added the verb — that is what makes a closed gap detectable.
 */
interface Detector {
  /** Narrows which files are considered (matched against file CONTENT). */
  file?: RegExp;
  /** Restrict matching to the region starting at this match. */
  sliceFrom?: RegExp;
  /** ...and ending at the next match of this, after `sliceFrom`. */
  sliceTo?: RegExp;
  /** The declaration that proves the verb exists on this door. */
  pattern: RegExp;
}

interface ObjectSpec {
  object: string;
  verbs: string[];
  /** door → verb → detector. Every cell needs one, present or not. */
  detectors: Record<Door, Record<string, Detector>>;
}

/** tRPC: only the named router's OWN top-level procedures (2-space keys). */
function trpcProc(routerName: string, member: string): Detector {
  return {
    file: new RegExp(`export const ${routerName} = router\\(\\{`),
    sliceFrom: new RegExp(`export const ${routerName} = router\\(\\{`),
    pattern: new RegExp(
      `^ {2}${member}: (protected|workspace|public|admin)Procedure`,
      "m"
    ),
  };
}

/** MCP: a tool DECLARED in the `list()` array the client sees. */
function mcpTool(name: string): Detector {
  return { pattern: new RegExp(`name: "${name}"`) };
}

/** CLI: a subcommand inside the `synap proposals` command group. */
function cliProposalsCmd(pattern: RegExp): Detector {
  return {
    file: /\.command\("proposals"\)/,
    sliceFrom: /\.command\("proposals"\)/,
    sliceTo: /\nconst \w+ = program\b/,
    pattern,
  };
}

const MATRIX: ObjectSpec[] = [
  {
    object: "proposal",
    verbs: ["list", "get", "approve", "reject", "revise", "create"],
    detectors: {
      cli: {
        list: cliProposalsCmd(/\.command\("list"/),
        get: cliProposalsCmd(/\.command\("(show|get) </),
        approve: cliProposalsCmd(/\.command\("approve </),
        reject: cliProposalsCmd(/\.command\("reject </),
        revise: cliProposalsCmd(/\.command\("revise/),
        create: cliProposalsCmd(/\.command\("(create|submit)/),
      },
      mcp: {
        list: mcpTool("synap_list_proposals"),
        get: mcpTool("synap_get_proposal"),
        approve: mcpTool("synap_approve_proposal"),
        reject: mcpTool("synap_reject_proposal"),
        revise: mcpTool("synap_revise_proposal"),
        create: { pattern: /name: "synap_(create|submit)_proposal"/ },
      },
      hub_rest: {
        list: { pattern: /app\.get\("\/proposals",/ },
        get: { pattern: /app\.get\("\/proposals\/:id",/ },
        approve: { pattern: /app\.post\("\/proposals\/:id\/approve"/ },
        reject: { pattern: /app\.post\("\/proposals\/:id\/reject"/ },
        revise: { pattern: /app\.patch\("\/proposals\/:id",/ },
        create: { pattern: /app\.post\("\/proposals",/ },
      },
      trpc: {
        list: trpcProc("proposalsRouter", "list"),
        get: trpcProc("proposalsRouter", "get"),
        approve: trpcProc("proposalsRouter", "approve"),
        reject: trpcProc("proposalsRouter", "reject"),
        revise: trpcProc("proposalsRouter", "revise"),
        // Named `submit` here: a proposal is FILED, not authored.
        create: trpcProc("proposalsRouter", "submit"),
      },
    },
  },
  {
    object: "playbook",
    verbs: ["list", "get", "create", "update", "run", "archive"],
    detectors: {
      // CLI × playbook is detected at ROOT granularity: the primitive has no
      // CLI surface at all, so there is no command group to anchor per-verb
      // patterns inside. Any `synap playbook*` command closes all six rows.
      cli: Object.fromEntries(
        ["list", "get", "create", "update", "run", "archive"].map((v) => [
          v,
          { pattern: /\.command\("playbooks?"/ } as Detector,
        ])
      ),
      mcp: {
        list: mcpTool("synap_list_playbooks"),
        get: mcpTool("synap_get_playbook"),
        create: mcpTool("synap_create_playbook"),
        update: mcpTool("synap_update_playbook"),
        run: mcpTool("synap_run_playbook"),
        archive: mcpTool("synap_archive_playbook"),
      },
      hub_rest: {
        list: { pattern: /app\.get\("\/playbooks",/ },
        get: { pattern: /app\.get\("\/playbooks\/:id",/ },
        create: { pattern: /app\.post\("\/playbooks",/ },
        update: { pattern: /app\.patch\("\/playbooks\/:id"/ },
        run: { pattern: /app\.post\("\/playbooks\/:id\/run"/ },
        archive: { pattern: /app\.post\("\/playbooks\/:id\/archive"/ },
      },
      trpc: {
        list: trpcProc("playbooksRouter", "list"),
        get: trpcProc("playbooksRouter", "get"),
        create: trpcProc("playbooksRouter", "create"),
        update: trpcProc("playbooksRouter", "update"),
        run: trpcProc("playbooksRouter", "run"),
        archive: trpcProc("playbooksRouter", "archive"),
      },
    },
  },
];

// ── Acknowledged gaps ────────────────────────────────────────────────────────

interface Gap {
  object: string;
  verb: string;
  door: Door;
  /** WHY this door does not have this verb. One line. Required. */
  reason: string;
}

/**
 * Every cell listed here is a DELIBERATE asymmetry with its rationale. Adding a
 * row is how you close a T3 failure without building the verb — but the row must
 * say why, and it dies automatically once the verb ships.
 */
const ACKNOWLEDGED_GAPS: Gap[] = [
  // ── proposal ───────────────────────────────────────────────────────────────
  {
    object: "proposal",
    verb: "approve",
    door: "mcp",
    reason:
      "BY DESIGN — approval is the human step; `rejectAgentReviewer` 403s any agent-linked key on approve/revert, so an approve tool could only ever fail. Agents surface the reviewUrl instead.",
  },
  {
    object: "proposal",
    verb: "get",
    door: "mcp",
    reason:
      "Covered by `synap_list_proposals` detail:'full' (full `data` payload) and `synap_diagnose { id }` (state + why) — a third single-row reader would be a fourth door onto the same row.",
  },
  {
    object: "proposal",
    verb: "get",
    door: "cli",
    reason:
      "Annoyance tier — `synap proposals list` prints the row and `synap open proposal <id>` opens the human review surface; no `proposals show <id>` for terminal-only inspection.",
  },
  {
    object: "proposal",
    verb: "revise",
    door: "cli",
    reason:
      "Revision is an agent act (MCP `synap_revise_proposal`) or a reviewer act in the browser's Save & Approve; the CLI is the agent's inbox, not an editor.",
  },
  {
    object: "proposal",
    verb: "create",
    door: "cli",
    reason:
      "A proposal is FILED BY the governance membrane (`checkPermissionOrPropose`) as the receipt of a governed write — never hand-authored from a terminal.",
  },
  {
    object: "proposal",
    verb: "create",
    door: "mcp",
    reason:
      "Same: every MCP write already files its own proposal when governance says propose. An explicit create tool would let an agent forge a proposal detached from any write.",
  },
  // ── playbook — the CLI has NO playbook surface at all ───────────────────────
  ...(["list", "get", "create", "update", "run", "archive"] as const).map(
    (verb) => ({
      object: "playbook",
      verb,
      door: "cli" as Door,
      reason:
        "The CLI ships NO playbook surface — a whole primitive is agent-only (MCP) + browser-only (tRPC). Known, not yet justified by a user need; revisit rather than assume.",
    })
  ),
  // ── playbook — Hub REST carries only 2 routes ──────────────────────────────
  ...(["list", "get", "create", "run", "archive"] as const).map((verb) => ({
    object: "playbook",
    verb,
    door: "hub_rest" as Door,
    reason:
      "Hub REST exposes only PATCH /playbooks/:id and POST /playbooks/promote-from-session — the IS needs to amend and to promote, not to browse or run; running goes through MCP `synap_run_playbook`.",
  })),
  // ── playbook — MCP ─────────────────────────────────────────────────────────
  {
    object: "playbook",
    verb: "get",
    door: "mcp",
    reason:
      "Covered by `synap_get_graph { type: 'playbook' }`, which returns the playbook PLUS its neighbours — strictly more than a bare read.",
  },
  {
    object: "playbook",
    verb: "update",
    door: "mcp",
    reason:
      "Agents author playbooks (`synap_create_playbook`) and promote proven sessions into them; editing an existing one in place is a human/browser act via tRPC `playbooks.update`.",
  },
  {
    object: "playbook",
    verb: "archive",
    door: "mcp",
    reason:
      "Retiring a shared process is a human decision. Note there is NO hard delete for a playbook on ANY door — tRPC `archive` is a deliberate soft state transition so run history stays reconstructable. JUSTIFIED KEEP, not a gap.",
  },
];

// ── Scanning ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "__tripwires__",
  "__tests__",
]);

/** RULE 1: recursive directory walk — never a file-path list. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...collectSources(full));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    // Test sources quote the very patterns we detect; excluding them keeps a
    // fixture from ever standing in for a real door.
    if (name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

interface Corpus {
  door: Door;
  available: boolean;
  sources: string[];
}

const CORPORA: Record<Door, Corpus> = Object.fromEntries(
  DOORS.map((door) => {
    const root = ROOTS[door];
    const available = existsSync(root.dir);
    return [
      door,
      {
        door,
        available,
        sources: available
          ? collectSources(root.dir).map((f) => readFileSync(f, "utf8"))
          : [],
      },
    ];
  })
) as Record<Door, Corpus>;

function sliceOf(src: string, d: Detector): string {
  if (!d.sliceFrom) return src;
  const start = src.search(d.sliceFrom);
  if (start < 0) return "";
  const rest = src.slice(start);
  if (!d.sliceTo) return rest;
  const end = rest.slice(1).search(d.sliceTo);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function isPresent(door: Door, d: Detector): boolean {
  return CORPORA[door].sources.some(
    (src) => (!d.file || d.file.test(src)) && d.pattern.test(sliceOf(src, d))
  );
}

function detectorFor(
  object: string,
  verb: string,
  door: Door
): Detector | null {
  const spec = MATRIX.find((m) => m.object === object);
  if (!spec || !spec.verbs.includes(verb)) return null;
  return spec.detectors[door][verb] ?? null;
}

/** Doors whose root is absent from this checkout (cells unverifiable). */
const UNAVAILABLE = DOORS.filter((d) => !CORPORA[d].available);

// ── The tripwire ─────────────────────────────────────────────────────────────

describe("tripwire (T3): every object × verb × door cell is present or acknowledged", () => {
  // RULE 2 — a renamed/moved root must fail loudly, not scan nothing.
  it.each(DOORS.filter((d) => !ROOTS[d].optional))(
    "required scan root for the %s door exists",
    (door) => {
      expect(
        existsSync(ROOTS[door].dir),
        `Scan root for the "${door}" door does not exist: ${ROOTS[door].dir}. ` +
          `It was renamed or moved — update ROOTS. Do NOT let this tripwire ` +
          `scan an empty set and report green.`
      ).toBe(true);
    }
  );

  // RULE 4 — a root that still exists but got emptied (or a skip filter that
  // ate everything) must fail. Neither sibling tripwire has this assertion.
  it.each(DOORS)("the %s corpus is non-trivially sized", (door) => {
    if (!CORPORA[door].available) {
      expect(ROOTS[door].optional).toBe(true);
      return;
    }
    expect(
      CORPORA[door].sources.length,
      `Scanned only ${CORPORA[door].sources.length} source file(s) under ` +
        `${ROOTS[door].dir} (floor ${ROOTS[door].fileFloor}). The root exists ` +
        `but the corpus collapsed — check SKIP_DIRS / the .ts filter before ` +
        `trusting any result below.`
    ).toBeGreaterThan(ROOTS[door].fileFloor);
  });

  // RULE 3 — self-guard. If the detector engine, a slice helper, or a scan
  // filter breaks, these known-positives read red instead of every cell
  // silently reporting "absent" (which would look like a wall of new gaps).
  const KNOWN_POSITIVES: Array<[string, string, Door]> = [
    ["proposal", "list", "mcp"],
    ["proposal", "approve", "hub_rest"],
    ["proposal", "reject", "trpc"],
    ["proposal", "reject", "cli"],
  ];
  it.each(KNOWN_POSITIVES)(
    "SELF-GUARD: %s.%s is detected on the %s door",
    (object, verb, door) => {
      if (!CORPORA[door].available) {
        expect(ROOTS[door].optional).toBe(true);
        return;
      }
      const d = detectorFor(object, verb, door)!;
      expect(
        isPresent(door, d),
        `The detector engine failed to find a verb that DOES exist ` +
          `(${object}.${verb} on ${door}). Every "gap" this file reports is ` +
          `therefore untrustworthy — fix the detector, not the table.`
      ).toBe(true);
    }
  );

  it("the matrix is non-empty (a vacuous tripwire is not a tripwire)", () => {
    expect(MATRIX.length).toBeGreaterThan(0);
    for (const spec of MATRIX) expect(spec.verbs.length).toBeGreaterThan(0);
  });

  it("every acknowledged gap carries a reason", () => {
    const reasonless = ACKNOWLEDGED_GAPS.filter(
      (g) => g.reason.trim().length < 20
    ).map((g) => `${g.object}.${g.verb}@${g.door}`);
    expect(
      reasonless,
      `An acknowledged gap without a real reason is just a silenced failure:\n  ` +
        reasonless.join("\n  ")
    ).toEqual([]);
  });

  it("every acknowledged gap names a cell that is actually in the matrix", () => {
    const dead = ACKNOWLEDGED_GAPS.filter(
      (g) => detectorFor(g.object, g.verb, g.door) === null
    ).map((g) => `${g.object}.${g.verb}@${g.door}`);
    expect(
      dead,
      `These ACKNOWLEDGED_GAPS entries name a cell the matrix does not contain ` +
        `(the object, the verb, or the door was renamed/removed) — a dead entry ` +
        `silences nothing and hides the rename:\n  ${dead.join("\n  ")}`
    ).toEqual([]);
  });

  it("no acknowledged gap is STALE (the verb has since shipped on that door)", () => {
    const stale = ACKNOWLEDGED_GAPS.filter((g) => {
      if (!CORPORA[g.door].available) return false;
      const d = detectorFor(g.object, g.verb, g.door);
      return d !== null && isPresent(g.door, d);
    }).map((g) => `${g.object}.${g.verb}@${g.door}`);
    expect(
      stale,
      `These cells are listed as acknowledged gaps but the verb IS now present ` +
        `on that door — the gap is CLOSED. Remove the ACKNOWLEDGED_GAPS entry, ` +
        `or the table rots into a list of things that used to be true:\n  ` +
        `${stale.join("\n  ")}`
    ).toEqual([]);
  });

  it("every cell is either present on its door or acknowledged with a reason", () => {
    const acknowledged = new Set(
      ACKNOWLEDGED_GAPS.map((g) => `${g.object}.${g.verb}@${g.door}`)
    );
    const unexplained: string[] = [];

    for (const spec of MATRIX) {
      for (const verb of spec.verbs) {
        for (const door of DOORS) {
          if (!CORPORA[door].available) continue; // reported separately
          const key = `${spec.object}.${verb}@${door}`;
          const d = spec.detectors[door][verb];
          expect(
            d,
            `No detector for ${key} — every matrix cell needs one, including ` +
              `the ones expected to be absent (that is what detects a gap closing).`
          ).toBeTruthy();
          if (isPresent(door, d) || acknowledged.has(key)) continue;
          unexplained.push(key);
        }
      }
    }

    expect(
      unexplained,
      `These verbs are reachable through at least one door but are NEITHER ` +
        `present on the door below NOR listed in ACKNOWLEDGED_GAPS:\n  ` +
        `${unexplained.join("\n  ")}\n` +
        `Either ship the verb on that door, or add an ACKNOWLEDGED_GAPS entry ` +
        `saying WHY it is withheld. "Forgotten" and "withheld on purpose" must ` +
        `never look the same from outside.`
    ).toEqual([]);
  });

  // Honest reporting of reduced coverage — a skipped door is stated, never
  // silently counted as clean.
  it("reports any door whose root is absent from this checkout", () => {
    for (const door of UNAVAILABLE) {
      // eslint-disable-next-line no-console
      console.warn(
        `[T3] The "${door}" door's scan root is absent (${ROOTS[door].dir}) — ` +
          `its cells were NOT verified in this run. This is expected in a ` +
          `backend-only checkout; in the full monorepo it means the sibling ` +
          `repo moved.`
      );
      expect(ROOTS[door].optional).toBe(true);
    }
  });
});
