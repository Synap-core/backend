/**
 * `web.search` — the pod's one door for "search the web".
 *
 * It never calls a search vendor itself. It runs a PROVIDER: an installed verb
 * that declares `search_web`, through `executeCapability`, so the search
 * carries the caller's grant, the agent posture and the provider verb's own
 * gate, and lands as that verb's `capability_run` (metered when the verb
 * declares `metadata.metering`). This module only picks WHICH verb.
 *
 * ── WHICH PROVIDER ──────────────────────────────────────────────────────────
 * The one the caller NAMES (`provider`, a verb id from `providers[]`), else the
 * one installed: the only ready provider (or, when none is ready, the only
 * installed one, so its run can ask to enable it). Several ready providers and
 * no name is an honest `blocked` listing them, never a silent pick.
 * `search_web` (0360), not `search_external`: the latter means "query an
 * outside corpus" and Notion, Dropbox and Gmail searches declare it too, so it
 * never makes a verb a web search provider. Any verb declaring it is one: a
 * catalog capability (Exa) or one the person built themselves.
 *
 * ── BRING YOUR OWN PROVIDER ─────────────────────────────────────────────────
 * Synap runs no default search provider (founder, 2026-10-26: people bring
 * their own tools). With none installed, the `blocked` answer carries
 * `install[]`: the catalog capabilities that would add one, each installed with
 * `market.install({ slug, kind: "capability" })` (a reviewable proposal for an
 * agent; the person approves it and adds their own key).
 *
 * ── HONEST OUTCOMES ─────────────────────────────────────────────────────────
 * `ok` (the provider's own result) | `blocked` (nothing ran: no provider named
 * or installed, not enabled, waiting for review) | `failed` (it ran and failed,
 * or the named verb is not a provider the caller can run). Never an empty `ok`.
 */

import type { FailureErrorClass } from "../../connectors/external-dispatch.js";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";
import { capabilityNextAction } from "./capability-enable-link.js";
import {
  capabilitiesByIntent,
  type IntentVerbMatch,
} from "./capability-intent-index.js";

/** The intent a web search provider declares (migration 0360). */
const WEB_SEARCH_INTENT = "search_external";
/** This verb — it declares the intent too, and is never its own provider. */
const WEB_SEARCH_VERB = "web.search";

export interface WebSearchContext {
  userId: string;
  workspaceId: string | null;
  agentUserId?: string | null;
  sessionId?: string | null;
}

/** An installed verb the caller may name as `provider`. */
export interface WebSearchProvider {
  verbId: string;
  /** The capability it belongs to, so the caller can tell a web index from a notes search. */
  capabilityName: string;
  /** False when it is installed but not runnable yet (not enabled). */
  ready: boolean;
}

/** A catalog capability that adds a web search provider, run on the person's own key. */
export interface WebSearchInstallOffer {
  /** Install with `market.install({ slug, kind: "capability" })`. */
  slug: string;
  name: string;
  /** Its verbs that declare `search_web`. */
  verbs: string[];
  hint: string;
}

export type WebSearchOutcome =
  | {
      status: "ok";
      provider: string;
      result: unknown;
      /** The provider run's handle (its `capability_run`, with its meter). */
      correlationId?: string;
    }
  | {
      status: "blocked";
      reason: "no_provider" | "not_enabled" | "awaiting_review" | "dry_run";
      /** What unblocks it: name one of `providers`, install one, or enable it. */
      nextStep?: "name_provider" | "install_provider" | "enable_provider";
      detail: string;
      provider?: string;
      proposalId?: string;
      /** With `install_provider`: what would add one (may be empty). */
      install?: WebSearchInstallOffer[];
    }
  | {
      status: "failed";
      provider: string;
      error: string;
      errorClass?: FailureErrorClass;
    };

export interface WebSearchResult {
  search: WebSearchOutcome;
  providers: WebSearchProvider[];
}

/** Test seams; production uses the real modules. */
export interface WebSearchDeps {
  listProviders?: (ctx: WebSearchContext) => Promise<IntentVerbMatch[]>;
  /** The official catalog's capabilities (`cp_catalog_cache`). */
  listCatalog?: () => Promise<CatalogCacheEntry[]>;
  execute?: (
    input: Parameters<
      typeof import("./execute-capability.js").executeCapability
    >[0]
  ) => ReturnType<typeof import("./execute-capability.js").executeCapability>;
}

/**
 * Search the web for `query` through the named provider.
 *
 * @throws only when the installed providers or the catalog cannot be listed,
 *   or the provider run itself throws: a failed lookup is never answered as
 *   "none installed" or "nothing to install".
 */
