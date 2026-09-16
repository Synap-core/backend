/**
 * Ensure Intent-First Project Creation is auto-installed on every pod.
 *
 * This follows the exact same pattern as ensureSynapCoreCapability and
 * ensureSystemSkills: called at pod startup, idempotent + drift-healing +
 * non-fatal. Installs the workspace template + capability + seeds the
 * system intent-decomposition skill, so every pod has the intent-first
 * project creation playbook auto-available.
 *
 * Idempotent: re-running does nothing if already installed (the template
 * and capability already exist on the pod, and the system skill row is
 * deduplicated).
 * Non-fatal: any failure is logged and the pod starts normally without
 * this feature — no breaking change.
 *
 * Wiring: same as ensureSystemSkills — runs after ensureSystemSkills so
 * the system owner user exists. Skipped on pre-bootstrap (no owner yet).
 */
import { createLogger } from "@synap-core/core";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import { ensureSystemSkills } from "./ensure-system-skills.js";
import { runMarketInstall } from "./marketplace-install.js";

const logger = createLogger({ module: "ensure-intent-first-project" });

export async function ensureIntentFirstProject(): Promise<void> {
  try {
    const ownerUserId = await resolvePodOwnerUserId();
    if (!ownerUserId) {
      logger.info(
        "No pod owner yet (pre-bootstrap) — deferring intent-first project install to a later boot"
      );
      return;
    }

    // Install the workspace template (pod-wide, workspaceId: null)
    const templateInstalled = await runMarketInstall({
      kind: "template" as const,
      slug: "intent-first-project",
      userId: ownerUserId,
      workspaceId: null,
    });

    // Install the capability (pod-wide, workspaceId: null)
    const capabilityInstalled = await runMarketInstall({
      kind: "capability" as const,
      slug: "intent-first-project",
      userId: ownerUserId,
      workspaceId: null,
    });

    // Seed the system skill (intent-decomposition) — idempotent, already handled
    // by ensureSystemSkills, but we call it here for completeness and to ensure
    // the skill is linked to the intent-first-project capability.
    await ensureSystemSkills();

    logger.info(
      {
        templateInstalled,
        capabilityInstalled,
        ownerUserId,
      },
      "Intent-first project creation auto-installed on pod"
    );
  } catch (err) {
    logger.warn(
      { err },
      "Failed to install intent-first project creation on startup (non-fatal)"
    );
  }
}
