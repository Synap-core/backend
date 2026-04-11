/**
 * Schema Coherence Validator
 *
 * Guards against silent schema drift on pod startup.
 *
 * Why this exists
 * ---------------
 * The repo abandoned drizzle-kit after migration 0003. Every schema change
 * since has been a hand-written .sql file in migrations-drizzle/ or
 * migrations-custom/. Some columns/tables declared in the Drizzle schema
 * drifted — they were only added defensively in later migrations (ADD COLUMN
 * IF NOT EXISTS), and a pod that stopped at an earlier version would be
 * missing columns the runtime code expects.
 *
 * The 0099_schema_reconciliation.sql migration is the catch-up. This file
 * is the *tripwire*: it runs on every server boot (right after migrations,
 * before the HTTP server starts listening) and fails loudly if any critical
 * column is still missing. If it throws, the pod exits non-zero and the
 * supervisor surfaces the error.
 *
 * The column list below is deliberately short — ~30 columns that cover the
 * recent drift. It is NOT a full schema check. Its job is to catch known
 * at-risk columns and block startup if the reconciliation migration failed
 * to run (or was reverted).
 */

import { sql } from "../client-pg.js";

/**
 * A single column the runtime requires to exist.
 *
 * `addedBy` is the filename of the migration expected to create it — used in
 * the error message so an operator knows which migration to investigate.
 */
interface RequiredColumn {
  table: string;
  column: string;
  addedBy: string;
}

/**
 * Critical columns that must exist for the API to function.
 *
 * Every column that 0099_schema_reconciliation.sql adds is listed here, plus
 * a handful of high-value columns that were added in earlier migrations but
 * whose absence has historically caused outages.
 *
 * Keep this list in sync with 0099_schema_reconciliation.sql.
 */
const REQUIRED_COLUMNS: ReadonlyArray<RequiredColumn> = [
  // property_defs — audit flagged these (0057 / 0064 / 0065)
  {
    table: "property_defs",
    column: "profile_id",
    addedBy: "0064_property_defs_profile_scoped_unique.sql",
  },
  {
    table: "property_defs",
    column: "workspace_id",
    addedBy: "0065_property_defs_workspace_scope.sql",
  },
  {
    table: "property_defs",
    column: "relation_def_id",
    addedBy: "0057_unified_relations.sql",
  },
  {
    table: "property_defs",
    column: "target_profile_id",
    addedBy: "0057_unified_relations.sql",
  },

  // channels — audit flagged scope + feed_scope (0066), plus 0047 additions
  { table: "channels", column: "scope", addedBy: "0066_channel_system_v2.sql" },
  {
    table: "channels",
    column: "feed_scope",
    addedBy: "0066_channel_system_v2.sql",
  },
  {
    table: "channels",
    column: "result_summary",
    addedBy: "0047_session_scoped_memory.sql (custom)",
  },
  {
    table: "channels",
    column: "merged_into_state_id",
    addedBy: "0047_session_scoped_memory.sql (custom)",
  },

  // messages — renamed from conversation_messages in 0038 (custom)
  {
    table: "messages",
    column: "author_type",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "message_category",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "external_source",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "inbox_item_id",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "session_id",
    addedBy: "0047_session_scoped_memory.sql (custom)",
  },

  // entities
  {
    table: "entities",
    column: "system_data",
    addedBy: "0046_entities_system_data.sql (custom)",
  },
  {
    table: "entities",
    column: "profile_id",
    addedBy: "0003_sparkling_thundra.sql",
  },

  // profiles
  {
    table: "profiles",
    column: "semantic_slug",
    addedBy: "0054_profile_semantic_slug.sql",
  },
  {
    table: "profiles",
    column: "entity_scope",
    addedBy: "0060_entity_scope_column.sql",
  },
  {
    table: "profiles",
    column: "default_values",
    addedBy: "0035_consolidate_data_model.sql",
  },

  // api_keys
  {
    table: "api_keys",
    column: "key_type",
    addedBy: "0044_api_keys_type_description.sql (custom)",
  },
  {
    table: "api_keys",
    column: "description",
    addedBy: "0044_api_keys_type_description.sql (custom)",
  },

  // proposals
  {
    table: "proposals",
    column: "agent_user_id",
    addedBy: "0034_proposals_agent_user_expiry.sql",
  },
  {
    table: "proposals",
    column: "thread_id",
    addedBy: "0037_proposals_thread_linkage.sql (custom)",
  },

  // users
  {
    table: "users",
    column: "user_type",
    addedBy: "0032_ai_agent_users.sql (custom)",
  },
  {
    table: "users",
    column: "agent_metadata",
    addedBy: "0032_ai_agent_users.sql (custom)",
  },

  // widget_definitions
  {
    table: "widget_definitions",
    column: "source",
    addedBy: "0056_widget_native_columns.sql",
  },
  {
    table: "widget_definitions",
    column: "bundle_source",
    addedBy: "0056_widget_native_columns.sql",
  },

  // channel_context_items
  {
    table: "channel_context_items",
    column: "relevance_score",
    addedBy: "0047_session_scoped_memory.sql (custom)",
  },

  // agent_configs — declared in schema, never in any earlier migration
  {
    table: "agent_configs",
    column: "agent_type",
    addedBy: "0099_schema_reconciliation.sql",
  },

  // entity_identity_signals — declared in schema, never in any earlier migration
  {
    table: "entity_identity_signals",
    column: "signal_type",
    addedBy: "0099_schema_reconciliation.sql",
  },
  {
    table: "entity_identity_signals",
    column: "signal_value",
    addedBy: "0099_schema_reconciliation.sql",
  },
];

