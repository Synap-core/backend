import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-plugin-prettier/recommended";
import globals from "globals";

// ── Registered scoped tables (access/registry.ts) ────────────────────────────
// The set of tables that carry a VisibilityRule and are therefore readable via
// scopedDb() / writable via scopedDb().mutate(). Keep this in sync with
// registry.ts — a table added there should be added here so raw access to it in
// a router is banned. (The read/write tripwires derive their set from the live
// registry; this ESLint list is the static mirror the linter needs.)
const SCOPED_TABLES = [
  "automations",
  "automationRuns",
  "mcpServers",
  "cellInstances",
  "roles",
  "channels",
  "artifacts",
  "tools",
  "playbooks",
  "links",
  "playbookRuns",
  "relationDefs",
  "widgetDefinitions",
  "intelligenceCommands",
  "entities",
  "documents",
  "relations",
  "entityFacets",
  "proposals",
  // Batch 3 — user-floored tables (access/registry.ts):
  "secrets",
  "apiKeys",
  "notifications",
  "feeds",
  "inboxItems",
  "sourceConfigs",
  "sourceSubscriptions",
  "userPreferences",
  "userResourceState",
  "agentConfigs",
];
const SCOPED_TABLES_RE = `/^(${SCOPED_TABLES.join("|")})$/`;
const SCOPED_ACCESS_MESSAGE =
  "Route through scopedDb(AccessContext.from(ctx)) / scopedDb(access).mutate() — see access/README.";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.docusaurus/**",
      "**/.wrangler/**",
      "**/generated.d.ts", // Generated files from Drizzle ORM
      "**/*.generated.ts",
      "**/*.generated.d.ts",
      "**/*.d.ts", // Declaration files (auto-generated, not hand-written)
      "**/.claude/**",
      "**/deploy/pod-agent/**", // Standalone Node.js agent (not part of TS build)
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "warn", // Downgrade to warn (generated files use {})
      "no-undef": "off", // TypeScript handles this better
      "no-case-declarations": "warn", // Downgrade to warn (common pattern in switch statements)
      "react-hooks/exhaustive-deps": "off", // Plugin not installed for root (Next.js apps handle this differently)
    },
  },
  // ── Tripwire: raw `entities` inserts must go through the governed materializer ──
  // Direct `db.insert(entities)` / `tx.insert(entities)` bypasses the five
  // invariants owned by `materializeEntity()` (relation-slug guard, dedup,
  // project-link, provenance, completeness). New entity writes MUST funnel
  // through `materializeEntity` (or the `EntityRepository` it wraps). This rule
  // catches new raw inserts at review time.
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    // Tests + standalone scripts legitimately seed raw rows — the tripwire only
    // governs production write paths.
    ignores: [
      "packages/**/*.test.ts",
      "packages/**/*.spec.ts",
      "packages/**/tests/**",
      "packages/**/__tests__/**",
      "packages/**/scripts/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='insert'][arguments.0.name='entities']",
          message:
            "Raw `.insert(entities)` bypasses the governed entity materializer. Use `materializeEntity()` from @synap/database (it wraps EntityRepository.create and owns provenance/dedup/project-link/relation-slug invariants). If this is a sanctioned low-level site, add it to the allowlist in eslint.config.mjs.",
        },
        {
          // `entityRepo.create(...)` is the OTHER door into an entity write, and
          // the raw-insert selector above cannot see it (the repository does the
          // insert, and the repository is allowlisted). That blind spot is how
          // EntityUpsertService bypassed the materializer unnoticed. Banning the
          // call here closes it.
          selector:
            "CallExpression[callee.property.name='create'][callee.object.name='entityRepo']",
          message:
            "`entityRepo.create()` bypasses the governed entity materializer — the five invariants (relation-slug guard, dedup, project-link, provenance, completeness) never run. Use `materializeEntity()` from @synap/database; it wraps EntityRepository.create itself. If this is a sanctioned low-level site, add it to the allowlist in eslint.config.mjs.",
        },
      ],
    },
  },
  {
    // Allowlist — sites sanctioned to write an entity directly (raw insert
    // and/or `entityRepo.create`).
    //   • materialize-entity.ts   — the materializer itself (its physical home).
    //   • entity-repository.ts    — the canonical create the materializer wraps.
    //   • sync-materializer.ts    — replication sink (raw by design; not a create).
    // The remaining entries are Wave-2 HARD sites not yet funneled; they already
    // apply provenance/project-link via their own paths. This list SHRINKS as
    // Wave 2 funnels them through materializeEntity.
    // NOTE: entity-upsert-service.ts is deliberately ABSENT — it was funneled
    // through materializeEntity, and its absence is what keeps it funneled.
    files: [
      "packages/database/src/utils/materialize-entity.ts",
      "packages/database/src/repositories/entity-repository.ts",
      "packages/database/src/utils/sync-materializer.ts",
      // Wave-2 (temporary):
      "packages/api/src/routers/entities.ts",
      "packages/jobs/src/workers/materializer.ts",
      "packages/api/src/routers/capture.ts",
      "packages/database/src/services/team-person-bridge.ts",
      "packages/database/src/utils/create-workspace-from-definition.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // ── By-construction access enforcement: no raw scoped-table access in routers ──
  // Inside routers/**, a raw `db.query.<t>` / `db.select().from(<t>)` /
  // `db.insert|update|delete(<t>)` for any REGISTERED scoped table bypasses the
  // access layer's structural guarantees: reads skip the visibility predicate
  // (cross-workspace read-leak class) and writes skip `assertWorkspaceWrite`
  // (cross-workspace write-leak class). Route reads through
  // `scopedDb(AccessContext.from(ctx)).findMany/findFirst` and writes through
  // `scopedDb(access).mutate(table)`. The allowlist below is the MIGRATION
  // LEDGER — every router that still does raw access today; later batches convert
  // them and REMOVE the entry. It may only SHRINK. (This block intentionally
  // OVERRIDES the entities-insert rule above for router files — its writes
  // selector already covers `insert(entities)`, so coverage is preserved.)
  {
    files: ["packages/api/src/routers/**/*.ts"],
    ignores: ["packages/api/src/routers/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // db.query.<scopedTable> / database.query.<scopedTable> / tx.query.<t>
          selector: `MemberExpression[object.property.name='query'][property.name=${SCOPED_TABLES_RE}]`,
          message: SCOPED_ACCESS_MESSAGE,
        },
        {
          // db.select().from(<scopedTable>)
          selector: `CallExpression[callee.property.name='from'][arguments.0.name=${SCOPED_TABLES_RE}]`,
          message: SCOPED_ACCESS_MESSAGE,
        },
        {
          // db.insert|update|delete(<scopedTable>)
          selector: `CallExpression[callee.property.name=/^(insert|update|delete)$/][arguments.0.name=${SCOPED_TABLES_RE}]`,
          message: SCOPED_ACCESS_MESSAGE,
        },
        {
          // Re-declared here because this block OVERRIDES `no-restricted-syntax`
          // for routers/** (one rule name = one selector list), which would
          // otherwise silently drop the materializer tripwire for every router.
          // The access selectors above do NOT cover `entityRepo.create`.
          selector:
            "CallExpression[callee.property.name='create'][callee.object.name='entityRepo']",
          message:
            "`entityRepo.create()` bypasses the governed entity materializer — the five invariants (relation-slug guard, dedup, project-link, provenance, completeness) never run. Use `materializeEntity()` from @synap/database. If this is a sanctioned low-level site, add it to the allowlist in eslint.config.mjs.",
        },
      ],
    },
  },
  {
    // Allowlist — routers that still perform raw scoped-table access (the
    // migration ledger). SHRINKS as batches convert each to scopedDb /
    // scopedDb().mutate(). A NEW router doing raw access is NOT added here — it
    // is written through the access layer from the start.
    files: [
      "packages/api/src/routers/activity.ts",
      "packages/api/src/routers/artifacts.ts",
      "packages/api/src/routers/automations.ts",
      "packages/api/src/routers/capabilities.ts",
      "packages/api/src/routers/capability-containers.ts",
      "packages/api/src/routers/capture.ts",
      "packages/api/src/routers/cell-instances.ts",
      "packages/api/src/routers/cells.ts",
      "packages/api/src/routers/channels.ts",
      "packages/api/src/routers/chat-stream.ts",
      "packages/api/src/routers/devplane.ts",
      "packages/api/src/routers/documents.ts",
      "packages/api/src/routers/entities.ts",
      "packages/api/src/routers/external/chat.ts",
      "packages/api/src/routers/file-upload.ts",
      "packages/api/src/routers/graph.ts",
      "packages/api/src/routers/hub-protocol/branches.ts",
      "packages/api/src/routers/hub-protocol/channels.ts",
      "packages/api/src/routers/hub-protocol/context.ts",
      "packages/api/src/routers/hub-protocol/documents.ts",
      "packages/api/src/routers/hub-protocol/linking.ts",
      "packages/api/src/routers/hub-protocol/migration.ts",
      "packages/api/src/routers/hub-protocol/profiles.ts",
      "packages/api/src/routers/hub-protocol/proposals.ts",
      "packages/api/src/routers/hub-protocol/rest/artifacts.ts",
      "packages/api/src/routers/hub-protocol/rest/cell-instances.ts",
      "packages/api/src/routers/hub-protocol/rest/cells.ts",
      "packages/api/src/routers/hub-protocol/rest/channels.ts",
      "packages/api/src/routers/hub-protocol/rest/entities.ts",
      "packages/api/src/routers/hub-protocol/rest/focus-sessions.ts",
      "packages/api/src/routers/hub-protocol/rest/knowledge.ts",
      "packages/api/src/routers/hub-protocol/rest/mcp-servers.ts",
      "packages/api/src/routers/hub-protocol/rest/messaging.ts",
      "packages/api/src/routers/hub-protocol/rest/packages.ts",
      "packages/api/src/routers/hub-protocol/rest/projects.ts",
      "packages/api/src/routers/hub-protocol/rest/resolve.ts",
      "packages/api/src/routers/hub-protocol/rest/runs.ts",
      "packages/api/src/routers/hub-protocol/rest/threads.ts",
      "packages/api/src/routers/hub-protocol/rest/vault.ts",
      "packages/api/src/routers/hub-protocol/rest/workspaces.ts",
      "packages/api/src/routers/hub-protocol/signals.ts",
      "packages/api/src/routers/hub-protocol/widget-definitions.ts",
      "packages/api/src/routers/hub.ts",
      "packages/api/src/routers/intelligence.ts",
      "packages/api/src/routers/mcp-servers.ts",
      "packages/api/src/routers/playbook-runs.ts",
      "packages/api/src/routers/playbooks.ts",
      "packages/api/src/routers/proposals.ts",
      "packages/api/src/routers/proposals/approve-executors.ts",
      "packages/api/src/routers/relations.ts",
      "packages/api/src/routers/search.ts",
      "packages/api/src/routers/secrets-vault.ts",
      "packages/api/src/routers/sharing.ts",
      "packages/api/src/routers/skills.ts",
      "packages/api/src/routers/subscriptions.ts",
      "packages/api/src/routers/sync.ts",
      "packages/api/src/routers/system.ts",
      "packages/api/src/routers/tools.ts",
      "packages/api/src/routers/views.ts",
      "packages/api/src/routers/webhooks-inbound.ts",
      "packages/api/src/routers/whiteboards.ts",
      "packages/api/src/routers/widget-definitions.ts",
      "packages/api/src/routers/workspaces.ts",
      // Batch 3 (access-convergence migration ledger) — routers that still do
      // raw access to the newly-registered user-floored tables. Every read in
      // these is already `userId`-floored (or podAdmin/workspace-gated); the
      // remaining raw sites are writes needing .returning()/onConflict/owner-
      // column support the .mutate() door lacks, plus deliberately-broad
      // admin/service reads. Convert per table in later batches; SHRINKS.
      "packages/api/src/routers/admin-source-configs.ts",
      "packages/api/src/routers/agent-configs.ts",
      "packages/api/src/routers/agent-users.ts",
      "packages/api/src/routers/api-keys.ts",
      "packages/api/src/routers/feeds.ts",
      "packages/api/src/routers/hub-protocol/rest/agent-configs.ts",
      "packages/api/src/routers/hub-protocol/rest/auth.ts",
      "packages/api/src/routers/hub-protocol/rest/keys.ts",
      "packages/api/src/routers/hub-protocol/rest/setup.ts",
      "packages/api/src/routers/inbox.ts",
      "packages/api/src/routers/intelligence-registry.ts",
      "packages/api/src/routers/notif-center.ts",
      "packages/api/src/routers/preferences.ts",
      "packages/api/src/routers/source-configs.ts",
      "packages/api/src/routers/source-subscriptions.ts",
      "packages/api/src/routers/trusted-issuers.ts",
      "packages/api/src/routers/users.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
