/**
 * Search Document Types
 */

export interface SearchDocument {
  id: string;
  [key: string]: any;
}

export interface IndexingQueueItem {
  collection: string;
  operation: "upsert" | "delete";
  documentId: string;
  timestamp: number;
}

export interface SearchResult {
  id: string;
  collection: string;
  document: any;
  highlights?: any;
  textMatch: number;
}

// Manually defined Typesense types to avoid deep import issues
export type FieldType =
  | "string"
  | "int32"
  | "int64"
  | "float"
  | "bool"
  | "geopoint"
  | "geopoint[]"
  | "string[]"
  | "int32[]"
  | "int64[]"
  | "float[]"
  | "bool[]"
  | "object"
  | "object[]"
  | "auto"
  | "string*"
  | "image";

export interface CollectionFieldSchema {
  name: string;
  type: FieldType;
  optional?: boolean;
  facet?: boolean;
  index?: boolean;
  sort?: boolean;
  infix?: boolean;
  locale?: string;
  num_dim?: number;
  store?: boolean;
  [key: string]: any;
}

export interface CollectionCreateSchema {
  name: string;
  fields?: CollectionFieldSchema[];
  default_sorting_field?: string;
  enable_nested_fields?: boolean;
  symbols_to_index?: string[];
  token_separators?: string[];
  [key: string]: any;
}

export interface MultiSearchRequestSchema {
  collection?: string;
  q?: string;
  query_by?: string;
  filter_by?: string;
  sort_by?: string;
  page?: number;
  per_page?: number;
  group_by?: string;
  group_limit?: number;
  include_fields?: string;
  exclude_fields?: string;
  highlight_full_fields?: string;
  highlight_affix_num_tokens?: number;
  highlight_start_tag?: string;
  highlight_end_tag?: string;
  snippet_threshold?: number;
  num_typos?: string | number;
  min_len_1typo?: number;
  min_len_2typo?: number;
  split_join_tokens?: string;
  exhaustive_search?: boolean;
  drop_tokens_threshold?: number;
  typo_tokens_threshold?: number;
  pinned_hits?: string;
  hidden_hits?: string;
  limit_hits?: number;
  pre_segmented_query?: boolean;
  enable_overrides?: boolean;
  prioritize_exact_match?: boolean;
  prioritize_token_position?: boolean;
  limit_multi_searches?: number;
  [key: string]: any;
}
