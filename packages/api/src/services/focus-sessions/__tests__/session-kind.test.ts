/**
 * SESSION KIND — the derivation and its SQL twin.
 *
 * The thing worth pinning is that the two halves of `session-kind.ts` are two
 * spellings of ONE rule. A drift between them shows up as "the row says receipt
 * but the receipt lens does not list it" — the same failure the triage lens was
 * built to avoid, and the reason both halves live in one file.
 *
 * The TypeScript half is asserted exhaustively over fixtures. The SQL half is
 * asserted at the COMPILED level (`PgDialect` — the technique
 * `access/exposure-restriction.tripwire.test.ts` uses), which proves the
 * predicate references the same four signals in the same order and carries the
 * NULL handling explicitly. It does NOT execute against Postgres; there is no
 * database in this gate. What it can prove — that neither half quietly stops
 * looking at a signal, and that `run` is guarded by the receipt override — is
 * exactly the drift that has bitten this codebase before.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SQL } from "@synap/database";
import {
  SESSION_KINDS,
  AGENT_PROPOSAL_PACKAGE_KIND,
  projectSessionKind,
  attachSessionKind,
  sessionAutomationWhere,
  sessionKindWhere,
  type SessionKind,
} from "../session-kind.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

/** One fixture set, classified by the TypeScript half. */
const FIXTURES: Array<{
  name: string;
  row: {
    origin?: string | null;
    playbookId?: string | null;
    metadata?: unknown;
  };
  kind: SessionKind;
}> = [
  {
    name: "a person's own session",
    row: { origin: "human", playbookId: null, metadata: {} },
    kind: "work",
  },
  {
    name: "NULL origin (un-migrated row) — work, never lost",
    row: { origin: null, playbookId: null, metadata: null },
    kind: "work",
  },
  {
    name: "an agent session a person accepted",
    row: {
      origin: "agent",
      playbookId: null,
      metadata: { triage: { acceptedAt: "2026-09-05T00:00:00.000Z" } },
    },
    kind: "work",
  },
  {
    name: "an agent-origin run source with no run ids (digest, import) — work",
    row: { origin: "agent", playbookId: null, metadata: { source: "digest" } },
    kind: "work",
  },
  {
    name: "an automation-drafted session a person ACCEPTED from triage — work",
    row: {
      origin: "automation",
      playbookId: null,
      metadata: {
        automationId: "auto-1",
        triage: { acceptedAt: "2026-09-05T00:00:00.000Z" },
      },
    },
    kind: "work",
  },
  {
    name: "playbook origin",
    row: { origin: "playbook", playbookId: null, metadata: {} },
    kind: "run",
  },
  {
    name: "automation origin",
    row: { origin: "automation", playbookId: null, metadata: {} },
    kind: "run",
  },
  {
    name: "playbookId set, agent origin (openRunSession stamps origin=agent)",
    row: {
      origin: "agent",
      playbookId: "pb-1",
      metadata: { source: "playbook-run" },
    },
    kind: "run",
  },
  {
    name: "metadata.automationRunId set",
    row: {
      origin: "agent",
      playbookId: null,
      metadata: { automationRunId: "ar-1" },
    },
    kind: "run",
  },
  {
    name: "metadata.automationId set, no run id (a producer that stamps only the definition)",
    row: {
      origin: "agent",
      playbookId: null,
      metadata: { automationId: "au-1" },
    },
    kind: "run",
  },
  {
    name: "receipt — the agent-write container",
    row: {
      origin: "agent",
      playbookId: null,
      metadata: { source: "agent-write", kind: AGENT_PROPOSAL_PACKAGE_KIND },
    },
    kind: "receipt",
  },
  {
    name: "receipt BEATS run — a receipt is also agent-minted by openRunSession",
    row: {
      origin: "automation",
      playbookId: "pb-2",
      metadata: {
        kind: AGENT_PROPOSAL_PACKAGE_KIND,
        automationId: "au-2",
        automationRunId: "ar-2",
      },
    },
    kind: "receipt",
  },
];

describe("projectSessionKind", () => {
  for (const f of FIXTURES) {
    it(`classifies ${f.name} as ${f.kind}`, () => {
      expect(projectSessionKind(f.row)).toBe(f.kind);
    });
  }

  it("classifies every fixture into a declared kind, and covers all three", () => {
    const seen = new Set(FIXTURES.map((f) => projectSessionKind(f.row)));
    expect([...seen].sort()).toEqual([...SESSION_KINDS].sort());
  });
});

describe("attachSessionKind", () => {
  it("is pure — adds `kind` and keeps every other field", () => {
    const rows = [
      { id: "s1", origin: "human", playbookId: null, metadata: {} },
    ];
    const [out] = attachSessionKind(rows);
    expect(out).toEqual({ ...rows[0], kind: "work" });
    // The input is not mutated (the list doors chain three projections).
    expect(rows[0]).not.toHaveProperty("kind");
  });
});

