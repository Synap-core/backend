/**
 * The reader FOLD (pure): which installed verbs, plus the built-in ladder,
 * read a URL, ranked. A verb is a reader only by declaring a URL pattern that
 * matches (`skills.url_patterns`, projected as `urlPatterns`) — nothing here
 * keeps a host table. Part of the one reader door (`url-readers.ts`).
 */

import {
  bestUrlPatternSpecificity,
  type UrlReaderOffer,
} from "@synap-core/types/url-read";
import { normalizeServiceId } from "@synap-core/types/service-marks";
import { isHttpUrl } from "@synap-core/types/navigation";
import type { RegistryCapability } from "./capability-registry.js";
import { resolveCapabilityBlock } from "./capability-enable-link.js";
import {
  builtinStamp,
  findSiteAdapter,
  podNeverFetches,
} from "./web-read/index.js";

/** The built-in ladder's reader id (offers, explicit `reader`). */
export const BUILTIN_READER_ID = "builtin";

/** A ranked offer plus the facts the door needs to run and stamp it. */
export interface RankedReader {
  offer: UrlReaderOffer;
  /** Best declared pattern's specificity for this URL (built-in: its adapter's, else 0). */
  specificity: number;
  builtin: boolean;
  /** The capability container the verb lives in, when it has one. */
  containerId?: string;
  /**
   * The space the verb RUNS in: its own row's space when the read saw every
   * space (`allSpaces`), so the gate, grant and vault resolve exactly as for a
   * direct run there. Absent (or `null` = a pod-wide row) → the caller's lens.
   */
  workspaceId?: string | null;
}

const TOOL_KINDS = new Set(["tool", "builtin-tool", "source-provider"]);

/**
 * A service-marks id for the reader's vendor, from the FIRST word of its
 * container (or tool/pack) name — never any word, which would name the SITE a
 * reader reads ("YouTube transcripts by X") rather than who runs it.
 */
export function serviceIdFor(
  ...names: Array<string | null | undefined>
): string | undefined {
  for (const name of names) {
    const first = (name ?? "").trim().split(/[^a-z0-9]+/i)[0];
    const id = normalizeServiceId(first);
    if (id) return id;
  }
  return undefined;
}

/** specificity desc → free before billed → ready before the rest → built-in on ties. */
export function compareReaders(a: RankedReader, b: RankedReader): number {
  if (a.specificity !== b.specificity) return b.specificity - a.specificity;
  const bill = (r: RankedReader) => (r.offer.billing === "none" ? 0 : 1);
  if (bill(a) !== bill(b)) return bill(a) - bill(b);
  const ready = (r: RankedReader) => (r.offer.state === "ready" ? 0 : 1);
  if (ready(a) !== ready(b)) return ready(a) - ready(b);
  if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
  return 0; // stable: registry order
}

/**
 * The built-in candidate for `url`, or null for a URL the pod never fetches
 * and no built-in site adapter declares (Instagram — decision P1). TikTok
 * keeps it: its official oEmbed is an adapter, not a page fetch.
 */
function builtinCandidate(url: string): RankedReader | null {
  const adapter = findSiteAdapter(url);
  if (!adapter && podNeverFetches(url)) return null;
  const stamp = builtinStamp(adapter ? { adapter } : "article");
  return {
    offer: {
      readerId: BUILTIN_READER_ID,
      name: stamp.name,
      billing: "none",
      state: "ready",
    },
    specificity: adapter
      ? Math.max(0, bestUrlPatternSpecificity(adapter.urls, url))
      : 0,
    builtin: true,
  };
}

/** Can this row's verb run now (the pack on, its backing skill executable)? */
function verbRunnable(
  row: RegistryCapability,
  v: NonNullable<RegistryCapability["verbs"]>[number]
): boolean {
  return row.enabled === true && v.backingSkillExecutable === true;
}

/**
 * Installed verb readers of `url`, one per verb id (tool row preferred).
 *
 * An `allSpaces` read can see the SAME verb in several spaces (one pack
 * installed in two). It stays ONE offer — the reader id is the verb id — and
 * the copy that can run wins, then the copy in the caller's own lens
 * (`lensWorkspaceId`, pod-wide rows included), then registry order.
 */
