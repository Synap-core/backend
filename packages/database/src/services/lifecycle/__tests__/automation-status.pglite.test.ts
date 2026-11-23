/**
 * The automation machine on a real Postgres (PGlite):
 *  - `setAutomationStatus` is a compare-and-set: a row that moved meanwhile is
 *    left as it is, and a move `AUTOMATION_TRANSITIONS` does not list (an
 *    archived automation paused) writes nothing;
 *  - `insertAutomation` gives a row its birth status from one decision: a
 *    person's approval activates (with its first cron slot), an agent's
 *    automation no person approved is born draft;
 *  - 0447's CHECK refuses a status no machine declares.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../schema/index.js";
import { ddlFor } from "./lifecycle-pglite.js";
import { setAutomationStatus } from "../automation-status.js";
import { insertAutomation } from "../../../utils/insert-automation.js";
import {
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_STATUSES,
  PLAYBOOK_STATUSES,
  STAGE_RUN_STATUSES,
} from "@synap-core/types/units";

const M0447 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../migrations/0447_machine_status_checks.sql"
  ),
  "utf8"
);

const BASELINE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../migrations/0000_baseline_schema.sql"
  ),
  "utf8"
);

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle over PGlite
let db: any;
const WS = randomUUID();
const PERSON = { ownerId: "u-person", agentUserId: null };
const AGENT = { ownerId: "u-person", agentUserId: "u-agent" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(ddlFor(schema.automations as unknown as PgTable));
  await pg.exec(M0447);
  // The structure floor's class row (`@agent-builds-structure`, 0451).
  await pg.exec(`CREATE TABLE governance_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_kind text NOT NULL, scope_kind text NOT NULL,
    target_kind text NOT NULL, target_pattern text NOT NULL,
    verdict text NOT NULL, created_by text, revoked_at timestamptz
  );`);
  db = drizzle(pg, { schema });
}, 120_000);
afterAll(async () => pg?.close());

async function row(status: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO automations (id, workspace_id, created_by, name, trigger_type, status)
     VALUES (gen_random_uuid(), $1, 'u-person', $2, 'manual', $3) RETURNING id`,
    [WS, `a-${randomUUID()}`, status]
  );
  return r.rows[0]!.id;
}
async function statusOf(id: string): Promise<string> {
  const r = await pg.query<{ status: string }>(
    `SELECT status FROM automations WHERE id = $1`,
    [id]
  );
  return r.rows[0]!.status;
}
const definition = (triggerType: "manual" | "cron") => ({
  workspaceId: WS,
  name: `n-${randomUUID()}`,
  triggerType,
  triggerConfig: triggerType === "cron" ? { expression: "0 9 * * *" } : {},
  flowDefinition: { nodes: [], edges: [] },
});

describe("setAutomationStatus", () => {
  it("moves a row that stands in `from`, with the caller's columns", async () => {
    const id = await row("active");
    const moved = await setAutomationStatus(db, {
      id,
      from: "active",
      to: "error",
      set: { errorMessage: "broke" },
    });
    expect(moved.map((r) => r.status)).toEqual(["error"]);
    const r = await pg.query<{ error_message: string }>(
      `SELECT error_message FROM automations WHERE id = $1`,
      [id]
    );
    expect(r.rows[0]!.error_message).toBe("broke");
  });

  it("leaves a row that moved meanwhile as it is", async () => {
    const id = await row("paused");
    const moved = await setAutomationStatus(db, {
      id,
      from: "active",
      to: "error",
    });
    expect(moved).toEqual([]);
    expect(await statusOf(id)).toBe("paused");
  });

  it("never makes a move the transition table does not list", async () => {
    const id = await row("archived");
    const moved = await setAutomationStatus(db, {
      id,
      from: "archived",
      to: "paused",
    });
    expect(moved).toEqual([]);
    expect(await statusOf(id)).toBe("archived");
  });
});

describe("insertAutomation — the birth status", () => {
  it("a person's approval activates a cron automation with its first slot", async () => {
    const made = await insertAutomation(db, {
      values: definition("cron"),
      personApproved: true,
      owner: AGENT,
    });
    expect(made).toMatchObject({ status: "active", created: true });
    const r = await pg.query<{ status: string; next_run_at: Date | null }>(
      `SELECT status, next_run_at FROM automations WHERE id = $1`,
      [made!.id]
    );
    expect(r.rows[0]!.status).toBe("active");
    expect(r.rows[0]!.next_run_at).not.toBeNull();
  });

  it("an agent's automation no person approved is born draft, whatever it asked", async () => {
    const made = await insertAutomation(db, {
      values: definition("cron"),
      requested: "active",
      personApproved: false,
      owner: AGENT,
    });
    expect(made?.status).toBe("draft");
    expect(await statusOf(made!.id)).toBe("draft");
  });

  it("with the pod's structure floor switched on, an agent's create keeps what it asked", async () => {
    await pg.exec(`INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('any', 'pod', 'action', '@agent-builds-structure', 'auto', 'user:u-person')`);
    try {
      const made = await insertAutomation(db, {
        values: definition("manual"),
        requested: "active",
        personApproved: false,
        owner: AGENT,
      });
      expect(made?.status).toBe("active");
    } finally {
      await pg.exec(`UPDATE governance_rules SET revoked_at = now()`);
    }
    // Switched off (revoked): back to draft.
    const after = await insertAutomation(db, {
      values: definition("manual"),
      requested: "active",
      personApproved: false,
      owner: AGENT,
    });
    expect(after?.status).toBe("draft");
  });

  it("a person's own create keeps what it asked, draft when nothing", async () => {
    const asked = await insertAutomation(db, {
      values: definition("manual"),
      requested: "paused",
      personApproved: false,
      owner: PERSON,
    });
    const unstated = await insertAutomation(db, {
      values: definition("manual"),
      personApproved: false,
      owner: PERSON,
    });
    expect([asked?.status, unstated?.status]).toEqual(["paused", "draft"]);
  });
});

describe("0447", () => {
  it("spells each machine's declared set", async () => {
    const tables = {
      automations: AUTOMATION_STATUSES,
      automation_runs: AUTOMATION_RUN_STATUSES,
      playbooks: PLAYBOOK_STATUSES,
      session_stage_runs: STAGE_RUN_STATUSES,
    };
    const baseline = BASELINE.slice(BASELINE.indexOf("-- 0447:"));
    for (const sql of [M0447, baseline]) {
      for (const [table, declared] of Object.entries(tables)) {
        const block = sql.slice(sql.indexOf(`('${table}', `));
        const listed = /ARRAY\[([^\]]*)\]/
          .exec(block)![1]!
          .split(",")
          .map((w) => w.trim().replace(/'/g, ""));
        expect(listed, table).toEqual([...declared]);
      }
    }
  });

  it("validates the CHECK when no row holds a stray word", async () => {
    const c = await pg.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'automations_status_check'`
    );
    expect(c.rows).toEqual([{ convalidated: true }]);
  });

  it("refuses a status no machine declares", async () => {
    await expect(row("enabled")).rejects.toThrow(/automations_status_check/);
  });

  it("adds the CHECK NOT VALID, and says so, when old rows hold an undeclared word", async () => {
    const legacy = new PGlite();
    try {
      await legacy.exec(ddlFor(schema.automationRuns as unknown as PgTable));
      await legacy.query(
        `INSERT INTO automation_runs (automation_id, workspace_id, status)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'pending')`
      );
      await legacy.exec(M0447);
      const c = await legacy.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'automation_runs_status_check'`
      );
      expect(c.rows).toEqual([{ convalidated: false }]);
      await expect(
        legacy.query(
          `INSERT INTO automation_runs (automation_id, workspace_id, status)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'pending')`
        )
      ).rejects.toThrow(/automation_runs_status_check/);
    } finally {
      await legacy.close();
    }
  });
});
