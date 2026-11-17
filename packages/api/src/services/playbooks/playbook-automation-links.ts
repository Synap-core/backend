/**
 * ONE LINK PER RELATION: a playbook → its automations, in `playbook_automations`
 * only (Process wave plan 0adf8352, W2; migration 0425).
 *
 * Until 0425 the relation had three stored carriers and one implicit one:
 * `playbooks.flow_automation_id` (the cron schedule's backing automation, or the
 * canvas flow), the `playbook_automations` join table (activators, composition),
 * the legacy link `automation --member_of--> playbook` (dual-written), and a
 * `playbook_run` node naming a playbook by name. A process read built on that
 * counted different automations depending on the carrier it read. Now:
 *   - every WRITER goes through this module or the join table directly;
 *   - every backend READER reads the join table only;
 *   - the driving automation (the one `flow_automation_id` named) is the join
 *     row with role `schedule` (a cron backing row) or `flow` (the canvas);
 *   - a by-name `playbook_run` node is resolved to an id at save
 *     (`routers/automations.ts`, `injectPlaybookIdsFromNames`).
 *
 * KEPT ONE RELEASE (owed to W5): `playbooks.flow_automation_id` is still
 * WRITTEN beside the join row, because the browser before this release reads
 * it (processors `process-flow-facts.ts`). No backend code reads it. The legacy
 * `member_of` link rows stay where they are (no reader since 0425; a rollback's
 * trigger matcher still reads them), and nothing writes new ones.
 */
import {
  and,
  asc,
  eq,
  inArray,
  ne,
  playbookAutomations,
  playbooks,
  type getDb,
} from "@synap/database";

type Db = Awaited<ReturnType<typeof getDb>>;
type Writer = Pick<Db, "insert" | "update" | "delete" | "select">;

/** The role of the automation that drives a playbook from a cron schedule. */
export const SCHEDULE_ROLE = "schedule";
/** The role of the automation the playbook canvas saved (`playbooks.saveFlow`). */
export const FLOW_ROLE = "flow";
/** The two roles `flow_automation_id` stood for: the playbook's driving automation. */
export const DRIVER_ROLES: readonly string[] = [SCHEDULE_ROLE, FLOW_ROLE];

/** The automation that drives a playbook (its schedule or canvas flow), or null. */
export async function readDriverAutomationId(
  db: Pick<Db, "select">,
  playbookId: string
): Promise<string | null> {
  const [row] = await db
    .select({ automationId: playbookAutomations.automationId })
    .from(playbookAutomations)
    .where(
      and(
        eq(playbookAutomations.playbookId, playbookId),
        inArray(playbookAutomations.role, [...DRIVER_ROLES])
      )
    )
    .orderBy(asc(playbookAutomations.createdAt))
    .limit(1);
  return row?.automationId ?? null;
}

/**
 * Make `automationId` the playbook's ONE driving automation, in the role given:
 * any other driver row of the playbook is removed, the row is upserted (an
 * existing composition of the same automation takes the driver role), and
 * `flow_automation_id` is written for the old browser (one release, W5).
 */
export async function setDriverAutomation(
  db: Writer,
  input: { playbookId: string; automationId: string; role: string }
): Promise<void> {
  await db
    .delete(playbookAutomations)
    .where(
      and(
        eq(playbookAutomations.playbookId, input.playbookId),
        inArray(playbookAutomations.role, [...DRIVER_ROLES]),
        ne(playbookAutomations.automationId, input.automationId)
      )
    );
  // Update-then-insert rather than ON CONFLICT: the same answer, and it holds
  // on a table built without its unique index (the PGlite route tests build
  // every table from its columns).
  const moved = await db
    .update(playbookAutomations)
    .set({ role: input.role, updatedAt: new Date() })
    .where(
      and(
        eq(playbookAutomations.playbookId, input.playbookId),
        eq(playbookAutomations.automationId, input.automationId)
      )
    )
    .returning({ id: playbookAutomations.id });
  if (moved.length === 0) {
    await db.insert(playbookAutomations).values({
      playbookId: input.playbookId,
      automationId: input.automationId,
      role: input.role,
    });
  }
  // KEPT ONE RELEASE: the old browser reads it. Drop owed to W5.
  await db
    .update(playbooks)
    .set({ flowAutomationId: input.automationId, updatedAt: new Date() })
    .where(eq(playbooks.id, input.playbookId));
}

/** The playbook has no driving automation any more (its schedule was turned off). */
export async function clearDriverAutomation(
  db: Writer,
  playbookId: string
): Promise<void> {
  await db
    .delete(playbookAutomations)
    .where(
      and(
        eq(playbookAutomations.playbookId, playbookId),
        inArray(playbookAutomations.role, [...DRIVER_ROLES])
      )
    );
  // KEPT ONE RELEASE: the old browser reads it. Drop owed to W5.
  await db
    .update(playbooks)
    .set({ flowAutomationId: null, updatedAt: new Date() })
    .where(eq(playbooks.id, playbookId));
}

/** Compose an automation into a playbook (the join row; the legacy link is no longer written). */
export async function addPlaybookAutomation(
  db: Pick<Db, "insert">,
  input: {
    playbookId: string;
    automationId: string;
    role?: string | null;
    sortOrder?: number | null;
  }
): Promise<void> {
  await db
    .insert(playbookAutomations)
    .values({
      playbookId: input.playbookId,
      automationId: input.automationId,
      role: input.role ?? null,
      sortOrder: input.sortOrder ?? null,
    })
    .onConflictDoNothing({
      target: [
        playbookAutomations.playbookId,
        playbookAutomations.automationId,
      ],
    });
}