function verbReaders(
  rows: readonly RegistryCapability[],
  url: string,
  lensWorkspaceId: string | null = null
): RankedReader[] {
  const local = (row: RegistryCapability) =>
    row.workspaceId === undefined ||
    row.workspaceId === null ||
    row.workspaceId === lensWorkspaceId;
  const best = new Map<string, { row: RegistryCapability; spec: number }>();
  const verbOf = new Map<
    string,
    NonNullable<RegistryCapability["verbs"]>[number]
  >();
  for (const row of rows) {
    if (row.catalogOnly) continue;
    if (row.kind === "teaching-doc" || row.kind === "command") continue;
    // An inactive skill row is not launchable — never offered from that row.
    if (row.kind === "skill" && row.runnable === false) continue;
    for (const v of row.verbs ?? []) {
      const spec = bestUrlPatternSpecificity(v.urlPatterns, url);
      if (spec < 0) continue;
      const prior = best.get(v.id);
      const isTool = TOOL_KINDS.has(row.kind);
      if (prior) {
        const priorTool = TOOL_KINDS.has(prior.row.kind);
        const priorVerb = verbOf.get(v.id)!;
        // Same rule as foldVerbsByIntent: a tool row (connection, grant) wins
        // over the skill row of the same verb; between tool rows, the granted.
        // Tied on that, a copy in ANOTHER space (allSpaces only): the runnable
        // one, then the caller's own lens.
        const kindTie = isTool === priorTool;
        const grantTie =
          kindTie && (!isTool || !!v.granted === !!priorVerb.granted);
        const otherSpace = row.workspaceId !== prior.row.workspaceId;
        const better =
          (isTool && !priorTool) ||
          (isTool && priorTool && v.granted && !priorVerb.granted) ||
          (grantTie &&
            otherSpace &&
            (verbRunnable(row, v) !== verbRunnable(prior.row, priorVerb)
              ? verbRunnable(row, v)
              : local(row) && !local(prior.row)));
        if (!better) continue;
      }
      best.set(v.id, { row, spec });
      verbOf.set(v.id, v);
    }
  }
  const out: RankedReader[] = [];
  for (const [verbId, { row, spec }] of best) {
    const v = verbOf.get(verbId)!;
    const connection = row.connection
      ? {
          required: row.connection.required,
          kind: "provider" as const,
          provider: row.connection.provider,
          state: row.connection.connected
            ? ("connected" as const)
            : ("missing" as const),
        }
      : null;
    const block = resolveCapabilityBlock({
      name: row.containerName ?? row.name,
      containerId: row.containerId ?? null,
      connection,
      enabled: verbRunnable(row, v),
    });
    const state: UrlReaderOffer["state"] = !block
      ? "ready"
      : block.kind === "connect"
        ? "connect"
        : "enable";
    const serviceId = serviceIdFor(row.containerName, row.name);
    const capabilityId = row.containerId ?? row.id;
    out.push({
      offer: {
        readerId: verbId,
        name: row.containerName ?? row.name,
        ...(serviceId ? { serviceId } : {}),
        verbId,
        capabilityId,
        billing: v.credentialed ? "account" : "none",
        state,
        ...(block ? { hint: block.hint } : {}),
      },
      specificity: spec,
      builtin: false,
      ...(row.containerId ? { containerId: row.containerId } : {}),
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    });
  }
  return out;
}

export function rankedFold(
  rows: readonly RegistryCapability[],
  url: string,
  lensWorkspaceId: string | null = null
): RankedReader[] {
  if (!isHttpUrl(url.trim())) return [];
  const all = verbReaders(rows, url, lensWorkspaceId);
  const builtin = builtinCandidate(url);
  if (builtin) all.push(builtin);
  return all.sort(compareReaders);
}

/**
 * PURE: the installed readers of `url` (plus the built-in), ranked — most
 * specific declaration first, free before billed, ready before the rest, the
 * built-in on ties. A verb is a reader ONLY by declaring a pattern that
 * matches; an intent alone (`read_webpage`) routes nothing. `lensWorkspaceId`
 * breaks a tie between copies of one verb in different spaces (rows from an
 * `allSpaces` read) in favour of the caller's own lens.
 */
export function foldUrlReaders(
  rows: readonly RegistryCapability[],
  url: string,
  lensWorkspaceId: string | null = null
): UrlReaderOffer[] {
  return rankedFold(rows, url, lensWorkspaceId).map((r) => r.offer);
}
