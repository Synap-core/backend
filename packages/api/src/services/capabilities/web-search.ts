/**
 * `web.search` — the pod's one door for "search the web".
 *
 * It never calls a search vendor itself. It runs a PROVIDER: an installed verb
 * that declares `search_external`, through `executeCapability`, so the search
 * carries the caller's grant, the agent posture and the provider verb's own
 * gate, and lands as that verb's `capability_run` (metered when the verb
 * declares `metadata.metering`). This module only picks WHICH verb.
 *
 * ── WHICH PROVIDER (wave C0) ────────────────────────────────────────────────
 * Only the one the caller NAMES (`provider`, a verb id from `providers[]`).
 * `search_external` means "query an outside corpus", not "the web": Notion,
 * Dropbox and Gmail searches declare it too, so an unnamed search never picks
 * one of them on the caller's behalf. With no name the answer is an honest
 * `blocked`, listing the installed verbs the caller could name. The pod's
 * default provider (a Synap-run, metered one) is a later wave.
 *
 * ── HONEST OUTCOMES ─────────────────────────────────────────────────────────
 * `ok` (the provider's own result) | `blocked` (nothing ran: no provider named
 * or installed, not enabled, waiting for review) | `failed` (it ran and failed,
 * or the named verb is not a provider the caller can run). Never an empty `ok`.
 */

import type { FailureErrorClass } from "../../connectors/external-dispatch.js";
import {
  capabilitiesByIntent,
  type IntentVerbMatch,
} from "./capability-intent-index.js";

/** The intent a web search provider declares. */
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
  execute?: (
    input: Parameters<
      typeof import("./execute-capability.js").executeCapability
    >[0]
  ) => ReturnType<typeof import("./execute-capability.js").executeCapability>;
}

/**
 * Search the web for `query` through the named provider.
 *
 * @throws only when the installed providers cannot be listed, or the provider
 *   run itself throws: a failed lookup is never answered as "none installed".
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

  if (opts.provider === undefined) {
    return {
      search:
        providers.length > 0
          ? {
              status: "blocked",
              reason: "no_provider",
              nextStep: "name_provider",
              detail:
                "This pod has no default web search provider yet. Name one of providers[] in `provider` (pick one that searches the web, not a notes or files search).",
            }
          : {
              status: "blocked",
              reason: "no_provider",
              nextStep: "install_provider",
              detail:
                'No web search provider is installed. Find one with market.search (e.g. query "web search") and install it, or tell the user.',
            },
      providers,
    };
  }

  const provider = opts.provider;
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
