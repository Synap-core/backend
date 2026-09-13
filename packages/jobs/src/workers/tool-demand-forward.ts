/**
 * Tool demand forwarding (decision D2) — the pod tells its Control Plane which
 * tools its users want that Synap cannot connect yet.
 *
 * WHAT LEAVES THE POD: `{ toolKey }` per distinct normalized key across every
 * live `tool_request` entity whose status is still `wanted`. No user id, no
 * title, no provider key, no content — and the key must match
 * `TOOL_KEY_PATTERN`, so free text never passes. The CP learns the pod from
 * the verified relay JWT, never from the body (and its body schema is strict).
 *
 * AUTH: the pod's CP relay JWT (`type:"pod_relay"`) — the same credential the
 * connector broker uses, read through `readCpRelayCredential`.
 *
 * HONESTY: every run records its outcome on
 * `pod_settings.settings.toolDemandForward` — forwarded, nothing to forward, or
 * NOT forwarded with the reason. A missing CP credential reads as
 * "not forwarded: CP credential missing", never as success or as silence.
 *
 * Runs daily, plus a debounced one-off after each applied demand write
 * (`recordToolDemand` in @synap/api enqueues this queue).
 */

import {
  db,
  drizzleSql,
  and,
  eq,
  isNull,
  profileSlugScopeCondition,
  readCpRelayCredential,
} from "@synap/database";
import { entities, podSettings } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  TOOL_DEMAND_FORWARD_QUEUE,
  TOOL_KEY_PATTERN,
} from "@synap-core/types/tools";

const logger = createLogger({ module: "tool-demand-forward" });

export { TOOL_DEMAND_FORWARD_QUEUE };
/** Daily at 04:17 UTC. */
export const TOOL_DEMAND_FORWARD_CRON = "17 4 * * *";

/** Owner of no row — the forward job reads as the pod, never as a user. */
const TOOL_DEMAND_SYSTEM_SCOPE_USER = "system:tool-demand-forward";
/** CP body cap (`POST /api/demand/tools`). */
export const TOOL_DEMAND_MAX_TOOLS = 500;
/**
 * Only unmet demand is forwarded. `installable` / `connected` mean the tool is
 * covered — no longer a signal of what to integrate next.
 */
export const FORWARDED_TOOL_REQUEST_STATUS = "wanted";

export interface ToolDemandItem {
  toolKey: string;
}

export type ToolDemandForwardOutcome =
  | { status: "forwarded"; count: number }
  | { status: "nothing-to-forward" }
  | {
      status: "not-forwarded";
      reason:
        | "cp-url-missing"
        | "cp-credential-missing"
        | "cp-credential-expired"
        | "cp-credential-unreadable"
        | "cp-unreachable"
        | "cp-rejected"
        | "demand-unreadable";
      message: string;
    };

/**
 * The exact payload items: distinct keys that match `TOOL_KEY_PATTERN`, sorted,
 * capped — built ONLY from the key, so no other value can ride along.
 */
export function buildToolDemandPayload(
  rows: ReadonlyArray<{ toolKey: unknown }>
): ToolDemandItem[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (typeof row.toolKey === "string" && TOOL_KEY_PATTERN.test(row.toolKey)) {
      keys.add(row.toolKey);
    }
  }
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, TOOL_DEMAND_MAX_TOOLS)
    .map((toolKey) => ({ toolKey }));
}

async function recordOutcome(outcome: ToolDemandForwardOutcome): Promise<void> {
  const stamp = JSON.stringify({ ...outcome, at: new Date().toISOString() });
  try {
    const [row] = await db
      .select({ id: podSettings.id })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    if (!row) {
      logger.error(
        { outcome },
        "No pod_settings row — tool demand forward outcome not recorded"
      );
      return;
    }
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`jsonb_set(
          coalesce(${podSettings.settings}, '{}'::jsonb),
          '{toolDemandForward}',
          ${stamp}::jsonb,
          true
        )`,
      })
      .where(eq(podSettings.id, row.id));
  } catch (err) {
    logger.error(
      { err, outcome },
      "Could not record the tool demand forward outcome"
    );
  }
}

async function finish(
  outcome: ToolDemandForwardOutcome
): Promise<ToolDemandForwardOutcome> {
  if (outcome.status === "not-forwarded") {
    logger.warn(
      { reason: outcome.reason, message: outcome.message },
      "Tool demand not forwarded"
    );
  } else {
    logger.info({ outcome }, "Tool demand forward run");
  }
  await recordOutcome(outcome);
  return outcome;
}

export async function handleToolDemandForward(): Promise<ToolDemandForwardOutcome> {
  const cpUrl = (process.env.CONTROL_PLANE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!cpUrl) {
    return finish({
      status: "not-forwarded",
      reason: "cp-url-missing",
      message:
        "Not forwarded: this pod has no CONTROL_PLANE_URL (normal for a self-hosted pod)",
    });
  }

  let rows: Array<{ toolKey: unknown }>;
  try {
    // The kind-aware scope door. This is a trusted pod-wide aggregate with no
    // acting user: `tool_request` is a primary kind, so the kind branch is the
    // whole answer; the system scope owner-floors any role branch to nobody
    // (fail closed — a role wearer is not demand).
    const kindScope = await profileSlugScopeCondition(db, "tool_request", {
      userId: TOOL_DEMAND_SYSTEM_SCOPE_USER,
    });
    rows = await db
      .select({
        toolKey: drizzleSql<
          string | null
        >`${entities.properties}->>'tr_normalized_key'`,
      })
      .from(entities)
      .where(
        and(
          kindScope,
          isNull(entities.deletedAt),
          drizzleSql`${entities.properties}->>'tr_status' = ${FORWARDED_TOOL_REQUEST_STATUS}`
        )
      );
  } catch (err) {
    return finish({
      status: "not-forwarded",
      reason: "demand-unreadable",
      message: `Not forwarded: tool requests could not be read (${err instanceof Error ? err.message : String(err)})`,
    });
  }

  const tools = buildToolDemandPayload(rows);
  if (tools.length === 0) return finish({ status: "nothing-to-forward" });

  let credential: Awaited<ReturnType<typeof readCpRelayCredential>>;
  try {
    credential = await readCpRelayCredential();
  } catch (err) {
    return finish({
      status: "not-forwarded",
      reason: "cp-credential-unreadable",
      message: `Not forwarded: the CP credential could not be read (${err instanceof Error ? err.message : String(err)})`,
    });
  }
  if (!credential) {
    return finish({
      status: "not-forwarded",
      reason: "cp-credential-missing",
      message:
        "Not forwarded: CP credential missing (no relay key from the control plane)",
    });
  }
  if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
    return finish({
      status: "not-forwarded",
      reason: "cp-credential-expired",
      message: `Not forwarded: the CP credential expired on ${credential.expiresAt.toISOString()}`,
    });
  }

  let res: Response;
  try {
    res = await fetch(`${cpUrl}/api/demand/tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.key}`,
      },
      body: JSON.stringify({ tools }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return finish({
      status: "not-forwarded",
      reason: "cp-unreachable",
      message: `Not forwarded: control plane unreachable (${err instanceof Error ? err.message : String(err)})`,
    });
  }
  if (!res.ok) {
    return finish({
      status: "not-forwarded",
      reason: "cp-rejected",
      message: `Not forwarded: control plane answered HTTP ${res.status}`,
    });
  }
  return finish({ status: "forwarded", count: tools.length });
}
