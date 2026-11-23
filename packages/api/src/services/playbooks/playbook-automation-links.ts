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
 * `playbooks.flow_automation_id` is only CLEARED beside the join row (nothing
 * writes a driver any more; the browser still reads it). The legacy
 * `member_of` link rows stay where they are (no reader since 0425; a rollback's
 * trigger matcher still reads them), and nothing writes new ones.
 */
import {
  and,
  asc,
  automations,
  eq,
  inArray,
  playbookAutomations,
  playbooks,
  type getDb,
} from "@synap/database";
import type { AutomationStatusValue } from "@synap-core/types/units";

type Db = Awaited<ReturnType<typeof getDb>>;
/** A transaction passes too: it is the same database surface. */
type Writer = Pick<Db, "update" | "delete">;

/** The role of the automation a retired `schedule` drove (folded into an activator; rows may remain). */
export const SCHEDULE_ROLE = "schedule";
/** The role of the automation a playbook canvas saved (rows may still exist; no door writes it any more). */
export const FLOW_ROLE = "flow";
/**
 * The role of a LINK's automation: a `run_ended` activator compiled to a rule
 * ("when a run of X ends, start this playbook", `playbook-links.ts`). The
 * other activators' automations carry `activator`.
 */
export const LINK_ROLE = "link";
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

/** The automation a retired `schedule` drove, as the fold needs it. */
export interface ScheduleDriver {
  id: string;
  status: AutomationStatusValue;
  metadata: Record<string, unknown> | null;
  triggerConfig: unknown;
}

/** The playbook's role-`schedule` automation, or null. */
export async function readScheduleDriver(
  db: Pick<Db, "select">,
  playbookId: string
): Promise<ScheduleDriver | null> {
  const [row] = await db
    .select({
      id: automations.id,
      status: automations.status,
      metadata: automations.metadata,
      triggerConfig: automations.triggerConfig,
    })
    .from(playbookAutomations)
    .innerJoin(
      automations,
      eq(automations.id, playbookAutomations.automationId)
    )
    .where(
      and(
        eq(playbookAutomations.playbookId, playbookId),
        eq(playbookAutomations.role, SCHEDULE_ROLE)
      )
    )
    .limit(1);
  return row
    ? {
        ...row,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      }
    : null;
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
