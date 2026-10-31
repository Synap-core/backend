/**
 * Tools — ONE list of every tool on the pod, by type (decision 79f5b7a2,
 * contract a0f787b7). PURE: the page fetches, this shapes; every rule here is
 * tested at the seam.
 *
 * The three types, from three reads:
 *   • Capabilities — the installed containers (`capabilities.compositions`),
 *     their state and actions from their catalog card (`capabilities.catalog`).
 *     A capability's actions are not tools of their own: they live on its page.
 *   • Instructions — skills of kind `instruction` (`skills.list`).
 *   • Code — skills of kind `code`, `declarative` or `builtin` that back NO
 *     capability action: an action's skill is reached through its capability.
 * Rules are skills too (`metadata.rule`) and are left out: they have their own
 * page (Rules).
 *
 * Search is client-side over the loaded tools: name, slug, description and
 * action labels. The type filter and the view live in the URL (`?type=`,
 * `?view=`); the view is also kept per viewer (`tools-page.tsx`).
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import { formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { toolsT } from "./copy";
import type { CardLike, CompositionLike } from "./installed-model";
import {
  capabilityStatus,
  approvedStatus,
  statusRank,
  type StatusMark,
} from "./tool-status";

export type ToolType = "capability" | "instruction" | "code";

/** One cached catalog read for the list and every capability page. */
export const CATALOG_INPUT = {} as const;
export const CAPABILITY_READ_OPTIONS = { staleTime: 30_000 } as const;

export const TOOL_FILTERS = [
  "all",
  "capabilities",
  "instructions",
  "code",
] as const;
export type ToolFilter = (typeof TOOL_FILTERS)[number];

const FILTER_TYPE: Record<Exclude<ToolFilter, "all">, ToolType> = {
  capabilities: "capability",
  instructions: "instruction",
  code: "code",
};

export type ToolsView = "list" | "gallery";

/** `?type=` → a filter; anything else is All. */
export function toolFilterOf(raw: string | null | undefined): ToolFilter {
  return (TOOL_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as ToolFilter)
    : "all";
}

/** `?view=` → a view, or null when the URL does not say. */
export function toolsViewOf(raw: string | null | undefined): ToolsView | null {
  return raw === "list" || raw === "gallery" ? raw : null;
}

/** Where a viewer's last view choice is kept (this browser only). */
export const TOOLS_VIEW_KEY = "pod-console.tools-view";

/**
 * The view to draw: the URL's, else the one this viewer chose last, else the
 * list. Storage can be absent or throw (a private window, blocked site data):
 * the list then.
 */
export function initialToolsView(
  fromUrl: string | null | undefined,
  storage: Pick<Storage, "getItem"> | undefined
): ToolsView {
  const url = toolsViewOf(fromUrl);
  if (url) return url;
  try {
    return toolsViewOf(storage?.getItem(TOOLS_VIEW_KEY)) ?? "list";
  } catch {
    return "list";
  }
}

/** Keep the viewer's choice; a storage that throws keeps nothing, silently. */
export function storeToolsView(
  view: ToolsView,
  storage: Pick<Storage, "setItem"> | undefined
): void {
  try {
    storage?.setItem(TOOLS_VIEW_KEY, view);
  } catch {
    // A convenience only: the URL still carries the view.
  }
}

/** The `skills.list` fields this list reads (structural). */
export interface SkillLike {
  id: string;
  name: string;
  slug?: string | null;
  kind: string;
  description?: string | null;
  approved: boolean;
  scope?: string | null;
  workspaceId?: string | null;
  metadata?: unknown;
}

/** A rule is a skill whose `metadata.rule` is set: the Rules page lists it. */
export function isRuleSkill(skill: Pick<SkillLike, "metadata">): boolean {
  const m = skill.metadata;
  return (
    typeof m === "object" &&
    m !== null &&
    (m as Record<string, unknown>).rule != null
  );
}