describe("sessionKindWhere — the SQL twin", () => {
  it("reads the triage receipt path in BOTH senses — accepted from triage is work", () => {
    // If only one half read the receipt, an accepted automation-draft would be
    // `work` in TS and `run` in the WHERE — the fork this file exists to prevent.
    expect(compile(sessionKindWhere("run")).sql).toContain(
      "#>> '{triage,acceptedAt}' IS NULL"
    );
    expect(compile(sessionKindWhere("work")).sql).toContain(
      "#>> '{triage,acceptedAt}' IS NOT NULL"
    );
  });

  it("keys a receipt on metadata.kind and nothing else", () => {
    const { sql, params } = compile(sessionKindWhere("receipt"));
    expect(sql).toContain("#>> '{kind}'");
    expect(params).toContain(AGENT_PROPOSAL_PACKAGE_KIND);
    expect(sql).not.toContain("playbook_id");
    expect(sql).not.toContain("automationRunId");
  });

  it("guards `run` with the receipt override — the ORDER, in SQL", () => {
    // The TS half returns early on a receipt. The SQL half has no early
    // return, so the override has to be an explicit conjunct; without it a
    // receipt minted by openRunSession would be listed as a run.
    const { sql } = compile(sessionKindWhere("run"));
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).toContain("#>> '{kind}'");
    expect(sql).toContain("origin");
    expect(sql).toContain("playbook_id");
    expect(sql).toContain("#>> '{automationRunId}'");
  });

  it("`work` negates every run signal AND the receipt marker", () => {
    const { sql, params } = compile(sessionKindWhere("work"));
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).toContain('playbook_id" is null');
    expect(sql).toContain("#>> '{automationRunId}' IS NULL");
    // NULL origin must stay in `work`: `not(origin in (...))` alone is NULL on
    // a NULL origin and the row would vanish from BOTH lenses — the trap
    // `notTriagePendingWhere` documents. The explicit `is null` is the proof.
    expect(sql).toContain('origin" is null');
    expect(params).toContain(AGENT_PROPOSAL_PACKAGE_KIND);
  });

  it("every declared kind compiles", () => {
    for (const kind of SESSION_KINDS) {
      expect(compile(sessionKindWhere(kind)).sql.length).toBeGreaterThan(0);
    }
  });
});

describe("BOTH automation keys, in BOTH halves", () => {
  // `openRunSession` stamps `automationId` (the definition) and
  // `automationRunId` (the execution) independently. Reading one key is how the
  // runs ledger and the row projection came to disagree: the ledger excluded on
  // `automationId`, the reaper keyed on `automationRunId`, and a row carrying
  // only the other was classified two ways.
  const KEYS = ["automationId", "automationRunId"] as const;

  for (const key of KEYS) {
    it(`TS: metadata.${key} alone makes a row a run`, () => {
      expect(
        projectSessionKind({ origin: "agent", metadata: { [key]: "x" } })
      ).toBe("run");
    });

    it(`SQL: both the run and the work predicate read metadata.${key}`, () => {
      expect(compile(sessionKindWhere("run")).sql).toContain(`#>> '{${key}}'`);
      expect(compile(sessionKindWhere("work")).sql).toContain(`#>> '{${key}}'`);
    });
  }
});

describe("sessionAutomationWhere — a DEFINITION filter, not a run filter", () => {
  it("keys on metadata.automationId and never on automationRunId", () => {
    const { sql, params } = compile(sessionAutomationWhere("au-9"));
    expect(sql).toContain("#>> '{automationId}'");
    expect(sql).not.toContain("automationRunId");
    expect(params).toContain("au-9");
  });
});

describe("the runs ledger classifies through this predicate, not its own", () => {
  // `services/runs/index.ts` `listSessionRuns` used to hand-write
  // `metadata->>'automationId' IS NULL`, which called receipts session runs and
  // playbook-linked sessions ad-hoc. Source-scanned because the ledger returns
  // UnifiedRun rows and so cannot be asserted through the row projection.
  const LEDGER = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../runs/index.ts"),
    "utf8"
  );

  it("narrows with the shared work predicate", () => {
    expect(LEDGER).toContain('sessionKindWhere("work")');
  });

  it("carries no second classification of its own", () => {
    // Comments stripped first: the block comment at the call site NAMES the
    // literal it replaced, which is how a fix explains itself, not a second
    // spelling of the rule. (`focus-session-close-event-one-name.test.ts`
    // makes the same distinction for the same reason.)
    const code = LEDGER.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/[^\n]*/g,
      "$1"
    );
    expect(code).not.toMatch(/->>'automationId'/);
  });
});

describe("ambient attribution files writes under WORK only", () => {
  it("the MCP ambient-session resolver narrows to sessionKindWhere('work')", () => {
    // Which session an agent's write is FILED UNDER is decided here. An open
    // run or receipt is often the newest open session (08:00 crons), and
    // attributing a write to it is exactly the mis-grouping this guards.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "../../../routers/mcp/handlers/shared.ts"),
      "utf8"
    );
    const fn = src.slice(
      src.indexOf("export async function listOpenFocusSessions")
    );
    const body = fn.slice(0, fn.indexOf(".orderBy("));
    expect(body).toContain('sessionKindWhere("work")');
  });
});
