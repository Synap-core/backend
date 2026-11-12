/**
 * MCP tool handlers — read domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { ask } from "../../../services/knowledge/ask.js";
import { resolveProfileDescription } from "../../../utils/profile-presentation.js";
import { leanProposal } from "./proposal-lean.js";
import {
  REVIEW_PACKAGES,
  isReviewPackage,
} from "@synap-core/types/proposals/review-package";
import {
  toProfileDigest,
  compactRelationTypes,
  PROFILES_DIGEST_NOTE,
} from "./read-lean.js";
import {
  ENTITIES_LEAN_NOTE,
  projectLeanEntityList,
  leanListedUnderRole,
} from "../../../services/entity-lean-list.js";
import {
  ASK_DETAILS,
  synthesizeAnswer,
  type AskDetail,
} from "../../../services/knowledge/synthesize.js";
import { capBriefEnvelope } from "../../../services/knowledge/brief-envelope.js";
import { resolveKnowledgeLens } from "../../../services/knowledge/resolve-lens.js";
import { describeAiFailure } from "../../../utils/ai-failure.js";
import {
  getUserMemberWorkspaceIds,
  getUserAccessibleWorkspaceIds,
} from "../../hub-protocol/rest/_shared.js";
import { entitiesRouter as regularEntitiesRouter } from "../../entities.js";
import { documents, eq, getDb } from "@synap/database";
import { classifyRoomAuthor } from "../../../services/focus-sessions/room-messages.js";
import { AccessContext, scopedDb } from "../../../access/index.js";
import {
  lastInteractionWindowWhere,
  parseEntityListSort,
  type EntityListOrderBy,
} from "../../../utils/entity-list-sort.js";
import { fullUuidError, toolError } from "../tool-errors.js";
import { fitReply } from "./fit-reply.js";

import { parseEntityListFiltersInput } from "../../../utils/entity-list-filters-input.js";
import {
  listEffectiveRelationTypes,
  type EffectiveRelationType,
} from "../../../utils/relation-types.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { isUuid } from "@synap-core/types/property-render";
import {
  listPersonChannels,
  listProposedMessages,
} from "../../../services/channels/person-channels.js";
import { EXPOSURE_RELATION_TYPES } from "../../../utils/project-scope.js";
import {
  resolveByName,
  resolveProfileByName,
  type GraphEnvelope,
} from "../../../services/object-graph/graph-service.js";
import {
  ok,
  untrusted,
  requireScope,
  buildGraphEnvelope,
  entityHomeWorkspaceId,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  pageLimit,
  pageOffset,
  pageSlice,
  PROFILES_PAGE_DEFAULT,
  ENTITIES_PAGE_MAX,
} from "./shared.js";

/**
 * The longest message a thread read carries whole; longer ones keep their
 * start (`truncated: true`, `contentChars` = the full length).
 */
export const THREAD_MESSAGE_MAX_CHARS = 2_000;

/**
 * Postgres 22P02 — "invalid input syntax for type uuid" — anywhere in the
 * error chain. Drizzle wraps the driver error, so the code can sit on `cause`.
 */
function isInvalidUuidInput(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e && hops < 5; hops++) {
    const rec = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === "22P02") return true;
    if (
      typeof rec.message === "string" &&
      /invalid input syntax for type uuid/i.test(rec.message)
    ) {
      return true;
    }
    e = rec.cause;
  }
  return false;
}

