/**
 * Search Service
 * Multi-search with union mode for unified results
 */

import { getTypesenseClient } from "../client.js";
import type { SearchResult } from "../types/index.js";
import type { MultiSearchRequestSchema } from "typesense/lib/Typesense/MultiSearch";

export interface UnifiedSearchOptions {
  query: string;
  userId: string;
  workspaceId?: string;
  collections?: string[];
  limit?: number;
  page?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  found: number;
  searchTimeMs: number;
}

export class SearchService {
  private queryFieldsMap: Record<string, string> = {
    entities: "title,content,description",
    documents: "title,content",
    views: "name,description",
    projects: "name,description",
    chat_threads: "title,summary",
    agents: "name,description,systemPrompt",
  };

  /**
   * Unified search across multiple collections
   * Uses multi_search for parallel queries
   */
  async search(options: UnifiedSearchOptions): Promise<SearchResponse> {
    const client = getTypesenseClient();

    const collections = options.collections || [
      "entities",
      "documents",
      "views",
      "projects",
      "chat_threads",
      "agents",
    ];

    // Build multi-search request
    const searches: MultiSearchRequestSchema["searches"] = collections.map(
      (collection) => ({
        collection,
        q: options.query,
        query_by: this.getQueryFields(collection),
        filter_by: this.buildFilter(options),
        sort_by: "_text_match:desc,updatedAt:desc",
        per_page: options.limit || 20,
        page: options.page || 1,
        highlight_full_fields: this.getQueryFields(collection),
        highlight_affix_num_tokens: 3,
        prioritize_exact_match: true,
        prioritize_token_position: true,
      })
    );

    // Execute multi-search
    const response = await client.multiSearch.perform(
      {
        searches,
      },
      {
        limit_multi_searches: 100,
      }
    );

    // Process results
    const allResults: SearchResult[] = [];
    let totalFound = 0;
    let totalSearchTime = 0;

    response.results.forEach((result, index) => {
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

    return {
      results: allResults.slice(0, options.limit || 20),
      found: totalFound,
      searchTimeMs: totalSearchTime,
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
    }
  ): Promise<SearchResponse> {
    const client = getTypesenseClient();

    const searchParams = {
      q: query,
      query_by: this.getQueryFields(collection),
      filter_by: this.buildFilter(options),
      sort_by: "_text_match:desc,updatedAt:desc",
      per_page: options.limit || 20,
      page: options.page || 1,
      highlight_full_fields: this.getQueryFields(collection),
      highlight_affix_num_tokens: 3,
    };

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

    return {
      results,
      found: result.found || 0,
      searchTimeMs: result.search_time_ms || 0,
    };
  }

  /**
   * Get query fields for collection
   */
  private getQueryFields(collection: string): string {
    return this.queryFieldsMap[collection] || "title";
  }

  /**
   * Build filter for multi-tenancy
   */
  private buildFilter(options: {
    userId: string;
    workspaceId?: string;
  }): string {
    const filters: string[] = [`userId:${options.userId}`];

    if (options.workspaceId) {
      filters.push(`workspaceId:${options.workspaceId}`);
    }

    return filters.join(" && ");
  }
}

export const searchService = new SearchService();
