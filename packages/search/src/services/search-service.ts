/**
 * Search Service
 * Multi-search with union mode for unified results
 */

import { getTypesenseAdminClient } from "../client.js";
import type { SearchResult } from "../types/index.js";
import type { MultiSearchRequestSchema } from "../types/index.js";
import { POD_WIDE_WORKSPACE_SCOPE } from "../utils/workspace-scope.js";

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

    // Build multi-search request
    const searches: MultiSearchRequestSchema["searches"] = collections.map(
      (collection) => {
        const searchParams: any = {
          collection,
          q: options.query,
          query_by: this.getQueryFields(collection),
          filter_by: this.buildFilter({ ...options, collection }),
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

    const searchParams: any = {
      q: query,
      query_by: this.getQueryFields(collection),
      filter_by: this.buildFilter({ ...options, collection }),
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
   * Build filter for multi-tenancy and optional filters
   */
  private buildFilter(options: {
    userId: string;
    workspaceId?: string;
    collection?: string;
    entityTypes?: string[];
    documentTypes?: string[];
    viewTypes?: string[];
    tags?: string[];
    status?: string[];
  }): string {
    const filters: string[] = [`userId:=\`${options.userId}\``];

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