export const readHandlers: McpHandlerMap = {
  synap_ask: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    if (typeof args.query !== "string" || args.query.trim() === "") {
      return ok({ error: "query is required" });
    }
    // `detail` (decision B9a): refused when unknown, never read as `full` — a
    // typo must not silently cost the caller the long answer it tried to avoid.
    const detail = (args.detail ?? "brief") as AskDetail;
    if (!ASK_DETAILS.includes(detail)) {
      return toolError(
        `detail must be one of ${ASK_DETAILS.join(", ")} (got ${JSON.stringify(args.detail)}).`
      );
    }
    // ACCESS + DOOR PARITY, via the ONE helper every knowledge door shares
    // (services/knowledge/resolve-lens.ts):
    //  - the `mcp.read` scope proves "may call recall", NEVER "may see THIS
    //    workspace". `ask()` forwards the lens as the PROCEDURAL namespace and
    //    `knowledge_keys` has no user column, so a caller-supplied id the user
    //    cannot see degrades to pod-wide rather than being honoured;
    //  - the type-inference catalog tracks the query lens, and unscoped means
    //    the pod-wide profile UNION. This door used to pass NO catalog when
    //    unscoped (and before that, the first-membership workspace), so the
    //    same pod-wide question type-inferred differently here than on the
    //    Hub and tRPC doors;
    //  - the agent's declared focus is a BOOST (re-orders, never hides); the
    //    explicit `workspaceId` / `projectId` args stay the filter.
    const projectId = (args.projectId as string | undefined) ?? null;
    const { workspaceId, catalog, focus } = await resolveKnowledgeLens(
      userId,
      args.workspaceId as string | undefined,
      { projectId, agentUserId }
    );
    const compare = args.compare === true;
    // Retrieve across all substrates (same call as /knowledge/search).
    const retrieved = await ask({
      query: args.query as string,
      userId,
      workspaceId,
      projectId,
      focus,
      limit: (args.limit as number) || undefined,
      catalog,
      compare: compare || undefined,
      detail,
    });

    // A/B DIAGNOSTIC — when `compare` is set, return the ranker comparison
    // (baseline vs Horizon on the same pool) directly, skipping IS synthesis.
    // Read-only: this is a ranking diff, not an answer.
    if (compare) {
      return ok({
        mode: "compare",
        query: args.query,
        understanding: retrieved.understanding,
        lens: retrieved.lens,
        comparison: retrieved.comparison ?? null,
      });
    }

    // Build context + sources, then synthesize via IS. Pass the pending count
    // so the composed NL answer can acknowledge matching pending proposals
    // instead of contradicting the pendingBlock surfaced right below it.
    const synthesis = await synthesizeAnswer(
      retrieved.answers,
      args.query as string,
      retrieved.routedTo,
      workspaceId,
      retrieved.pending?.matches?.length ?? 0,
      // The degradation signal must reach the SENTENCE, not just the envelope.
      // `degraded` was already returned alongside this answer and correct; the
      // synthesis simply never saw it, so a half-dead retrieval layer produced
      // a confident answer with no caveat in the prose an agent reads.
      retrieved.degraded ?? [],
      detail,
      retrieved.queue
    );
    // `brief` caps the envelope too (sources, pending summaries, no spaces):
    // the prose budget alone left one ask at 62,594 chars.
    // The service result stays `synthesis` and is spread whole below; the cap
    // overrides `sources` (+ `sourcesOmitted`) and `truncated` on top of it.
    // Without the `truncated` override the spread put the full omitted list
    // back (a live brief carried 8 against a cap of 5).
    const {
      synthesis: capped,
      pending,
      keepSpaces,
    } = capBriefEnvelope(detail, synthesis, retrieved.pending);
    const sourcesBlock = {
      sources: capped.sources,
      ...(capped.sourcesOmitted
        ? { sourcesOmitted: capped.sourcesOmitted }
        : {}),
      ...(capped.truncated ? { truncated: capped.truncated } : {}),
    };
    // The PENDING block (`ask`'s Wave-3 lane): the caller's own pending
    // proposals whose content matches this query — surfaced SEPARATELY from the
    // synthesized answer so recall never presents unvalidated work as fact.
    // `ask.ts` computes it; the MCP door must forward it, or the whole anti-
    // amnesia fix silently never reaches the agents that call this tool (it was
    // dropped here — a live `ask("Talentir")` returned no pending block despite
    // two matching pending proposals). Additive; omitted when nothing pends.
    const pendingBlock = pending ? { pending } : {};
    // Where the asked-about kinds LIVE (`ask`'s spaces hint) — a routing hint,
    // forwarded as-is so an `unavailable` read is never dropped here.
    const spacesBlock =
      keepSpaces && retrieved.spaces ? { spaces: retrieved.spaces } : {};
    // A queue question's answer (what is waiting on the person), additive.
    const queueBlock = retrieved.queue ? { queue: retrieved.queue } : {};

    // Surface synthesis outages loudly instead of returning a null answer that
    // looks like "no results". Retrieval/sources still stand.
    if ((synthesis as { error?: string }).error === "synthesis_unavailable") {
      // The WHY comes from the one failure door, classified from the real
      // error — never a stock "temporarily unavailable" that could be telling
      // the agent to retry a failure no retry can fix.
      const failure = describeAiFailure(synthesis.failureClass ?? "unknown");
      return ok({
        ...synthesis,
        ...sourcesBlock,
        ...pendingBlock,
        ...spacesBlock,
        ...queueBlock,
        degraded: retrieved.degraded,
        lens: retrieved.lens,
        message:
          `⚠️ AI synthesis did not run. ${failure.message} ` +
          (failure.retryable
            ? "Retrying may work. "
            : "Do not retry — say so instead. ") +
          "The matched sources below are real; tell the user the AI answer layer is degraded (not that nothing was found).",
      });
    }
    // A Library item is a page or file from outside the pod: an answer
    // composed from one carries its words, so it is fenced (`untrusted`,
    // audit F5). An answer built only from the pod's own records is not.
    const fromLibrary = synthesis.sources.some(
      (source) => source.substrate === "library"
    );
    // DOOR PARITY: `degraded` is the retrieval-health signal `ask()` already
    // computes (a substrate outage, a keyword-only fallback after the vector
    // index went down). The hub `/answer` door has forwarded it since the
    // keyword-fallback incident; this door never did, so an MCP caller — the
    // primary agent surface — could not tell a healthy empty result from a
    // degraded one. `truncated` rides along inside `...synthesis`, and under
    // brief `sourcesBlock` replaces it with the capped one.
    return ok({
      ...synthesis,
      ...(fromLibrary
        ? {
            answer: untrusted(
              synthesis.answer,
              "an answer built from pages and files kept in the Library"
            ),
          }
        : {}),
      ...sourcesBlock,
      ...pendingBlock,
      ...spacesBlock,
      ...queueBlock,
      degraded: retrieved.degraded,
      lens: retrieved.lens,
    });
  },
  synap_get_entities: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const profileSlug =
      (args.profileSlug as string | undefined) ||
      (args.type as string | undefined);
    const limit = pageLimit(args.limit, 50, ENTITIES_PAGE_MAX);
    const offset = pageOffset(args.offset);
    // Sort is applied in SQL before paging. An unknown field or direction is an
    // error the agent can act on, never a silently unsorted list.
    const sortBy = args.sortBy as string | undefined;
    const sortDir = args.sortDir as string | undefined;
    let orderBy: EntityListOrderBy | undefined;
    if (sortBy !== undefined || sortDir !== undefined) {
      const parsed = parseEntityListSort(
        `${sortBy ?? "createdAt"}${sortDir ? `:${sortDir}` : ""}`
      );
      if ("error" in parsed) return ok({ error: parsed.error });
      orderBy = parsed.orderBy;
    }
    // "Who haven't I spoken to in a month": the last-interaction window. An
    // unparseable or inverted bound is an error, never an empty "nobody".
    const bound = (key: string): Date | undefined | null => {
      const raw = args[key];
      if (raw === undefined || raw === null || raw === "") return undefined;
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const lastInteractionAfter = bound("lastInteractionAfter");
    const lastInteractionBefore = bound("lastInteractionBefore");
    if (lastInteractionAfter === null || lastInteractionBefore === null) {
      return ok({
        error:
          "lastInteractionAfter/lastInteractionBefore must be ISO-8601 dates (e.g. 2026-09-26T00:00:00Z)",
      });
    }
    const interactionWindow = lastInteractionWindowWhere({
      lastInteractionAfter,
      lastInteractionBefore,
    });
    if ("error" in interactionWindow) {
      return ok({ error: interactionWindow.error });
    }
    // FILTERS: the Hub `GET /entities` grammar (view filters, ANDed, capped),
    // as an array or its JSON. Malformed, too many, or a property filter with
    // no kind is an error the agent can read, never a list that silently
    // ignores the filter. An unknown or secret property is the core's own
    // BAD_REQUEST (`entityListFiltersWhere`).
    const parsedFilters = parseEntityListFiltersInput(
      args.filters,
      profileSlug || undefined
    );
    if (!parsedFilters.ok) return ok({ error: parsedFilters.error });
    const filters = parsedFilters.filters;
    const includeFacets = args.includeFacets === true;
    // Listed under a ROLE, a lean row's status is that role's facet status:
    // the list loads the facet rows for it (`projectLeanEntityList`).
    const listedUnder =
      (args.detail as string | undefined) === "full"
        ? undefined
        : await leanListedUnderRole(profileSlug || undefined);
    const page = await caller.entities.getEntities({
      userId,
      profileSlug: profileSlug || undefined,
      ...(args.workspaceId ? { workspaceId: args.workspaceId as string } : {}),
      // Project-pinned MCP URL (?projectId=) auto-injects args.projectId, so a
      // focused agent's entity reads narrow to its project — same lens as ask.
      ...(args.projectId ? { projectId: args.projectId as string } : {}),
      // Kind + Facets: narrow to entities carrying a live facet of this role.
      ...(args.facetSlug ? { facetSlug: args.facetSlug as string } : {}),
      // PAGING (plan 9992207a, c-paging): one row past the page tells whether
      // another page exists — the hub forwarder returns rows, not a total.
      ...(orderBy ? { orderBy } : {}),
      ...(lastInteractionAfter ? { lastInteractionAfter } : {}),
      ...(lastInteractionBefore ? { lastInteractionBefore } : {}),
      ...(args.includeNever === true ? { includeNever: true } : {}),
      ...(filters ? { filters } : {}),
      ...(includeFacets || listedUnder ? { includeFacets: true } : {}),
      limit: limit + 1,
      offset,
    });
    const hasMore = page.length > limit;
    const result = hasMore ? page.slice(0, limit) : page;
    const paging = {
      offset,
      ...(hasMore ? { nextOffset: offset + limit } : {}),
    };
    // HONEST EMPTY: a bare [] reads as "none exist" — but this call is LENSED
    // (profileSlug/workspace/project/facet). An agent that concludes "the user
    // has no X" from a scoped-empty is the ExaSearch "not accessible" mistake
    // one layer down. When empty AND a lens was applied, echo the lens and say
    // the emptiness is scoped, not absolute. (Shape normalized to an object,
    // matching get_graph/list_capabilities; ok() forwards it verbatim.)
    const lens = [
      profileSlug ? `profileSlug=${profileSlug}` : null,
      args.workspaceId ? `workspaceId=${String(args.workspaceId)}` : null,
      args.projectId ? `projectId=${String(args.projectId)}` : null,
      args.facetSlug ? `facetSlug=${String(args.facetSlug)}` : null,
      filters ? `filters=${JSON.stringify(filters)}` : null,
    ].filter(Boolean);
    const note =
      result.length === 0 && lens.length > 0
        ? `No entities matched under this lens (${lens.join(", ")}). This is a SCOPED empty, not proof the user has none — broaden the scope (drop a filter, omit workspaceId for pod-wide) or call synap_ask before concluding anything is absent.`
        : undefined;
    // `detail: "full"` = today's rows, unprojected. LEAN (default) — see
    // `read-lean.ts` for the measured reason (70,138 chars for 50 notes).
    if ((args.detail as string | undefined) === "full") {
      return ok({
        entities: result,
        count: result.length,
        ...paging,
        ...(note ? { note } : {}),
      });
    }
    // `fields`: extra property keys or columns the caller names, returned
    // whole — a lean row never makes a value unreachable.
    const named = Array.isArray(args.fields)
      ? (args.fields as unknown[]).filter(
          (f): f is string => typeof f === "string" && f.length > 0
        )
      : [];
    // A lean row drops `facets` (it only names it in `omitted`); a caller that
    // asked for them with includeFacets must get them, whole.
    const fields = includeFacets
      ? [...new Set([...named, "facets", "facetSlugs"])]
      : named.length > 0
        ? named
        : undefined;
    return ok({
      entities: await projectLeanEntityList(
        result as unknown as Array<Record<string, unknown>>,
        {
          ...(fields ? { fields } : {}),
          ...(listedUnder ? { listedUnder } : {}),
        }
      ),
      count: result.length,
      ...paging,
      detail: "lean",
      note: note ?? ENTITIES_LEAN_NOTE,
    });
  },
  synap_get_document: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const fetched = await caller.documents.getDocument({
      userId,
      documentId: args.documentId as string,
      ...(args.format === "readable" ? { format: "readable" as const } : {}),
    });
    // Body slicing, ONLY when the caller asked for a slice: a default cut would
    // let a read-modify-write (`synap_update_document`) write back half a body.
    // The global reply cap is what bounds an unsliced read, and its notice
    // names this `limit` / `offset` pair.
    const body = fetched.document.content;
    const sliceAsked = args.limit !== undefined || args.offset !== undefined;
    const start = pageOffset(args.offset);
    const end =
      start +
      pageLimit(args.limit, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const result =
      sliceAsked && typeof body === "string"
        ? {
            ...fetched,
            document: { ...fetched.document, content: body.slice(start, end) },
            slice: {
              contentTotal: body.length,
              offset: start,
              ...(end < body.length ? { nextOffset: end } : {}),
            },
          }
        : fetched;
    // Another person's document is their text, not the caller's: fenced
    // (`untrusted`, audit F5). The author is read through the caller's own
    // floor (the read above already admitted the document); a row that cannot
    // be read is fenced too (fail closed).
    const [row] = await scopedDb(AccessContext.operator({ userId })).findMany<{
      userId: string;
    }>(documents, {
      where: eq(documents.id, result.document.id),
      columns: { userId: true },
    });
    if (row?.userId === userId) return ok(result);
    return ok({
      ...result,
      document: {
        ...result.document,
        content: untrusted(
          result.document.content,
          "a document another person wrote"
        ),
      },
    });
  },
  synap_get_thread_context: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // `limit` used to reach nothing — every call returned 50 messages.
    // Clamped, not refused: an over-large ask still gets the cap.
    const cursor =
      typeof args.cursor === "string" && isUuid(args.cursor)
        ? args.cursor
        : undefined;
    const result = await caller.context.getThreadContext({
      threadId: args.threadId as string,
      limit: pageLimit(args.limit, 50, 100),
      ...(cursor ? { cursor } : {}),
    });
    // Only the caller's own typing is theirs. A teammate's, an agent's, an
    // external contact's (WhatsApp, email, Telegram) or the pod's own message
    // is fenced (`untrusted`, audit F5), by the ONE room rule
    // (`classifyRoomAuthor`) judged against the caller. Each message is
    // clipped to THREAD_MESSAGE_MAX_CHARS first (`truncated`, `contentChars`).
    const messages = result.messages.map((m) => {
      const long =
        typeof m.content === "string" &&
        m.content.length > THREAD_MESSAGE_MAX_CHARS;
      const content = long
        ? `${m.content.slice(0, THREAD_MESSAGE_MAX_CHARS - 1)}…`
        : m.content;
      const clip = long
        ? { truncated: true, contentChars: m.content.length }
        : {};
      return m.userId &&
        classifyRoomAuthor(
          { role: m.role, authorType: m.authorType, userId: m.userId },
          userId
        ) === "person"
        ? { ...m, content, ...clip }
        : {
            ...m,
            content: untrusted(
              content,
              `a channel message (${m.authorType ?? "unknown"} author)`
            ),
            ...clip,
          };
    });
    // A program reads this room (a worker's follow-ups): the reply fits under
    // the cap instead of coming back cut (finding 69fdd2e6). The messages are
    // newest first, so the ones a fit leaves out are the oldest, and
    // `nextCursor` reads on from the last one shown.
    const fitted = fitReply(
      { ...result, messages },
      {
        how: "This reply was fitted under the reply cap: the oldest messages were left out (read them with `cursor: nextCursor`), and each list in `omitted` kept its first items, each string in `clipped` its start.",
      }
    );
    const shown = fitted.messages;
    const cutMessages = shown.length < messages.length;
    return ok({
      ...fitted,
      ...(cutMessages
        ? {
            hasMore: true,
            nextCursor: shown[shown.length - 1]?.id ?? result.nextCursor,
          }
        : {}),
    });
  },
  /**
   * ONE proposal, in full — the "why did my write not land?" door.
   *
   * Why it exists: an agent whose write came back `proposed` had NO way to read
   * that row back. `synap_list_proposals` defaults to a summary projection and
   * a failed proposal's `rejectionReason` / `data.failure` — the fields naming
   * what to fix — were reachable from no agent door at all, so the agent could
   * only guess or re-file. Routed through the tRPC `proposals.get` procedure so
   * the visibility gate (`assertProposalVisibleTo`) and the agent-only failure
   * projection (`projectProposalRowForViewer`) are the SAME ones every other
   * read door runs; this handler adds no predicate of its own.
   */
  synap_get_proposal: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const raw =
      typeof args.proposalId === "string" ? args.proposalId.trim() : "";
    if (!raw) return ok({ error: "proposalId is required." });
    // `lean` (default) is one copy of the payload; `full` is the whole row.
    const detail = (args.detail as string | undefined) ?? "lean";
    if (detail !== "lean" && detail !== "full") {
      return ok({
        error: `Unknown detail '${detail}'. Valid values: lean (default), full.`,
      });
    }
    // Short-id parity with `synap_reject_proposal` / `synap_revise_proposal`:
    // a bare prefix in a `WHERE id = $1` uuid lookup throws.
    const { resolveProposalId } =
      await import("../../hub-protocol/rest/_shared.js");
    const proposalId = await resolveProposalId(userId, raw);
    const callerCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      undefined,
      undefined,
      undefined,
      agentUserId
    );
    const { proposalsRouter } = await import("../../proposals.js");
    const caller = proposalsRouter.createCaller(
      callerCtx as Parameters<typeof proposalsRouter.createCaller>[0]
    );
    const proposal = await caller.get({ proposalId });
    return ok(detail === "full" ? proposal : leanProposal(proposal));
  },
  /**
   * THE needs-you read (decision E) — the twin of Hub `GET /needs-you`: both
   * call `signals.needsYou`, so an agent and an outside reader see the same
   * rows by fold and the same count.
   */
  synap_get_flow: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const profileSlug =
      typeof args.profileSlug === "string" ? args.profileSlug.trim() : "";
    if (!profileSlug)
      return ok({
        error: "profileSlug is required: a kind or role (synap_list_profiles).",
      });
    const projectId =
      typeof args.projectId === "string" && args.projectId
        ? args.projectId
        : "";
    if (projectId && !isUuid(projectId))
      return ok({ error: `projectId is not a valid id: ${projectId}` });
    const firstN =
      typeof args.firstN === "number" && Number.isFinite(args.firstN)
        ? Math.min(50, Math.max(0, Math.floor(args.firstN)))
        : undefined;
    const callerCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      undefined,
      undefined,
      undefined,
      agentUserId
    );
    // The SAME function as tRPC `flow.of` and Hub `GET /flow`; the space is
    // the confined lens (`adapter.ts`): a bound key reads its own space.
    const { flowOfInput, readFlowOf } =
      await import("../../../services/lifecycle/flow-read.js");
    return ok(
      await readFlowOf(
        flowOfInput.parse({
          profileSlug,
          ...(ctx.confinedWorkspaceId
            ? { workspaceId: ctx.confinedWorkspaceId }
            : {}),
          ...(projectId ? { projectId } : {}),
          ...(firstN !== undefined ? { firstN } : {}),
        }),
        callerCtx as Parameters<typeof readFlowOf>[1]
      )
    );
  },
  /**
   * THE board read — the twin of Hub `GET /whiteboards/:viewId/scene`: both
   * call `readBoardScene`. A failed read is a tool error naming its `reason`,
   * never an empty board. Shape and arrow text is what anyone on the board
   * wrote, so it reaches the model fenced as untrusted data.
   */
  synap_read_board: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, keyWorkspaceId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const viewId = typeof args.viewId === "string" ? args.viewId.trim() : "";
    if (!viewId)
      return toolError(
        `Tool '${toolName}': viewId is required: the whiteboard view's id (synap_list_views).`
      );
    const badId = fullUuidError(toolName, "viewId", viewId);
    if (badId) return badId;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
    const frameId =
      typeof args.frameId === "string" && args.frameId.trim()
        ? args.frameId.trim()
        : undefined;
    const { readBoardScene, BoardSceneReadError } =
      await import("../../../services/whiteboards/read-board-scene.js");
    try {
      const read = await readBoardScene({
        viewId,
        userId,
        confinedWorkspaceId: keyWorkspaceId ?? null,
        // Paged by default: a board's whole scene easily passes the reply cap.
        window: {
          ...(frameId ? { frameId } : {}),
          offset: num(args.offset) ?? 0,
          limit: Math.min(200, Math.max(1, num(args.limit) ?? 40)),
        },
      });
      const fence =
        "text on a whiteboard (anyone on the board may have written it)";
      return ok({
        ...read,
        scene: {
          ...read.scene,
          shapes: read.scene.shapes.map((s) =>
            s.text ? { ...s, text: untrusted(s.text, fence) } : s
          ),
          arrows: read.scene.arrows.map((a) =>
            a.text ? { ...a, text: untrusted(a.text, fence) } : a
          ),
        },
      });
    } catch (err) {
      if (err instanceof BoardSceneReadError) {
        return toolError(
          `Tool '${toolName}' could not read the board (reason: ${err.reason}): ${err.message}`
        );
      }
      throw err;
    }
  },
  synap_needs_you: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(200, Math.max(1, Math.floor(args.limit)))
        : undefined;
    const callerCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      undefined,
      undefined,
      undefined,
      agentUserId
    );
    const { signalsRouter } = await import("../../signals.js");
    const caller = signalsRouter.createCaller(
      callerCtx as Parameters<typeof signalsRouter.createCaller>[0]
    );
    return ok(
      await caller.needsYou({
        ...(str(args.workspaceId)
          ? { workspaceId: str(args.workspaceId) }
          : {}),
        ...(str(args.projectId) ? { projectId: str(args.projectId) } : {}),
        ...(str(args.trackId) ? { trackId: str(args.trackId) } : {}),
        ...(str(args.sessionId) ? { sessionId: str(args.sessionId) } : {}),
        ...(limit ? { limit } : {}),
      })
    );
  },
  synap_list_proposals: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // A package nobody knows is refused in words, never read as "no filter".
    if (args.package !== undefined && !isReviewPackage(args.package)) {
      return ok({
        error: `Unknown package '${String(args.package)}'. Valid values: ${REVIEW_PACKAGES.join(", ")}.`,
      });
    }
    const { listCreatedProposals } =
      await import("../../../services/proposals/proposals-service.js");
    const result = await listCreatedProposals({
      // `createdBy` is the ONLY user floor this service applies — a
      // model-supplied `args.userId` would list a foreign user's proposals.
      createdBy: userId,
      workspaceId: args.workspaceId as string | undefined,
      // Gate 2: session proposal pack filter
      sessionId:
        typeof args.sessionId === "string" && args.sessionId.trim() !== ""
          ? args.sessionId
          : undefined,
      status: args.status as string | undefined,
      // One row past the page tells whether another page exists.
      limit: pageLimit(args.limit, 20, LIST_PAGE_MAX) + 1,
      offset: pageOffset(args.offset),
      package: isReviewPackage(args.package) ? args.package : undefined,
    });
    const propLimit = pageLimit(args.limit, 20, LIST_PAGE_MAX);
    const propOffset = pageOffset(args.offset);
    const hasMoreProposals = result.length > propLimit;
    const propPaging = {
      offset: propOffset,
      ...(hasMoreProposals ? { nextOffset: propOffset + propLimit } : {}),
    };
    const pageResult = result.slice(0, propLimit);
    // A LIST must be readable. Unprojected, this returned every row's full
    // `data` payload: 33 pending proposals measured at 283,737 characters
    // (~6k chars/row, largest single row 36k) — past the tool-result ceiling,
    // so the caller got an error instead of a list and could not enumerate
    // its own proposals at all. `detail: "full"` still returns everything,
    // so no capability is removed — only the default changes.
    // Session content a proposal copied at write time is withheld unless this
    // agent's principal OWNS the target session (decision D1, agent door).
    const { redactUnreadableSessionTargets } =
      await import("../../../services/proposals/session-content-redaction.js");
    const rawRows = await redactUnreadableSessionTargets(pageResult, {
      userId,
    });
    // SETUP — this door calls `listCreatedProposals` DIRECTLY (not
    // `hub.proposals.listProposals`), so the stamping the Hub procedure does
    // never happened here: `setup` was declared on the wire, forwarded by
    // `toProposalBasic`, and produced by NOBODY on MCP — and `detail:"full"`
    // echoed `data.params` raw, so a key a human typed into an install param
    // was readable by the authoring agent. `withProposalSetup` is the ONE door
    // that stamps the setup and redacts the secret param values as a PAIR;
    // applied on BOTH branches, because both serialize `data`.
    const { resolveProposalSetups, withProposalSetup } =
      await import("../../../services/proposals/proposal-setup.js");
    const setups = await resolveProposalSetups(
      rawRows as Record<string, unknown>[],
      userId
    );
    // WAITING ON IT: the same resolver the Hub list door
    // stamps, owner-only on this agent door (decision D1).
    const { resolveProposalWaits, proposalWaitsFields } =
      await import("../../../services/proposals/proposal-waits.js");
    const waits = await resolveProposalWaits(rawRows, { userId });
    const rows = (rawRows as Record<string, unknown>[]).map((row) => ({
      ...withProposalSetup(row, setups),
      ...proposalWaitsFields(row.id, waits),
    }));
    // ONE definition of each view, shared verbatim with the Hub REST
    // `GET /proposals` doors — a second hand-rolled projection here is how
    // the two drifted in the first place.
    const { toProposalBasic, withProposalClass } =
      await import("../../hub-protocol/rest/_codecs/proposal.js");
    if ((args.detail as string) === "full") {
      // `detail:"full"` answers with the whole `data` JSONB, as Hub
      // `view=full`: the class, the fate, and the AGENT-ONLY failure fields
      // stripped (`data.failure.detail` is the redacted raw executor error and
      // its ONE reader is the server-side prompt path, `render-for-prompt.ts`,
      // never a tool result — `failure-projection.ts`).
      // Unchanged shape for `full`: a bare array (paging: `limit`/`offset`).
      return ok(rows.map(withProposalClass));
    }
    const summarized = (rows as Record<string, unknown>[]).map(toProposalBasic);
    return ok({
      proposals: summarized,
      ...propPaging,
      detail: "summary",
      note: "Compact rows. Call again with detail:'full' (and a small limit) to inspect a proposal's full payload.",
    });
  },
  synap_template_health: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const { listWorkspaceTemplateHealth } =
      await import("../../../services/template-health.js");
    // Access-scope FIRST (same predicate the Hub `/workspaces` projection
    // uses), then let the service report health only for what it's handed —
    // it never widens the lens, so a foreign workspace can't leak.
    const wsIds = await getUserAccessibleWorkspaceIds(userId);
    const all = await listWorkspaceTemplateHealth(wsIds, userId);
    const rows = args.driftedOnly ? all.filter((w) => w.drifted) : all;
    return ok({
      workspaces: rows,
      driftedCount: all.filter((w) => w.drifted).length,
      total: all.length,
    });
  },
  synap_diagnose: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // The THIRD door: mode derived from payload shape (like capture), not a
    // caller-chosen tool. {} → whole-pod health · {type} → a class surface ·
    // {id} → auto-detect the object · {agentId} → agent scorecard. Today's
    // run-feed grammar ({runId,flowType} / {flowType,flowId}) is preserved as
    // a back-compat special case inside the router.
    const { diagnoseRouter } =
      await import("../../../services/diagnose/index.js");
    const result = await diagnoseRouter({
      userId,
      agentId: args.agentId as string | undefined,
      id: args.id as string | undefined,
      type: args.type as
        | "proposal"
        | "session"
        | "capability"
        | "agent"
        | "entity"
        | "run"
        | "workspace"
        | "usage"
        | undefined,
      workspaceId: (args.workspaceId as string | undefined) ?? undefined,
      since: args.since as string | undefined,
      groupBy: args.groupBy as string[] | undefined,
      apiKeyId: args.apiKeyId as string | undefined,
      client: args.client as string | undefined,
      stuckThresholdHours: args.stuckThresholdHours as number | undefined,
      flowType: args.flowType as
        | "automation"
        | "playbook"
        | "capture"
        | "capability"
        | "session"
        | undefined,
      flowId: args.flowId as string | undefined,
      runId: args.runId as string | undefined,
      limit: (args.limit as number) || undefined,
    });
    return ok(result);
  },
  synap_get_entity: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // Hub protocol doesn't expose a single-entity get; use regular entities router
    const entityCallerCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      (args.workspaceId as string) || undefined,
      undefined,
      undefined,
      agentUserId
    );
    const entityCaller = regularEntitiesRouter.createCaller(entityCallerCtx);
    const entityResult = await entityCaller.get({
      id: args.entityId as string,
      includeProfile: true,
    });
    // Graph by default: embed a capped typed-neighbour summary so the agent
    // sees the entity's place in the pod without a second call. Additive +
    // best-effort — never let the graph half break the entity read.
    let graph: GraphEnvelope | undefined;
    try {
      graph = await buildGraphEnvelope(
        userId,
        apiKeyScopes,
        "entity",
        args.entityId as string,
        20
      );
    } catch {
      graph = undefined;
    }
    // `detail: "full"` returns TODAY'S payload, byte-identical — this is the
    // pre-existing expression, untouched.
    if ((args.detail as string | undefined) === "full") {
      return ok(
        graph
          ? { ...(entityResult as Record<string, unknown>), graph }
          : entityResult
      );
    }

    /**
     * LEAN (the default) — same convention as `synap_list_profiles`' `toDigest`
     * below, and `synap_list_proposals` / `synap_orient`: the small shape is
     * what a caller gets by default, `detail: "full"` returns the whole row.
     *
     * WHY. `entities.get` resolves the kind's property schema once per
     * accessible workspace into `effectivePropertiesByWorkspace` (16 workspaces
     * for a real user). Measured on the live pod, that fan-out is 83-93% of
     * every entity read: `note` 34,593 chars, `decision` 120,769, `person`
     * 205,118. Claude Code TRUNCATES MCP tool output at 25,000 tokens, and for
     * `person` the fan-out spans chars 12,233-204,239 — so the cut lands INSIDE
     * it, severing the JSON mid-structure (unparseable) and taking every key
     * that follows it (`facets`, `externalLinks`, `graph`) with it.
     *
     * What is KEPT is the half an agent writes against: `effectiveProperties`
     * is resolved from the entity's OWN workspace, so it IS the schema a write
     * to THIS entity is validated against. The other entries describe how a
     * DIFFERENT entity of the same kind would resolve under another lens.
     *
     * Fields are named ONE BY ONE rather than rest-spread, deliberately: a
     * hand-written projection is only safe while something forces it to track
     * its source, so the `entity-get` spec in
     * `__tripwires__/cross-door-field-parity.test.ts` audits this door against
     * `entities.get`'s own zod output schema. Add a field there and this door
     * reds until it answers for it.
     */
    const row = (
      graph
        ? { ...(entityResult as Record<string, unknown>), graph }
        : (entityResult as Record<string, unknown>)
    ) as Record<string, unknown>;
    const byWorkspace = (row.effectivePropertiesByWorkspace ?? {}) as Record<
      string,
      unknown
    >;
    const workspaceIds = Object.keys(byWorkspace);
    // COMPARED, never assumed — measured, the arrays are identical for 6 of 9
    // types but `person` has 5 distinct variants. An overlay list built from
    // "all of them" would be a signpost that names nothing.
    const base = JSON.stringify(row.effectiveProperties ?? null);
    const workspacesWithOverlay = workspaceIds.filter(
      (id) => JSON.stringify(byWorkspace[id]) !== base
    );
    return ok({
      entity: row.entity,
      profile: row.profile,
      // FACETS BEFORE the schema: a person's roles and their status are the
      // answer an agent reads this for, and the reply cap cuts from the END.
      // `effectiveProperties` is the long half (live: eddaa74b, b3372cca,
      // 77b977c2 lost their facets behind it).
      facets: row.facets,
      effectiveProperties: row.effectiveProperties,
      externalLinks: row.externalLinks,
      graph: row.graph,
      // The SIGNPOST. This is what makes the omission honest rather than
      // silent: it names what was withheld, which lenses actually differ, and
      // how to get it back.
      propertyOverlays: {
        workspacesWithOverlay,
        hint:
          `${workspacesWithOverlay.length} of ${workspaceIds.length} accessible ` +
          `workspaces override this kind's property schema. Omitted here: ` +
          `\`effectivePropertiesByWorkspace\` — pass detail:'full' for the ` +
          `per-workspace map. \`effectiveProperties\` above is this entity's ` +
          `own workspace schema, the one a write to it is validated against.`,
      },
    });
  },
  synap_list_profiles: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const wsId = args.workspaceId as string | undefined;
    const wantFull = (args.detail as string | undefined) === "full";

    /**
     * Map a raw profile row to the lightweight digest shape (`read-lean.ts`:
     * the default call measured 117,197 chars live — over the MCP output cap).
     */
    const toDigest = (
      p: Record<string, unknown>,
      workspaceId?: string
    ): Record<string, unknown> =>
      toProfileDigest(p, resolveProfileDescription(p), workspaceId);

    /** Default (digest) relation vocabulary: slugs grouped by lens. */
    const toDigestRelations = (
      r: Awaited<ReturnType<typeof relationTypesFor>>
    ) =>
      "relationTypes" in r
        ? { relationTypes: compactRelationTypes(r.relationTypes) }
        : r;

    /**
     * The relation types that resolve for the same lens(es) the profiles were
     * read under — through the ONE vocabulary read `relations.create` rejects
     * against, so a slug listed here is a slug a write accepts. `null` is the
     * pod-wide base layer; a workspace lens adds that workspace's defs. One row
     * per (workspaceId, slug). A failed read is reported as
     * `relationTypesError`, never as an empty list.
     */
    const relationTypesFor = async (
      lenses: Array<string | null>
    ): Promise<
      | { relationTypes: EffectiveRelationType[] }
      | { relationTypesError: string }
    > => {
      try {
        const database = await getDb();
        const seen = new Set<string>();
        const out: EffectiveRelationType[] = [];
        for (const lens of lenses) {
          for (const t of await listEffectiveRelationTypes(database, lens)) {
            // Exposure edges (`belongs_to_project`, `visible_to`) resolve in the
            // vocabulary but every generic relation door REFUSES them — each
            // has its own writer (`synap_file_into_project` for a project).
            // Listing them here broke "a slug listed is a slug a write accepts".
            if ((EXPOSURE_RELATION_TYPES as readonly string[]).includes(t.slug))
              continue;
            const key = `${t.workspaceId ?? ""}:${t.slug}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(t);
          }
        }
        return { relationTypes: out };
      } catch (err) {
        return {
          relationTypesError: `Relation types could not be read: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    };

    if (wsId) {
      const result = await caller.profiles.listProfiles({
        userId,
        workspaceId: wsId,
      });
      // BOTH lenses: the pod-wide base layer (`null`) AND the workspace's own
      // defs. Reading the workspace lens alone returned every overridden
      // global row tagged with the workspace, so the digest's pod-wide group
      // came back EMPTY (`{workspaceId:null, slugs:[]}`) and the workspace
      // group claimed all 24 globals as its own — live on Brand Library,
      // 2026-09-28, against this tool's own note that null = valid everywhere.
      const relationTypes = await relationTypesFor([null, wsId]);
      const profiles = (
        Array.isArray(result)
          ? result
          : ((result as unknown as { profiles?: unknown[] }).profiles ?? [])
      ) as Array<Record<string, unknown>>;
      const { page, paging } = pageSlice(
        profiles,
        args,
        PROFILES_PAGE_DEFAULT,
        LIST_PAGE_MAX
      );
      // The vocabulary rides the first page only: it does not change per page.
      const rel = paging.offset === 0 ? relationTypes : {};
      if (wantFull) return ok({ ...result, profiles: page, ...paging, ...rel });
      return ok({
        profiles: page.map((p) => toDigest(p)),
        ...paging,
        ...(paging.offset === 0 ? toDigestRelations(relationTypes) : {}),
        detail: "digest",
        note: PROFILES_DIGEST_NOTE,
      });
    }
    // Sorted by id: a STABILITY floor so the first-wins dedupe below picks the
    // same row across calls regardless of membership-query order. This is not
    // a twin policy — which duplicate-slug row SHOULD win is a pending ontology
    // decision; this only stops the answer changing between identical calls.
    const wsIds = [
      ...(await getUserMemberWorkspaceIds(userId, { activeOnly: true })),
    ].sort();
    if (wsIds.length === 0) {
      const podRelations = await relationTypesFor([null]);
      return ok(
        wantFull
          ? { profiles: [], ...podRelations }
          : {
              profiles: [],
              ...toDigestRelations(podRelations),
              detail: "digest",
              note: PROFILES_DIGEST_NOTE,
            }
      );
    }
    const perWs = await Promise.all(
      wsIds.map((id) =>
        caller.profiles
          .listProfiles({ userId, workspaceId: id })
          .then((res) =>
            res.profiles.map(
              (p) =>
                ({
                  ...(p as Record<string, unknown>),
                  workspaceId: id,
                }) as Record<string, unknown>
            )
          )
          // A failed workspace read is RECORDED, never folded into "this
          // workspace has no profiles": the answer names it in
          // `workspacesFailed`, and the other workspaces' profiles still return.
          .then(
            (profiles) => ({ ok: true as const, profiles }),
            (err: unknown) => ({
              ok: false as const,
              workspaceId: id,
              error: err instanceof Error ? err.message : String(err),
            })
          )
      )
    );
    const workspacesFailed = perWs.flatMap((r) =>
      r.ok ? [] : [{ workspaceId: r.workspaceId, error: r.error }]
    );
    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const profiles of perWs.map((r) => (r.ok ? r.profiles : []))) {
      for (const p of profiles) {
        const slug = p.slug as string;
        if (!seen.has(slug)) {
          seen.add(slug);
          merged.push(wantFull ? p : toDigest(p, p.workspaceId as string));
        }
      }
    }
    const relations = await relationTypesFor([null, ...wsIds]);
    const { page, paging } = pageSlice(
      merged,
      args,
      PROFILES_PAGE_DEFAULT,
      LIST_PAGE_MAX
    );
    return ok({
      profiles: page,
      ...paging,
      ...(workspacesFailed.length ? { workspacesFailed } : {}),
      ...(wantFull
        ? paging.offset === 0
          ? relations
          : {}
        : {
            ...(paging.offset === 0 ? toDigestRelations(relations) : {}),
            detail: "digest",
            note: PROFILES_DIGEST_NOTE,
          }),
    });
  },
  synap_get_relations: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const entityId = args.entityId as string;
    // Newest `limit` edges (the read's own cap is 100): said in the schema, so
    // a hub node is bounded here and not only by the global reply cap.
    const relLimit = pageLimit(args.limit, 50, 100);
    // The lens, in order: the caller's explicit workspaceId; else the
    // entity's OWN workspace (a "no relations" answer then reflects its real
    // home, not whichever member workspace sorted first).
    const relWsId =
      (args.workspaceId as string | undefined) ??
      (await entityHomeWorkspaceId(entityId));
    // No lens at all: a POD-WIDE entity (NULL workspace), or one that is
    // deleted or missing. Its edges live in whatever workspaces they were
    // drawn in, so ONE picked member workspace (the old `ids[0]` fallback)
    // hid every edge outside it while synap_get_graph showed them. Read at
    // the caller's USER FLOOR instead, the same read the REST door
    // (`GET /relations` with no workspaceId) and get_graph make: the access
    // layer's `relations` rule still gates every row (member workspaces +
    // the caller's own pod-wide edges), so nothing outside it is reachable.
    if (!relWsId) {
      return ok(
        await caller.relations.listRelationsPodWide({
          userId,
          entityId,
          limit: relLimit,
        })
      );
    }
    const result = await caller.relations.listRelations({
      userId,
      workspaceId: relWsId,
      entityId,
      limit: relLimit,
    });
    return ok(result);
  },
  synap_get_graph: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const gKind = (args.type as string | undefined) ?? "entity";
    let gId = args.id as string | undefined;
    // Name-addressing: fetch the graph by NAME instead of id. Resolve the name
    // to an object first; ambiguous names return the candidates to pick from.
    if (!gId && args.name) {
      const matches = await resolveByName(
        userId,
        gKind,
        args.name as string,
        args.subtype as string | undefined
      );
      if (matches.length === 0) {
        // The name matched no entity of this kind — but it may be a
        // profile/role type name. Probe profiles and route the caller to the
        // right tool instead of dead-ending.
        const profileHits = await resolveProfileByName(
          userId,
          args.name as string
        );
        if (profileHits.length > 0) {
          return ok({
            error: `'${args.name}' is a profile/role, not a ${gKind}. get_graph resolves entities, not types.`,
            candidates: profileHits,
            hint: profileHits.some((p) => p.profileKind === "role")
              ? "This is a role (facet). Use synap_list_profiles to inspect it, synap_attach_facet to attach it to an entity, or synap_define_role to edit it."
              : "This is a kind. Use synap_list_profiles to inspect its schema, or synap_get_entities to list entities of this type.",
          });
        }
        return ok({ error: `No ${gKind} named '${args.name}'` });
      }
      if (matches.length > 1)
        return ok({
          ambiguous: true,
          message: `Multiple ${gKind}s named '${args.name}' — pass id`,
          matches,
        });
      gId = matches[0].id;
    }
    if (!gId) return ok({ error: "id or name is required" });
    // An id whose SHAPE the target table cannot accept (an 8-char short id
    // against a uuid column) used to reach Postgres, throw 22P02, and surface
    // as the generic "failed against the pod's storage layer... a pod-side
    // fault, not something your arguments caused" — a server-fault message for
    // what is purely a bad argument. Measured live 2026-09-22 with `9d43e988`,
    // the short id the product prints elsewhere.
    //
    // Caught rather than shape-guarded: `get_graph` serves kinds whose ids are
    // NOT uuids (a `capability` resolves ids like "exa-search"), so a blanket
    // uuid test would refuse legitimate calls. The DRIVER knows which columns
    // are uuid; we only translate its verdict into an actionable sentence.
    let envelope;
    try {
      envelope = await buildGraphEnvelope(userId, apiKeyScopes, gKind, gId);
    } catch (err) {
      if (isInvalidUuidInput(err)) {
        return ok({
          error: `'${gId}' is not a valid id for a ${gKind}. This object's ids are uuids — short ids are not resolved here.`,
          hint: "Pass `name` to look it up by name, or take the full id from synap_ask / synap_get_entities / synap_list_*.",
        });
      }
      throw err;
    }
    // A table-backed id that hydrated to nothing with no visible edges — the id
    // genuinely doesn't exist / isn't visible. Return not-found, never a shell
    // node named by its own UUID (mirrors the name-not-found branch above).
    if (!envelope.found) {
      return ok({ error: `No ${gKind} with id '${gId}'` });
    }
    // Neighbours page like every list door; `counts` stay the full totals.
    const { page, paging } = pageSlice(
      envelope.neighbors,
      args,
      LIST_PAGE_DEFAULT,
      LIST_PAGE_MAX
    );
    return ok({ ...envelope, neighbors: page, ...paging });
  },
  synap_get_channel: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    // GET-OR-CREATE, so this declares the WRITE scope despite the name.
    //
    // Both modes mint rows: `ensurePersonal` creates the personal channel, and
    // `by-context` resolve-or-creates one bound to an object.
    //
    // This is NOT closing an open hole — it makes an existing one honest. The
    // inner procedure is already `scopedProcedure(["hub-protocol.write"])`
    // (hub-protocol/channels.ts), and a read-only key derives only
    // `hub-protocol.read`, so the create was already rejected one layer down.
    // Declaring `mcp.read` here just meant the rejection arrived deep, as a
    // confusing inner 403, instead of at the door with a scope message. It also
    // contradicted `skills/synap/writes.md`, which documents this operation as
    // needing write scope.
    //
    // Practically non-breaking: a read-only key could never complete this call.
    //
    // Kept as ONE tool rather than split into get + create: the create IS the
    // point (a caller asking for a context channel wants one to exist), and a
    // near-identical sibling tool is exactly the overlap that degrades tool
    // selection.
    const mode = args.mode as string;
    if (mode === "person") {
      // A READ: the person's channels and each one's pending proposed
      // messages, through the caller's floor and key grant
      // (services/channels/person-channels.ts) — the same read as Hub
      // GET /entities/:id/channels + /channels/:id/proposed-messages.
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const entityId = args.entityId;
      if (typeof entityId !== "string" || !isUuid(entityId)) {
        return ok({
          error:
            "entityId (the record's full UUID) is required for mode 'person'",
        });
      }
      const result = await listPersonChannels({ userId, entityId });
      if (result.status === "not_found") {
        return ok({ error: `No record you can read with id '${entityId}'` });
      }
      const channels = [];
      for (const ch of result.channels) {
        const proposed = await listProposedMessages({
          userId,
          channelId: ch.id,
        });
        channels.push({
          ...ch,
          proposedMessages: proposed.status === "ok" ? proposed.proposed : [],
        });
      }
      return ok({ entityId, channels });
    }
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const wsId = args.workspaceId as string;
    if (!wsId) {
      return ok({ error: `workspaceId is required for mode '${mode}'` });
    }
    if (mode === "personal") {
      const result = await caller.channels.ensurePersonal({
        userId,
        workspaceId: wsId,
      });
      return ok(result);
    }
    if (!args.contextObjectType || !args.contextObjectId) {
      return ok({
        error:
          "contextObjectType and contextObjectId are required for mode 'by-context'",
      });
    }
    const result = await caller.channels.resolveOrCreateChannel({
      userId,
      workspaceId: wsId,
      channelType: "thread" as const,
      contextObjectType: args.contextObjectType as "entity" | "document",
      contextObjectId: args.contextObjectId as string,
    });
    return ok(result);
  },
};
