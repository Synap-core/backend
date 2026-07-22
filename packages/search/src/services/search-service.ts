/**
 * Search Service
 * Multi-search with union mode for unified results
 */

import { getTypesenseAdminClient } from "../client.js";
import type { SearchResult } from "../types/index.js";
import type { MultiSearchRequestSchema } from "../types/index.js";
import { POD_WIDE_WORKSPACE_SCOPE } from "../utils/workspace-scope.js";
import { getDb, eq, drizzleSql } from "@synap/database";
import * as schema from "@synap/database/schema";

export interface UnifiedSearchOptions {
  query: string;
  userId: string;
  workspaceId?: string;
  collections?: string[];
  limit?: number;
  page?: number;
  entityTypes?: string[];
  documentTypes?: string[];
  viewTypes?: string[];
  tags?: string[];
  status?: string[];
  prefix?: boolean;
  facetBy?: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  found: number;
  searchTimeMs: number;
  facetCounts?: Record<string, Record<string, number>>;
}

export class SearchService {
  private queryFieldsMap: Record<string, string> = {
    entities: "title",
    documents: "title",
    views: "name",
    channels: "title",
    agents: "title",
    messages: "content",
  };

  /**
   * Unified search across multiple collections
   * Uses multi_search for parallel queries
   */
  async search(options: UnifiedSearchOptions): Promise<SearchResponse> {
    const client = getTypesenseAdminClient();

    const collections = options.collections || [
      "entities",
      "documents",
      "views",
      "channels",
      "agents",
    ];

    // Resolve the caller's member-workspace floor once, only when the `entities`
    // collection is in play — the entity filter admits rows shared into a
    // workspace the caller belongs to (membership/role-lens), closing the gap
    // where a shared entity is in `entities.list` but not in Cmd-K / recall.
    const visibleWorkspaceIds = collections.includes("entities")
      ? await this.resolveVisibleWorkspaceIds(options.userId)
      : [];

    // Build multi-search request
    const searches: MultiSearchRequestSchema["searches"] = collections.map(
      (collection) => {
        const searchParams: any = {
          collection,
          q: options.query,
          query_by: this.getQueryFields(collection),
          filter_by: this.buildFilter({
            ...options,
            collection,
            visibleWorkspaceIds,
          }),
          sort_by: "_text_match:desc,updatedAt:desc",
          per_page: options.limit || 20,
          page: options.page || 1,
          highlight_full_fields: this.getQueryFields(collection),
          highlight_affix_num_tokens: 3,
          prioritize_exact_match: !options.prefix,
          prioritize_token_position: true,
        };

        if (options.prefix) {
          searchParams.infix = ["title", "content"];
        }

        if (options.facetBy?.length) {
          searchParams.facet_by = options.facetBy.join(",");
        }

        return searchParams;
      }
    );

    // Execute multi-search
    const response = (await client.multiSearch.perform(
      {
        searches,
      },
      {
        limit_multi_searches: 100,
      } as any
    )) as any;

    // Process results
    const allResults: SearchResult[] = [];
    let totalFound = 0;
    let totalSearchTime = 0;

    response.results.forEach((result: any, index: number) => {
      if ("hits" in result && result.hits) {
        totalFound += result.found || 0;
        totalSearchTime += result.search_time_ms || 0;

        result.hits.forEach((hit: any) => {
          allResults.push({
            id: hit.document.id,
            collection: collections[index],
            document: hit.document,
            highlights: hit.highlights,
            textMatch: hit.text_match || 0,
          });
        });
      }
    });

    // Sort by text match score (unified ranking)
    allResults.sort((a, b) => b.textMatch - a.textMatch);

    // Extract facet counts
    const facetCounts: Record<string, Record<string, number>> = {};
    if (options.facetBy?.length) {
      response.results.forEach((result: any, index: number) => {
        if (result.facet_counts) {
          const collection = collections[index];
          facetCounts[collection] = {};
          result.facet_counts.forEach((fc: any) => {
            facetCounts[collection][fc.field_name] = fc.stats?.total || 0;
            fc.counts.forEach((c: any) => {
              facetCounts[collection][`${fc.field_name}.${c.value}`] = c.count;
            });
          });
        }
      });
    }

    return {
      results: allResults.slice(0, options.limit || 20),
      found: totalFound,
      searchTimeMs: totalSearchTime,
      facetCounts:
        Object.keys(facetCounts).length > 0 ? facetCounts : undefined,
    };
  }