const CODE_KINDS: ReadonlySet<string> = new Set([
  "code",
  "declarative",
  "builtin",
]);

/**
 * Which type a skill is listed as, or null when it is not listed: a rule, an
 * action of a capability (`actionSkillIds`), or a kind with no type.
 */
export function skillToolType(
  skill: SkillLike,
  actionSkillIds: ReadonlySet<string>
): Exclude<ToolType, "capability"> | null {
  if (isRuleSkill(skill) || actionSkillIds.has(skill.id)) return null;
  if (skill.kind === "instruction") return "instruction";
  return CODE_KINDS.has(skill.kind) ? "code" : null;
}

export interface ToolItem {
  /** `type:id`, unique across the list. */
  key: string;
  type: ToolType;
  id: string;
  name: string;
  description: string | null;
  /** The ref an agent loads a skill by; null for a capability. */
  slug: string | null;
  /** A skill's kind (`instruction`, `code`…); null for a capability. */
  kind: string | null;
  /** A capability's action labels (and their verb ids), for search. */
  actionLabels: string[];
  status: StatusMark;
  workspaceId: string | null;
  scope: "pod" | "user" | "workspace";
  /** A capability's actions turned on, of how many; null when unknown. */
  actionsOn: number | null;
  actionsTotal: number | null;
  lastRunAt: string | null;
  /** Its own page. */
  href: string;
}

function hrefOf(objectKind: "capability" | "skill", id: string): string {
  return openIn({ kind: "object", objectKind, id }).href;
}

/**
 * Every skill id that backs a capability action: the catalog's verbs and the
 * containers' skill members. Either read alone is enough to keep an action
 * out of Code, so a failed catalog read does not spill actions into the list.
 */
export function actionSkillIdsOf(
  compositions: readonly CompositionLike[] | null,
  cards: readonly CardLike[] | null
): Set<string> {
  const ids = new Set<string>();
  for (const c of compositions ?? [])
    for (const m of c.members) if (m.kind === "skill") ids.add(m.id);
  for (const card of cards ?? [])
    for (const v of card.verbs) if (v.skillId) ids.add(v.skillId);
  return ids;
}

function capabilityItem(
  c: CompositionLike,
  card: CardLike | null,
  cardsRead: boolean
): ToolItem {
  const verbs = card?.verbs ?? [];
  return {
    key: `capability:${c.id}`,
    type: "capability",
    id: c.id,
    name: c.name,
    description: c.description?.trim() || null,
    slug: null,
    kind: null,
    actionLabels: verbs.flatMap((v) =>
      v.label === v.verbId ? [v.label] : [v.label, v.verbId]
    ),
    status: capabilityStatus({ card, health: c.health }),
    workspaceId: c.workspaceId ?? null,
    scope: c.workspaceId ? "workspace" : "pod",
    actionsOn: cardsRead && card ? verbs.filter((v) => v.enabled).length : null,
    actionsTotal: cardsRead && card ? verbs.length : null,
    lastRunAt: c.health.lastRunAt ?? null,
    href: hrefOf("capability", c.id),
  };
}

function skillItem(
  s: SkillLike,
  type: Exclude<ToolType, "capability">
): ToolItem {
  return {
    key: `${type}:${s.id}`,
    type,
    id: s.id,
    name: s.name,
    description: s.description?.trim() || null,
    slug: s.slug?.trim() || null,
    kind: s.kind,
    actionLabels: [],
    status: approvedStatus(s),
    workspaceId: s.workspaceId ?? null,
    scope:
      s.scope === "user" || s.scope === "workspace"
        ? s.scope
        : s.workspaceId
          ? "workspace"
          : "pod",
    actionsOn: null,
    actionsTotal: null,
    lastRunAt: null,
    href: hrefOf("skill", s.id),
  };
}

