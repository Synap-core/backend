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
      // Byte-for-byte copy of the synap-app comment scanner, identical in every
      // repo: a lint or format fix here would fork it from the canonical.
      "scripts/strip-comments.mjs",
      "scripts/strip-comments.d.mts",
      // Same for the pre-commit checker: byte-identical in synap-app,
      // synap-backend and synap-control-plane-api (see its header).
      "scripts/precommit-check.mjs",
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
      // `disallowTypeAnnotations: false`: inline `typeof import("./x")` types are
      // the idiom here, not a lapse — vitest's documented
      // `importOriginal<typeof import("./x")>()` in ~660 test files, and lazy
      // `await import()` doors that type the module without a static edge. The
      // rule still converts every static value import used only as a type.
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          disallowTypeAnnotations: false,
        },
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
      // Unenforced-period debt (CI red 2026-05-05 → 2026-10-18), may only
      // SHRINK: `entityRepo.create` sites written while nothing ran this rule.
      // Not sanctioned — funnel each through materializeEntity, delete its line.
      "packages/api/src/services/definition-seeds.ts", // created d6db364bb 2026-09-27
      "packages/api/src/services/event-sync/migrate-gcal-events.ts", // created 069b0345d 2026-07-23
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
    // Reconciled 2026-10-19: a parent split into a folder is replaced by its
    // split files (each says which parent and commit); parents that no longer
    // touch a scoped table, and paths that no longer exist, were dropped.
    // scripts/check-eslint-ledger-paths.mjs fails CI on a path that is gone.
    files: [
      "packages/api/src/routers/activity.ts",
      "packages/api/src/routers/artifacts.ts",
      "packages/api/src/routers/automations.ts",
      "packages/api/src/routers/capabilities.ts",
      "packages/api/src/routers/capability-containers.ts",
      "packages/api/src/routers/capture.ts",
      "packages/api/src/routers/cell-instances.ts",
      "packages/api/src/routers/cells.ts",
      "packages/api/src/routers/channels/branches.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/channels/crud.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/channels/external.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/channels/feeds.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/channels/helpers.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/channels/messaging.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/channels/send-message.ts", // split from routers/channels.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/chat-stream.ts",
      "packages/api/src/routers/devplane.ts",
      "packages/api/src/routers/documents.ts",
      "packages/api/src/routers/entities.ts",
      "packages/api/src/routers/entities/admin.ts", // split from routers/entities.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/entities/create.ts", // split from routers/entities.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/entities/facets.ts", // split from routers/entities.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/entities/helpers.ts", // split from routers/entities.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/entities/mutate.ts", // split from routers/entities.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/entities/read.ts", // split from routers/entities.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/external/chat.ts",
      "packages/api/src/routers/file-upload.ts",
      "packages/api/src/routers/graph.ts",
      "packages/api/src/routers/hub-protocol/branches.ts",
      "packages/api/src/routers/hub-protocol/channels.ts",
      "packages/api/src/routers/hub-protocol/context.ts",
      "packages/api/src/routers/hub-protocol/documents.ts",
      "packages/api/src/routers/hub-protocol/linking.ts",
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
      "packages/api/src/routers/hub-protocol/rest/projects.ts",
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
      "packages/api/src/routers/proposals/apply-approval.ts", // split from routers/proposals.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/proposals/display.ts", // split from routers/proposals.ts in b32b606dd (2026-08-13)
      "packages/api/src/routers/proposals/executors/automation.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/capability.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/catch-all.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/cell.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/channel.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/document.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/entity.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/focus-session.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/messaging.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/playbook.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/profile.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/project.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/property-def.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/provider.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/shared.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/skill.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/tool.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/view.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/proposals/executors/workspace.ts", // split from routers/proposals/approve-executors.ts in 054f6afd9 (2026-08-12)
      "packages/api/src/routers/relations.ts",
      "packages/api/src/routers/secrets-vault.ts",
      "packages/api/src/routers/skills.ts",
      "packages/api/src/routers/subscriptions.ts",
      "packages/api/src/routers/sync.ts",
      "packages/api/src/routers/system.ts",
      "packages/api/src/routers/tools.ts",
      "packages/api/src/routers/views.ts",
      "packages/api/src/routers/webhooks-inbound.ts",
      "packages/api/src/routers/whiteboards.ts",
      "packages/api/src/routers/widget-definitions.ts",
      "packages/api/src/routers/workspaces/definition-engine.ts", // split from routers/workspaces.ts in b32b606dd (2026-08-13)
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
      "packages/api/src/routers/users.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // Unenforced-period debt (CI red 2026-05-05 → 2026-10-18), may only SHRINK.
    // The ledger above was written on 2026-07-11 while CI was already dark, so
    // nothing stopped new routers from doing raw scoped-table access. These are
    // the routers that did — written after the ledger, or split from a router
    // the ledger never listed (mcp/adapter.ts), or older files that gained raw
    // access later. They are listed so CI can go green; they are NOT sanctioned.
    // Convert each to scopedDb / scopedDb().mutate() and delete its line. Never
    // add a line here: a new router goes through the access layer.
    files: [
      "packages/api/src/routers/captures.ts", // created 4ff56b807 2026-09-14
      "packages/api/src/routers/connectors-trpc.ts", // created 408aadf0d 2026-03-23; file predates the ledger, raw access since 0fde689e0 2026-09-13
      "packages/api/src/routers/file-upload-presign.ts", // created 1e8045b08 2026-10-05
      "packages/api/src/routers/focus-sessions.ts", // created 2383016dc 2026-06-10; file predates the ledger, raw access since 70f7d0c4f 2026-10-01
      "packages/api/src/routers/governance-rules.ts", // created 2511c96b0 2026-07-27
      "packages/api/src/routers/guidelines.ts", // created 9cc6cb6ca 2026-08-12
      "packages/api/src/routers/hub-protocol/agent-belongs-to.ts", // created 2099fc31f 2026-10-11
      "packages/api/src/routers/hub-protocol/compacted-states.ts", // created 6d3681634 2026-03-05; file predates the ledger, raw access since a5294e738 2026-10-06
      "packages/api/src/routers/hub-protocol/playbook-doors.ts", // created 7b4540f3c 2026-09-14
      "packages/api/src/routers/hub-protocol/rest/_shared.ts", // created 48592420b 2026-05-03; file predates the ledger, raw access since b6d6d3fb1 2026-07-19
      "packages/api/src/routers/hub-protocol/rest/calendar-feed.ts", // created a00ad0460 2026-09-12
      "packages/api/src/routers/hub-protocol/rest/discord.ts", // created cbbd822c9 2026-06-20; file predates the ledger, raw access since 1c79eadb1 2026-08-03
      "packages/api/src/routers/hub-protocol/rest/events.ts", // created 48592420b 2026-05-03; file predates the ledger, raw access since 44c7a8e0a 2026-08-04
      "packages/api/src/routers/hub-protocol/rest/installed.ts", // created cc6ccd6b2 2026-09-06
      "packages/api/src/routers/hub-protocol/rest/mcp-redeem.ts", // created a05e1c9b1 2026-07-24
      "packages/api/src/routers/hub-protocol/rest/pod-config.ts", // created f67446fcb 2026-07-19
      "packages/api/src/routers/hub-protocol/rest/public-projection.ts", // created 8262089f3 2026-07-19
      "packages/api/src/routers/hub-protocol/sessions.ts", // created 6d3681634 2026-03-05; file predates the ledger, raw access since 122b8cec6 2026-08-15
      "packages/api/src/routers/mcp/handlers/capture.ts", // created b32b606dd 2026-08-13, split from routers/mcp/adapter.ts (never ledgered)
      "packages/api/src/routers/mcp/handlers/session.ts", // created b32b606dd 2026-08-13, split from routers/mcp/adapter.ts (never ledgered)
      "packages/api/src/routers/mcp/handlers/shared.ts", // created b32b606dd 2026-08-13, split from routers/mcp/adapter.ts (never ledgered)
      "packages/api/src/routers/mcp/handlers/workspace.ts", // created b32b606dd 2026-08-13, split from routers/mcp/adapter.ts (never ledgered)
      "packages/api/src/routers/mcp/tool-access.ts", // created a4dcbb1d1 2026-09-28
      "packages/api/src/routers/onboarding.ts", // created 3458bedbd 2026-07-26
      "packages/api/src/routers/projects.ts", // created fcbbbcc16 2026-01-15; file predates the ledger, raw access since f2c68567b 2026-10-14
      "packages/api/src/routers/proposals/ask-ai.ts", // created 2dc6dd66f 2026-09-22
      "packages/api/src/routers/proposals/executors/agent.ts", // created b27570b36 2026-10-11
      "packages/api/src/routers/proposals/executors/ai-provider.ts", // created 3654911b6 2026-09-09
      "packages/api/src/routers/proposals/executors/app.ts", // created 7decd8de5 2026-10-06
      "packages/api/src/routers/proposals/executors/artifact.ts", // created 292092a85 2026-08-21
      "packages/api/src/routers/proposals/executors/dev-approval.ts", // created 8fe559861 2026-09-05
      "packages/api/src/routers/proposals/executors/entity-transition.ts", // created ae8cd5f3f 2026-10-11
      "packages/api/src/routers/proposals/executors/link.ts", // created d6db364bb 2026-09-27
      "packages/api/src/routers/proposals/executors/playbook-stage-gate.ts", // created 8fe559861 2026-09-05
      "packages/api/src/routers/proposals/executors/pod-hygiene.ts", // created 8ea3d08f1 2026-09-14
      "packages/api/src/routers/proposals/executors/project-filing.ts", // created a70a01e1b 2026-09-28
      "packages/api/src/routers/proposals/executors/role.ts", // created 292092a85 2026-08-21
      "packages/api/src/routers/proposals/executors/rule.ts", // created 55a3dec9b 2026-08-20
      "packages/api/src/routers/proposals/executors/track.ts", // created e135da6a9 2026-09-25
      "packages/api/src/routers/proposals/executors/vault.ts", // created 3a9154706 2026-10-06
      "packages/api/src/routers/proposals/executors/widget.ts", // created 292092a85 2026-08-21
      "packages/api/src/routers/proposals/object-refs.ts", // created 8b71c5838 2026-10-14
      "packages/api/src/routers/proposals/render-for-prompt.ts", // created 97d764a15 2026-07-13
      "packages/api/src/routers/resource-state.ts", // created 97d764a15 2026-07-13
      "packages/api/src/routers/signal.ts", // created 7a6d75f19 2026-08-05
      "packages/api/src/routers/signals.ts", // created b219b7d30 2026-09-04
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