export interface SchemaCoherenceResult {
  ok: boolean;
  missing: RequiredColumn[];
  checked: number;
}

/**
 * Check that every critical column exists in the live DB.
 *
 * Returns the result rather than throwing so callers can log cleanly.
 * Use `assertSchemaCoherence()` for the throw-on-failure variant.
 */
export async function checkSchemaCoherence(): Promise<SchemaCoherenceResult> {
  const tables = Array.from(new Set(REQUIRED_COLUMNS.map((c) => c.table)));

  // One query: SELECT table_name, column_name FROM information_schema.columns
  // WHERE table_schema = 'public' AND table_name = ANY($1)
  const rows = await sql<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(${tables})
  `;

  const present = new Set<string>();
  for (const row of rows) {
    present.add(`${row.table_name}.${row.column_name}`);
  }

  const missing: RequiredColumn[] = [];
  for (const req of REQUIRED_COLUMNS) {
    if (!present.has(`${req.table}.${req.column}`)) {
      missing.push(req);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    checked: REQUIRED_COLUMNS.length,
  };
}

/**
 * Run the coherence check and throw a loud, structured error if anything is
 * missing. Intended for server bootstrap — call this AFTER migrations run
 * and BEFORE the HTTP server starts listening.
 *
 * On failure the error message lists every missing (table, column) pair and
 * the migration that should have added it.
 */
export async function validateSchemaCoherence(): Promise<void> {
  const result = await checkSchemaCoherence();

  if (result.ok) {
    return;
  }

  const lines = [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "SCHEMA COHERENCE CHECK FAILED",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `The live database is missing ${result.missing.length} column(s) that`,
    "the Drizzle schema and runtime code require. The server cannot start.",
    "",
    "Missing columns (table.column — expected in migration):",
  ];
  for (const m of result.missing) {
    lines.push(`  • ${m.table}.${m.column}  ← ${m.addedBy}`);
  }
  lines.push("");
  lines.push(
    "Run the migration tool (pnpm --filter @synap/database migrate) to apply"
  );
  lines.push(
    "0099_schema_reconciliation.sql, then restart the pod. If the migration"
  );
  lines.push(
    "itself fails, investigate its error output — the runner no longer"
  );
  lines.push("silently skips failed migrations.");
  lines.push(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  lines.push("");

  const message = lines.join("\n");
  throw new Error(message);
}