export async function searchWeb(
  ctx: WebSearchContext,
  query: string,
  opts: { provider?: string },
  deps: WebSearchDeps = {}
): Promise<WebSearchResult> {
  const matches = await (
    deps.listProviders ??
    ((c: WebSearchContext) =>
      capabilitiesByIntent(
        { userId: c.userId, workspaceId: c.workspaceId },
        WEB_SEARCH_INTENT
      ))
  )(ctx);
  const providers: WebSearchProvider[] = matches
    .filter((m) => m.verbId !== WEB_SEARCH_VERB)
    .map((m) => ({
      verbId: m.verbId,
      capabilityName: m.capabilityName,
      ready: m.backingSkillExecutable,
    }))
    .sort((a, b) => a.verbId.localeCompare(b.verbId));

  // Unnamed: the one installed provider. Prefer the ready ones; with none
  // ready, the only installed one still runs, so its gate can ask to enable it.
  const ready = providers.filter((p) => p.ready);
  const candidates = ready.length > 0 ? ready : providers;
  if (opts.provider === undefined && candidates.length >= 1) {
    return {
      search: {
        status: "blocked",
        reason: "no_provider",
        nextStep: "name_provider",
        detail:
          "Several web search providers are installed. Name one of providers[] in `provider`.",
      },
      providers,
    };
  }
  if (opts.provider === undefined && candidates.length === 0) {
    const install = installOffers(
      await (
        deps.listCatalog ??
        (async () =>
          (await import("./catalog-cache-query.js")).queryCatalogCache({
            kind: "capability",
          }))
      )()
    );
    return {
      search: {
        status: "blocked",
        reason: "no_provider",
        nextStep: "install_provider",
        detail:
          install.length > 0
            ? `No web search provider is installed. Offer to install one of install[] on the person's own key: market.install({ slug, kind: "capability" }) proposes it, and the person approves it and adds their key. Any capability of theirs whose verb declares search_web works too.`
            : `No web search provider is installed. Find one with market.search (e.g. query "web search") and install it on the person's own key, or tell the user.`,
        install,
      },
      providers,
    };
  }

  const provider = opts.provider ?? candidates[0]!.verbId;
  if (!providers.some((p) => p.verbId === provider)) {
    return {
      search: {
        status: "failed",
        provider,
        error: `"${provider}" is not a search provider you can run here. Name one of providers[].`,
        errorClass: "validation",
      },
      providers,
    };
  }

  const execute =
    deps.execute ??
    (async (input) =>
      (await import("./execute-capability.js")).executeCapability({
        ...input,
        // Search results are third-party pages: never a recall fact.
        observability: "mirror",
      }));
  const outcome = await execute({
    verbId: provider,
    parameters: { query },
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId ?? null,
    sessionId: ctx.sessionId ?? null,
    // Search results are third-party pages, not something the person did:
    // keep the run record (and its meter), never a recall fact.
    observability: "mirror",
  });

  switch (outcome.kind) {
    case "run":
      return {
        search: {
          status: "ok",
          provider,
          result: outcome.result,
          ...(outcome.correlationId
            ? { correlationId: outcome.correlationId }
            : {}),
        },
        providers,
      };
    case "deny":
      return {
        search: {
          status: "blocked",
          reason: "not_enabled",
          nextStep: "enable_provider",
          detail: outcome.enable?.hint ?? outcome.reason,
          provider,
          ...(outcome.enableProposal?.status === "proposed"
            ? { proposalId: outcome.enableProposal.proposalId }
            : {}),
        },
        providers,
      };
    case "proposed":
      return {
        search: {
          status: "blocked",
          reason: "awaiting_review",
          detail: "Waiting for review before it searches.",
          provider,
          proposalId: outcome.proposalId,
        },
        providers,
      };
    case "dry-run":
      return {
        search: {
          status: "blocked",
          reason: "dry_run",
          detail: "It runs as a dry run here, so nothing was searched.",
          provider,
        },
        providers,
      };
    case "error":
      return {
        search: {
          status: "failed",
          provider,
          error: outcome.message,
          ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        },
        providers,
      };
    case "not_found":
      return {
        search: { status: "failed", provider, error: outcome.message },
        providers,
      };
  }
}

/** The catalog capabilities with a verb declaring `search_web`, by name. */
function installOffers(
  entries: readonly CatalogCacheEntry[]
): WebSearchInstallOffer[] {
  const offers: WebSearchInstallOffer[] = [];
  for (const entry of entries) {
    if (entry.kind !== "capability") continue;
    const skills = entry.definition?.skills;
    const verbs = (Array.isArray(skills) ? skills : [])
      .filter(
        (sk): sk is { name: string } =>
          typeof (sk as { name?: unknown })?.name === "string" &&
          (sk as { intent?: unknown }).intent === WEB_SEARCH_INTENT
      )
      .map((sk) => sk.name);
    if (verbs.length === 0) continue;
    offers.push({
      slug: entry.slug,
      name: entry.name,
      verbs,
      hint: capabilityNextAction("available", entry.name).hint,
    });
  }
  return offers.sort((a, b) => a.name.localeCompare(b.name));
}
