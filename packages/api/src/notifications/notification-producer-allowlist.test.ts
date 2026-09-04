/**
 * S3 registry cleanup — a declared `NOTIFICATION_REGISTRY` entry with ZERO
 * producers is a silent trap: `getNotificationDef()` will happily resolve it,
 * a proposal handler or a future caller can reference the type and believe it
 * fires, and nothing ever tells them it doesn't. This is a SOURCE-SCAN
 * tripwire (same idiom as `capability-drift.projection-parity.tripwire.test.ts`)
 * rather than a runtime test, because "has zero producers" is a claim about
 * the whole `packages/api` source tree, not about one function's behaviour.
 *
 * Deliberately conservative: a type counts as "produced" if its literal string
 * appears ANYWHERE in a non-test, non-registry source file next to `type:` or
 * `notificationType`. That is broader than "is a direct
 * `NotificationService.create()` argument" on purpose — it also matches an
 * indirect producer like `notify-service-unhealthy.ts`, which passes
 * `notificationType: "system.intelligence_degraded"` as an OVERRIDE into
 * `notifyConnectorUnhealthy()` rather than calling `NotificationService.create`
 * itself.
 *
 * If this test fails because the FOUND-set no longer equals the allowlist:
 *   - a type gained a producer → remove its row from the allowlist below
 *     (and consider whether it should be promoted via
 *     `notification-event-map.ts`, S3's mechanism for a real alert to also
 *     reach the event spine).
 *   - a brand-new type was declared with no producer → either wire a real
 *     producer, delete the dead registry row, or add it here with a
 *     "declared, unproduced — remove or produce by <date>" comment; never
 *     let this test silently widen.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NOTIFICATION_REGISTRY } from "./registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..", "..");

/**
 * The explicit, human-reviewed allowlist of registry types with NO producer
 * anywhere in `packages/api/src` as of 2026-09-04 (S3). Every row states WHY
 * it is still declared rather than deleted, and whether it is referenced by a
 * consuming app despite having no backend producer.
 */
const PRODUCERLESS_ALLOWLIST = new Set<string>([
  // ── The original ten (pre-S3 audit) ──────────────────────────────────────
  // Declared, unproduced — remove or produce by 2026-10-01. No governance
  // auto-approval path emits it yet; `governance.proposal_stale` is the only
  // proposal-lifecycle alert actually wired.
  "proposal.auto_approved",
  // Declared, unproduced — remove or produce by 2026-10-01. Referenced by
  // synap-app's `NotificationBanner.tsx` icon map (`packages/core/notifications`),
  // so the FRONTEND already anticipates it — keep the row; only the backend
  // producer (a terminal-exec capability call site) is missing.
  "ai_request.terminal_exec",
  // Declared, unproduced — remove or produce by 2026-10-01. No AI entity-create
  // path distinguishes "created by AI" from an ordinary `entity.create` today.
  "entity.created_by_ai",
  // Declared, unproduced — remove or produce by 2026-10-01. `data.*` bell
  // notifications for raw CRUD were never wired; the event spine already
  // carries `entity.delete.validated` etc. for anyone reading events directly.
  "data.entity.deleted",
  "data.document.created",
  "data.view.created",
  "data.relation.created",
  // Declared, unproduced — remove or produce by 2026-10-01. Inbox triage
  // notifications await the inbox-classification feature.
  "inbox.email",
  "inbox.mention",
  "inbox.priority_item",

  // ── Found during S3 (2026-09-04) — NOT among the six the task named as
  // "raised by live probes / boot reports"; investigation found they have NO
  // caller ANYWHERE (not just no event, no NOTIFICATION either). They are
  // dead registry rows, not live alerts missing an event append. ──────────
  // Declared, unproduced — remove or produce by 2026-10-01. No storage-usage
  // probe exists; nothing computes a `{{percent}}` to pass it.
  "pod.storage_warning",
  // Declared, unproduced — remove or produce by 2026-10-01. Workspace invite
  // creation (`routers/workspaces/invites.ts`) never calls NotificationService
  // — invites are delivered by link/email only today. Not referenced by
  // browser/relay/synap-app either (the string hits found there are an
  // unrelated `/workspace/invite` URL path and a doc comment).
  "workspace.invite",

  // ── Also found during S3 (2026-09-04) — not named by the task, discovered
  // by this same source scan. Each has a SIBLING type in the same category
  // that DOES have a producer (`connector.auth.expired`, `agent.task_failed`,
  // `ai.proactive.insight`), so these read as the rest of an intended set
  // that was never finished, not typos. ──────────────────────────────────
  // Declared, unproduced — remove or produce by 2026-10-01. No connector-sync
  // SUCCESS path notifies; only the failure path
  // (`connector.sync.failed`) and the unhealthy-connection nudge
  // (`connector.auth.expired`, S3-promoted) do. The frontend-looking hits for
  // "connector.sync.complete" are actually the unrelated EVENT type
  // `connector_sync.complete.completed` (underscore grammar, event spine).
  "connector.sync.complete",
  // Declared, unproduced — remove or produce by 2026-10-01. Only the FAILURE
  // half of the agent-task pair (`agent.task_failed`) is wired
  // (`hub-protocol/rest/events.ts`).
  "agent.task_complete",
  // Declared, unproduced — remove or produce by 2026-10-01. `DeliveryService`'s
  // proactive-message path defaults `notificationType` to `"ai.proactive.insight"`
  // — the only member of the `ai.proactive.*` family any caller actually passes.
  "agent.insight",
  "ai.proactive.morning_briefing",
  "ai.proactive.weekly_digest",
  "ai.proactive.health_check",
  "ai.proactive.nudge",
  // Declared, unproduced — remove or produce by 2026-10-01. No pod-version
  // update check exists yet.
  "pod.update_available",
]);