  /**
   * Search within a specific collection
   */
  async searchCollection(
    collection: string,
    query: string,
    options: {
      userId: string;
      workspaceId?: string;
      /**
       * Channel-scoped message search. When set, the filter is pinned to this
       * single channel and the generic `userId:=` visibility clause is SKIPPED —
       * channel access must already be proven by the DB gate in the caller.
       */
      channelId?: string;
      limit?: number;
      page?: number;
      entityTypes?: string[];
      documentTypes?: string[];
      viewTypes?: string[];
      tags?: string[];
      status?: string[];
      prefix?: boolean;
      facetBy?: string[];
    }
  ): Promise<SearchResponse> {
    const client = getTypesenseAdminClient();

    // Entity floor parity (see `search`): resolve the caller's member workspaces
    // so a membership/role-lens-shared entity is found. Skipped for the channelId
    // short-circuit (its own multi-author gate) and non-entity collections.
    const visibleWorkspaceIds =
      collection === "entities" && !options.channelId
        ? await this.resolveVisibleWorkspaceIds(options.userId)
        : [];

    const searchParams: any = {
      q: query,
      query_by: this.getQueryFields(collection),
      filter_by: this.buildFilter({
        ...options,
        collection,
        visibleWorkspaceIds,
      }),
      sort_by: "_text_match:desc,updatedAt:desc",
      per_page: options.limit || 20,
      page: options.page || 1,
      highlight_full_fields: this.getQueryFields(collection),
      highlight_affix_num_tokens: 3,
      prioritize_exact_match: !options.prefix,
      prioritize_token_position: true,
    };

    if (options.prefix) {
      searchParams.infix = ["title", "content"];
    }

    if (options.facetBy?.length) {
      searchParams.facet_by = options.facetBy.join(",");
    }

    const result = await client
      .collections(collection)
      .documents()
      .search(searchParams);

    const results: SearchResult[] = (result.hits || []).map((hit: any) => ({
      id: hit.document.id,
      collection,
      document: hit.document,
      highlights: hit.highlights,
      textMatch: hit.text_match || 0,
    }));

    // Extract facet counts
    let facetCounts: Record<string, Record<string, number>> | undefined;
    if (options.facetBy?.length && (result as any).facet_counts) {
      facetCounts = {};
      facetCounts[collection] = {};
      (result as any).facet_counts.forEach((fc: any) => {
        facetCounts![collection][fc.field_name] = fc.stats?.total || 0;
        fc.counts.forEach((c: any) => {
          facetCounts![collection][`${fc.field_name}.${c.value}`] = c.count;
        });
      });
    }

    return {
      results,
      found: result.found || 0,
      searchTimeMs: result.search_time_ms || 0,
      facetCounts,
    };
  }

  /**
   * Get query fields for collection
   */
  private getQueryFields(collection: string): string {
    return this.queryFieldsMap[collection] || "title";
  }

  /**
   * The caller's member-workspace floor for the ENTITY search filter — the set of
   * workspace ids whose membership (or pod-visibility) grants a NON-OWNER read.
   *
   * MIRRORS `getUserWorkspaceIds` (packages/api/src/utils/workspace-membership.ts):
   * the workspaces the user is a member of ∪ the pod-visible / pod-joinable
   * workspaces. It is duplicated here (not imported) because `@synap/api` depends
   * on `@synap/search` — importing upward would be circular. The search/DB parity
   * tripwire (`search-db-visibility-parity.test.ts`) guards this mirror against
   * drift with `getUserWorkspaceIds` + the DB `accessScopeWhere` floor.
   */
  private async resolveVisibleWorkspaceIds(userId: string): Promise<string[]> {
    const db = await getDb();
    const memberRows = await db.query.workspaceMembers.findMany({
      where: eq(schema.workspaceMembers.userId, userId),
      columns: { workspaceId: true },
    });
    const ids = new Set(memberRows.map((r) => r.workspaceId));
    const podReadable = await db.query.workspaces.findMany({
      where: drizzleSql`${schema.workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`,
      columns: { id: true },
    });
    for (const w of podReadable) ids.add(w.id);
    return [...ids];
  }

