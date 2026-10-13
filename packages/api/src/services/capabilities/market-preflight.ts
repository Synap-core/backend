/**
 * Market preflight — what installing ONE catalog entry would change, read off
 * the definition the install will apply (`resolveCatalogDefinition`). Pure: no
 * I/O, no writes, so `marketplace.preflight` can show it before anything runs.
 *
 * `applyMarketInstall` has no dry-run mode, and adding one would thread a
 * "pretend" flag through six governed doors that each write as they go. The
 * honest preview is the one this module gives: the facts the install reads
 * from the definition (what it adds, where it lands, what it asks for), never
 * a guess at what the doors would decide. A template's write-free plan comes
 * from the workspace preflight core instead (`preflightWorkspaceFromDefinition`),
 * which this module only complements with the living layers that core skips.
 */

import type { CatalogKind } from "@synap/jobs";

/**
 * Where the install lands:
 *   creates  — it builds (or converges onto) its own space (template).
 *   required — it is added INTO a space the installer names (automation, view).
 *   optional — pod-wide unless a space is named (capability, skill, cell).
 */
export type MarketWorkspaceNeed = "creates" | "required" | "optional";

/** One kind of thing the install adds, named in the registry's own kind token. */
export interface MarketInstallPart {
  kind: string;
  names: string[];
}

/** An install-time parameter the package declares (a capability's `params`). */
export interface MarketInstallParam {
  name: string;
  label: string | null;
  description: string | null;
  required: boolean;
  hasDefault: boolean;
}

export interface MarketInstallSummary {
  workspace: MarketWorkspaceNeed;
  adds: MarketInstallPart[];
  /** Plain sentences a person reads before confirming. */
  notices: string[];
  params: MarketInstallParam[];
}

type Def = Record<string, unknown>;

function asRecord(value: unknown): Def | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Def)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The display name an authored item carries, in the order authors use them. */
function nameOf(item: unknown): string | null {
  const r = asRecord(item);
  if (!r) return str(item);
  return (
    str(r.displayName) ??
    str(r.name) ??
    str(r.workspaceName) ??
    str(r.slug) ??
    str(r.key)
  );
}

function names(items: unknown[]): string[] {
  return items.map(nameOf).filter((n): n is string => n !== null);
}

function part(kind: string, items: unknown[]): MarketInstallPart[] {
  const list = names(items);
  return list.length > 0 ? [{ kind, names: list }] : [];
}

function paramsOf(def: Def): MarketInstallParam[] {
  return asArray(def.params).flatMap((p) => {
    const r = asRecord(p);
    const name = r ? str(r.name) : null;
    if (!r || !name) return [];
    return [
      {
        name,
        label: str(r.label),
        description: str(r.description),
        required: r.required === true,
        hasDefault: r.default !== undefined,
      },
    ];
  });
}

/** A capability package nests its definition under `capability`; a cached one is bare. */
function capabilityDef(definition: Def): Def {
  return asRecord(definition.capability) ?? definition;
}

function summarizeCapability(definition: Def): MarketInstallSummary {
  const def = capabilityDef(definition);
  const notices: string[] = [];
  const vault = asArray(def.vault);
  if (vault.length > 0) {
    notices.push(
      `Stores ${vault.length} secret${vault.length === 1 ? "" : "s"} in this pod's vault.`
    );
  }
  return {
    workspace: "optional",
    adds: [
      ...part("capability", [def]),
      ...part("tool", asArray(def.tools)),
      ...part("skill", asArray(def.skills)),
    ],
    notices,
    params: paramsOf(def),
  };
}

function summarizeSkill(definition: Def): MarketInstallSummary {
  // Published skills nest under `skill`, legacy ones are flat — the same
  // unwrap `applyMarketInstall`'s skill branch performs.
  const def = asRecord(definition.skill) ?? definition;
  // Only an `instruction` skill is born approved (skills.ts `insertSkillGoverned`);
  // every other kind executes something and starts as a draft.
  const notices: string[] = [];
  if (def.kind === "code") {
    notices.push(
      "It runs code, so it is installed switched off until someone approves it."
    );
  } else if (def.kind === "declarative") {
    notices.push("It is installed switched off until someone approves it.");
  }
  return {
    workspace: "optional",
    adds: part("skill", [def]),
    notices,
    params: [],
  };
}

function summarizeAutomation(definition: Def): MarketInstallSummary {
  const autos = asArray(definition.automations);
  const selfRunning = autos.filter((a) => {
    const t = asRecord(a)?.triggerType;
    return t === "cron" || t === "event" || t === "webhook";
  }).length;
  return {
    workspace: "required",
    adds: part("automation", autos),
    notices:
      selfRunning > 0
        ? [
            `${selfRunning} of them run${selfRunning === 1 ? "s" : ""} by ${selfRunning === 1 ? "itself" : "themselves"} — on a schedule, an event or a webhook.`,
          ]
        : [],
    params: [],
  };
}

function summarizeView(definition: Def): MarketInstallSummary {
  const views = asArray(definition.views);
  return {
    workspace: "required",
    adds: part("view", views.length > 0 ? views : [definition]),
    notices: [],
    params: [],
  };
}

function summarizeCell(definition: Def): MarketInstallSummary {
  const hosts = asArray(definition.externalHosts).filter(
    (h): h is string => typeof h === "string" && h.length > 0
  );
  return {
    workspace: "optional",
    adds: part("cell", [definition]),
    // Only what the card declares — the absence of a list is not a promise
    // about its network reach, so nothing is said then.
    notices:
      hosts.length > 0
        ? [`It declares these outside sites it may reach: ${hosts.join(", ")}.`]
        : [],
    params: [],
  };
}

function summarizeTemplate(definition: Def): MarketInstallSummary {
  // Profiles are left to the workspace preflight report, which says which are
  // created, reused or in conflict — a bare list here would contradict it.
  const capabilities = asArray(definition.capabilities);
  const singular = asRecord(definition.capability);
  return {
    workspace: "creates",
    adds: [
      ...part("view", asArray(definition.views)),
      ...part(
        "capability",
        capabilities.length > 0 ? capabilities : singular ? [singular] : []
      ),
      ...part("playbook", asArray(definition.playbooks)),
      ...part("automation", asArray(definition.automations)),
      ...part("cell", asArray(definition.cells)),
    ],
    notices: [],
    params: [],
  };
}

/** Summarize what installing `definition` (of catalog `kind`) would change. */
export function summarizeMarketInstall(
  kind: CatalogKind,
  definition: Record<string, unknown>
): MarketInstallSummary {
  switch (kind) {
    case "capability":
      return summarizeCapability(definition);
    case "skill":
      return summarizeSkill(definition);
    case "automation":
      return summarizeAutomation(definition);
    case "view":
      return summarizeView(definition);
    case "cell":
      return summarizeCell(definition);
    case "template":
      return summarizeTemplate(definition);
  }
}