/** Every `.ts` file under `dir`, skipping node_modules/dist/tests/this file. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (full === join(HERE, "registry.ts")) continue; // the declarations themselves
    out.push(full);
  }
  return out;
}

function findProducerlessTypes(): Set<string> {
  const files = collectSourceFiles(API_SRC);
  const contents = files.map((f) => readFileSync(f, "utf8"));

  const producerless = new Set<string>();
  for (const def of NOTIFICATION_REGISTRY) {
    const literal = `"${def.type}"`;
    const hasProducer = contents.some((src) => {
      // Check EVERY occurrence, not just the first — a file can reference the
      // same type literal once as a read-side comparison (`eq(notifications.type,
      // "…")`) and again as the actual producer's `type: "…"` a few lines later
      // (`scan-stale-proposals.ts` does exactly this for `governance.proposal_stale`).
      let idx = src.indexOf(literal);
      while (idx !== -1) {
        const windowStart = Math.max(0, idx - 40);
        const before = src.slice(windowStart, idx);
        if (/(type|notificationType)\s*[:=?]/.test(before)) return true;
        idx = src.indexOf(literal, idx + 1);
      }
      return false;
    });
    if (!hasProducer) producerless.add(def.type);
  }
  return producerless;
}

describe("notification registry — producer-less types stay an explicit, honest allowlist", () => {
  it("the FOUND producer-less set equals the reviewed allowlist exactly", () => {
    const found = findProducerlessTypes();

    const missingFromAllowlist = [...found].filter(
      (t) => !PRODUCERLESS_ALLOWLIST.has(t)
    );
    const staleInAllowlist = [...PRODUCERLESS_ALLOWLIST].filter(
      (t) => !found.has(t)
    );

    expect(
      missingFromAllowlist,
      "A registry type has NO producer but is missing from the allowlist. " +
        "Either wire a producer, delete the dead row, or add it here with a " +
        "'declared, unproduced — remove or produce by <date>' comment."
    ).toEqual([]);

    expect(
      staleInAllowlist,
      "A type in the allowlist now HAS a producer (or was deleted from the " +
        "registry). Remove its row from PRODUCERLESS_ALLOWLIST — and if it is " +
        "one of the six alerts this task promoted, wire it into " +
        "notification-event-map.ts instead of leaving it here."
    ).toEqual([]);
  });

  it("the four S3-promoted alert types are NOT in the allowlist (they have real producers)", () => {
    for (const promoted of [
      "connector.auth.expired",
      "system.intelligence_degraded",
      "system.capability_update_available",
      "system.issuer_pending_approval",
    ]) {
      expect(PRODUCERLESS_ALLOWLIST.has(promoted)).toBe(false);
    }
  });
});