  /**
   * The per-collection visibility FLOOR clause.
   *
   * - `entities`: owner OR membership/role-lens share. Admits the caller's own
   *   rows (`userId:=caller`) UNION rows shared into a workspace the caller is a
   *   member of (`visibleInWorkspaces:=[...]` — the entity's own workspace + its
   *   active facets, denormalized at index time). Mirrors the DB
   *   `accessScopeWhere` floor's owner + workspace-membership + facetLens branches.
   *
   *   PHASE 2 (keyword half): this does NOT cover the EXPOSURE axis (project
   *   `belongs_to_project` / `visible_to` client-portal edges) — those are not
   *   denormalized into the index yet. The VECTOR half of recall post-filters with
   *   the real `accessScopeWhere` floor and DOES cover exposure; Cmd-K keyword
   *   results do not. Do not claim full parity here.
   *
   * - other collections: owner-only (`userId:=caller`) — their sharing model is
   *   not denormalized; behaviour-preserving. Empty `visibleWorkspaceIds` also
   *   falls back to owner-only (byte-for-byte the pre-parity filter).
   */
  private buildFloor(options: {
    userId: string;
    collection?: string;
    visibleWorkspaceIds?: string[];
  }): string {
    const owner = `userId:=\`${options.userId}\``;
    const wsIds = options.visibleWorkspaceIds ?? [];
    if (options.collection === "entities" && wsIds.length > 0) {
      const shared = `visibleInWorkspaces:=[${wsIds
        .map((w) => `\`${w}\``)
        .join(",")}]`;
      return `(${owner} || ${shared})`;
    }
    return owner;
  }

  /**
   * Build filter for multi-tenancy and optional filters
   */
  private buildFilter(options: {
    userId: string;
    workspaceId?: string;
    channelId?: string;
    collection?: string;
    visibleWorkspaceIds?: string[];
    entityTypes?: string[];
    documentTypes?: string[];
    viewTypes?: string[];
    tags?: string[];
    status?: string[];
  }): string {
    // Channel-scoped message search: the caller has already proven channel
    // visibility via the DB channel-access gate, so we pin to the single channel
    // and do NOT add the generic `userId:=` clause (messages have many authors).
    if (options.channelId) {
      return `channelId:=\`${options.channelId}\``;
    }

    const filters: string[] = [this.buildFloor(options)];

    if (options.workspaceId) {
      filters.push(
        `(workspaceId:=\`${options.workspaceId}\` || workspaceId:=\`${POD_WIDE_WORKSPACE_SCOPE}\`)`
      );
    }

    const collection = options.collection;

    if (collection === "entities" && options.entityTypes?.length) {
      filters.push(
        `entityType:=(${options.entityTypes.map((t) => `\`${t}\``).join("|")})`
      );
    }

    if (collection === "documents" && options.documentTypes?.length) {
      filters.push(
        `documentType:=(${options.documentTypes.map((t) => `\`${t}\``).join("|")})`
      );
    }

    if (collection === "views" && options.viewTypes?.length) {
      filters.push(
        `viewType:=(${options.viewTypes.map((t) => `\`${t}\``).join("|")})`
      );
    }

    if (options.tags?.length) {
      for (const tag of options.tags) {
        filters.push(`tags:=\`${tag}\``);
      }
    }

    if (options.status?.length) {
      filters.push(
        `status:=(${options.status.map((s) => `\`${s}\``).join("|")})`
      );
    }

    return filters.join(" && ");
  }
}

export const searchService = new SearchService();
