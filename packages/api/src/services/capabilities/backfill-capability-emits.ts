/**
 * backfillCapabilityEmits — light up the rules-ecosystem "WHEN" menu for genuine
 * event producers.
 *
 * The "declared" tier of `automations.availableTriggerEvents` reads
 * `capabilities.metadata.emits: string[]`. A fresh install populates it from the
 * `CapabilityDefinition.emits` the applier persists — but capabilities installed
 * BEFORE that field existed (and today's bridges, which declare no `emits` in
 * their templates yet) would leave the menu empty, so the honest menu would be
 * invisible even though the pod HAS producers.
 *
 * This idempotent boot backfill closes that gap by REUSING the existing producer
 * classification (`deriveCapabilityMode` — the callable-vs-standing axis, the
 * SAME decision Signal's Door 7 makes): a capability whose derived mode is
 * `standing` (a messaging/channel bridge — Discord/Telegram/Proton — detected by
 * a declared `metadata.mode`, a `transport:'bridge'` member tool, OR a
 * `part --produced--> channel` edge) is declared to emit the two physical channel
 * message events (`CHANNEL_EVENT_TYPES`, the SSOT the channel⇄automation binding
 * already uses).
 *
 * SAFETY: it NEVER overwrites an explicit declaration — a capability whose
 * `metadata.emits` key is already present (even `[]`) is skipped entirely. It
 * reads across ALL capabilities (a maintenance pass, like `backfillGovernanceRules`
 * — no per-user floor, boot runs as the system) and reports exactly which
 * capabilities it lit up and with which patterns.
 *
 * DELIBERATELY NARROW: standing bridges map to the messaging pair only. A
 * non-messaging standing producer (e.g. a cron data-source) is left undeclared
 * rather than guessing its patterns — declaring a phantom would be worse than an
 * empty menu. Those producers should declare `emits` in their template
 * (`CapabilityDefinition.emits`), the canonical path this backfill only backstops.
 */

import { getDb, and, eq, inArray, links } from "@synap/database";
import { capabilities, tools } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { getCapabilityMemberParts } from "../links/links-service.js";
import { deriveCapabilityMode } from "../signal/capability-mode.js";
import { CHANNEL_EVENT_TYPES } from "../signal/channel-automation-binding.js";

const logger = createLogger({ module: "backfill-capability-emits" });

export interface BackfillCapabilityEmitsResult {
  /** Capabilities scanned (those still missing a `metadata.emits` key). */
  scanned: number;
  /** Capabilities this pass lit up, with the patterns written. */
  litUp: { id: string; name: string; emits: string[] }[];
}

/** The messaging patterns a standing (channel-producing) bridge emits. */
const STANDING_BRIDGE_EMITS: string[] = [...CHANNEL_EVENT_TYPES];

/** True when a capability already carries an explicit `emits` declaration. */
function hasExplicitEmits(metadata: unknown): boolean {
  const m = (metadata ?? {}) as Record<string, unknown>;
  return Array.isArray(m.emits);
}

export async function backfillCapabilityEmits(): Promise<BackfillCapabilityEmitsResult> {
  const db = await getDb();

  // 1. All capabilities still missing an explicit `emits` — the only candidates.
  const allCaps = await db
    .select({
      id: capabilities.id,
      name: capabilities.name,
      metadata: capabilities.metadata,
    })
    .from(capabilities);
  const candidates = allCaps.filter((c) => !hasExplicitEmits(c.metadata));
  if (candidates.length === 0) return { scanned: 0, litUp: [] };
  const candidateIds = candidates.map((c) => c.id);

  // 2. Member parts (tool|skill|command) for every candidate — one batched read.
  const parts = await getCapabilityMemberParts(candidateIds);
  const partIdToCapId = new Map<string, string>();
  const toolPartIds: string[] = [];
  for (const p of parts) {
    partIdToCapId.set(p.id, p.capabilityId);
    if (p.kind === "tool") toolPartIds.push(p.id);
  }

  // 3. Member tools' configs (for the `transport:'bridge'` derivation rung),
  //    grouped per capability.
  const configsByCapId = new Map<string, unknown[]>();
  if (toolPartIds.length > 0) {
    const toolRows = await db
      .select({ id: tools.id, config: tools.config })
      .from(tools)
      .where(inArray(tools.id, toolPartIds));
    for (const t of toolRows) {
      const capId = partIdToCapId.get(t.id);
      if (!capId) continue;
      const list = configsByCapId.get(capId) ?? [];
      list.push(t.config);
      configsByCapId.set(capId, list);
    }
  }

  // 4. Produced channels: `part --produced--> channel`, counted per capability.
  const producedByCapId = new Map<string, number>();
  const allPartIds = [...partIdToCapId.keys()];
  if (allPartIds.length > 0) {
    const producedRows = await db
      .select({ fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.linkType, "produced"),
          eq(links.toType, "channel"),
          inArray(links.fromId, allPartIds)
        )
      );
    for (const r of producedRows) {
      const capId = partIdToCapId.get(r.fromId);
      if (!capId) continue;
      producedByCapId.set(capId, (producedByCapId.get(capId) ?? 0) + 1);
    }
  }

  // 5. Derive mode per candidate; standing ⇒ declare the messaging pair.
  const litUp: BackfillCapabilityEmitsResult["litUp"] = [];
  for (const cap of candidates) {
    const { mode } = deriveCapabilityMode({
      metadata: cap.metadata,
      memberToolConfigs: configsByCapId.get(cap.id) ?? [],
      producedChannelCount: producedByCapId.get(cap.id) ?? 0,
    });
    if (mode !== "standing") continue;

    const existing = (cap.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(capabilities)
      .set({
        metadata: { ...existing, emits: STANDING_BRIDGE_EMITS },
        updatedAt: new Date(),
      })
      .where(eq(capabilities.id, cap.id));
    litUp.push({ id: cap.id, name: cap.name, emits: STANDING_BRIDGE_EMITS });
  }

  if (litUp.length > 0) {
    logger.info(
      { count: litUp.length, litUp },
      "backfillCapabilityEmits: declared metadata.emits for standing (bridge) capabilities"
    );
  }
  return { scanned: candidates.length, litUp };
}