/**
 * The one list. Each read may be null (failed or loading): its tools are
 * simply absent and the page says which read failed. `cards` null leaves a
 * capability's state unknown, never "On". Ordered by what needs a look first
 * (down, then stale), then by name.
 */
export function toolItems(input: {
  compositions: readonly CompositionLike[] | null;
  cards: readonly CardLike[] | null;
  skills: readonly SkillLike[] | null;
}): ToolItem[] {
  const { compositions, cards, skills } = input;
  const cardById = new Map<string, CardLike>();
  for (const c of cards ?? []) if (c.id) cardById.set(c.id, c);
  const actionIds = actionSkillIdsOf(compositions, cards);
  const items: ToolItem[] = [
    ...(compositions ?? []).map((c) =>
      capabilityItem(c, cardById.get(c.id) ?? null, cards !== null)
    ),
    ...(skills ?? []).flatMap((s) => {
      const type = skillToolType(s, actionIds);
      return type ? [skillItem(s, type)] : [];
    }),
  ];
  return items.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      a.name.localeCompare(b.name)
  );
}

/**
 * Does the tool match the search? Every word of the query must appear in its
 * name, slug, description or one of its action labels (any case).
 */
export function matchesToolSearch(item: ToolItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    item.name,
    item.slug ?? "",
    item.description ?? "",
    ...item.actionLabels,
  ]
    .join("\n")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** The tools under a filter and a search. */
export function filterTools(
  items: readonly ToolItem[],
  filter: ToolFilter,
  query: string
): ToolItem[] {
  return items.filter(
    (i) =>
      (filter === "all" || i.type === FILTER_TYPE[filter]) &&
      matchesToolSearch(i, query)
  );
}

/** Each chip's count over the searched tools, so a count names what it shows. */
export function toolCounts(
  items: readonly ToolItem[],
  query: string
): Record<ToolFilter, number> {
  const searched = items.filter((i) => matchesToolSearch(i, query));
  const count = (type: ToolType) =>
    searched.filter((i) => i.type === type).length;
  return {
    all: searched.length,
    capabilities: count("capability"),
    instructions: count("instruction"),
    code: count("code"),
  };
}

/** Where a tool applies, in words: the whole pod, one person, or its space. */
export function toolWhere(
  item: Pick<ToolItem, "scope" | "workspaceId">,
  spaceName: (id: string) => string | undefined
): string {
  const t = toolsT();
  if (item.scope === "user") return t("where.you");
  if (!item.workspaceId) return t("where.pod");
  return spaceName(item.workspaceId) ?? t("where.space");
}

/** The row's second line. */
export function toolSecondary(item: ToolItem, where: string): string {
  const t = toolsT();
  if (item.type === "capability")
    return [
      where,
      item.actionsTotal
        ? t("row.actionsOn", {
            on: item.actionsOn ?? 0,
            total: item.actionsTotal,
          })
        : null,
      item.lastRunAt
        ? t("row.lastRan", { when: formatRelative(item.lastRunAt) })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  return [
    item.type === "code" && item.kind ? humanizeToken(item.kind) : null,
    item.slug,
    where,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * An old `/tools?tab=` link (the three tabs before the one list), as the
 * address that answers it now, or null when the URL carries no tab.
 * `?tab=actions&focus=<capabilityId>` and `?tab=installed&focus=` open that
 * capability's page; Installed and Actions are the Capabilities filter;
 * Skills is the whole list.
 */
export function legacyToolsHref(params: URLSearchParams): string | null {
  const tab = params.get("tab");
  if (tab === null) return null;
  const focus = params.get("focus");
  if ((tab === "actions" || tab === "installed") && focus)
    return hrefOf("capability", focus);
  const next = new URLSearchParams(params);
  next.delete("tab");
  next.delete("focus");
  if (tab === "actions" || tab === "installed")
    next.set("type", "capabilities");
  const qs = next.toString();
  return qs ? `/tools?${qs}` : "/tools";
}
