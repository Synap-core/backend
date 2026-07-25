/**
 * Automation CATALOG read-model — the automation SIBLING of
 * `buildCapabilityCatalog` (capability-catalog.ts).
 *
 * Automations are a SEPARATE marketplace kind from capabilities (product
 * decision: an automation USES capabilities, it is not merged INTO the
 * "capability" kind). This builder surfaces automations in the unified
 * `/capabilities/catalog` door ALONGSIDE capability cards but as a distinct
 * `kind:"automation"` list — never folded into the `CapabilityCard` array. The
 * capability read path (buildCapabilityCatalog) is left completely untouched.
 *
 * Two sources, mirroring the capability builder's installed/available split:
 *   - AVAILABLE: automation PACKAGES the pod knows from `cp_catalog_cache`
 *     (kind="automation") — kept fresh by @synap/jobs `cp-catalog-sync`. These
 *     are workflow packages that bundle one or more automations. The cached row
 *     is list-view only (no definition body) — enough for a discovery card; the
 *     full definition is fetched at install time (marketplace-install.ts).
 *   - INSTALLED: the workspace's own `automations` rows (the runtime instances),
 *     scoped by the same user-visible membership floor the capability builder
 *     uses for its containers.
 *
 * De-dup: an available package whose NAME matches an installed automation is
 * treated as installed and dropped from the available list — the direct analog
 * of the capability builder's name-based `installedNames` collapse (an installed
 * capability container is matched to its template by name). Automations carry NO
 * package-provenance column, so name is the only ADDITIVE signal available
 * without a schema change or a per-package definition fetch on the read path.
 *
 * Read-only and resilient: a cache miss or an empty workspace simply yields
 * fewer cards, never a throw.
 */

import { db, eq, and, or, isNull } from "@synap/database";
import { automations } from "@synap/database/schema";

import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { queryCatalogCache } from "./catalog-cache-query.js";
import type { CapabilityCatalogContext } from "./capability-catalog.js";

// ── Contract ──────────────────────────────────────────────────────────────────

export type AutomationCardStatus = "available" | "installed";

export interface AutomationCard {
  /** Discriminator — this is an AUTOMATION card, never a capability. */
  kind: "automation";
  /** Installed automation row id; null for an available-only package. */
  id: string | null;
  /** Stable identity: catalog slug (available) or the automation id (installed). */
  key: string;
  name: string;
  description?: string | null;
  source: "installed" | "available";
  status: AutomationCardStatus;
  /** Installed only — the automation's lifecycle status. */
  lifecycle?: "draft" | "active" | "paused" | "error";
  /** Installed only — the automation's trigger type. */
  triggerType?: "event" | "cron" | "webhook" | "manual";
  nextAction: {
    kind: "add" | "run" | "none";
    hint: string;
  };
}

// ── Inputs to the pure assembler (so it is testable without a DB) ─────────────

export interface AvailableAutomationInput {
  slug: string;
  name: string;
  description?: string | null;
}

export interface InstalledAutomationInput {
  id: string;
  name: string;
  description?: string | null;
  status: "draft" | "active" | "paused" | "error";
  triggerType: "event" | "cron" | "webhook" | "manual";
}

function automationNextAction(
  status: AutomationCardStatus,
  name: string
): AutomationCard["nextAction"] {
  return status === "available"
    ? { kind: "add", hint: `Add "${name}" to install it.` }
    : { kind: "run", hint: `Run "${name}".` };
}

/**
 * PURE assembly of automation cards from the two sources. Installed rows become
 * `installed` cards; available packages become `available` cards UNLESS their
 * name matches an installed automation (name-based de-dup, mirroring the
 * capability builder). Kept pure — no DB, no network — so the discovery contract
 * (separate kind, correct status, de-dup) is unit-testable in isolation.
 */
export function assembleAutomationCards(
  available: AvailableAutomationInput[],
  installed: InstalledAutomationInput[]
): AutomationCard[] {
  const cards: AutomationCard[] = [];
  const installedNames = new Set(installed.map((a) => a.name.toLowerCase()));

  for (const a of installed) {
    cards.push({
      kind: "automation",
      id: a.id,
      key: a.id,
      name: a.name,
      description: a.description ?? null,
      source: "installed",
      status: "installed",
      lifecycle: a.status,
      triggerType: a.triggerType,
      nextAction: automationNextAction("installed", a.name),
    });
  }

  for (const pkg of available) {
    if (installedNames.has(pkg.name.toLowerCase())) continue;
    cards.push({
      kind: "automation",
      id: null,
      key: pkg.slug,
      name: pkg.name,
      description: pkg.description ?? null,
      source: "available",
      status: "available",
      nextAction: automationNextAction("available", pkg.name),
    });
  }

  return cards;
}

// ── The builder ───────────────────────────────────────────────────────────────

export async function buildAutomationCatalog(
  ctx: CapabilityCatalogContext
): Promise<AutomationCard[]> {
  const { workspaceId, userId } = ctx;

  // AVAILABLE — automation packages from the pod-local cp_catalog_cache
  // (kind="automation"), synced by cp-catalog-sync. List-view rows (definition
  // null) are all a discovery card needs; the full definition is fetched at
  // install time. Degrade to no available packages on any read failure.
  let available: AvailableAutomationInput[] = [];
  try {
    const entries = await queryCatalogCache({ kind: "automation" });
    available = entries.map((e) => ({
      slug: e.slug,
      name: e.name,
      description: e.description,
    }));
  } catch {
    // Catalog cache unreadable → no available packages (never throw).
  }

  // INSTALLED — the workspace's own automations: pod-wide (NULL) + this
  // workspace, narrowed by the user-visible membership floor. Mirrors the
  // capability builder's container scoping. Degrade to none on failure.
  let installed: InstalledAutomationInput[] = [];
  try {
    const rows = await db
      .select({
        id: automations.id,
        name: automations.name,
        description: automations.description,
        status: automations.status,
        triggerType: automations.triggerType,
      })
      .from(automations)
      .where(
        and(
          or(
            isNull(automations.workspaceId),
            eq(automations.workspaceId, workspaceId)
          ),
          userVisibleWhere(automations.workspaceId, userId)
        )
      );
    installed = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      triggerType: r.triggerType,
    }));
  } catch {
    // Automations read failed → no installed cards (never throw).
  }

  return assembleAutomationCards(available, installed);
}
