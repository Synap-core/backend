/**
 * Skills Schema
 *
 * The canonical skills table — merged from the (now-dropped) agent_skills table.
 * Four kinds, differentiated by `kind`:
 *
 *   instruction — text injected into the agent system prompt (always-on
 *                 knowledge/methodology). Uses the `body` column (Markdown).
 *   code        — JS/TS function executed in the Intelligence Hub sandbox
 *                 (callable tool). Uses the `code` column.
 *   declarative — provider-verb spec the pod runs IN-PROCESS (Tier-1). Uses the
 *                 `provider_spec` column; carries no code.
 *   builtin     — first-party op run IN-PROCESS via a governed handler (Tier-0),
 *                 keyed by the skill `name`; carries no code/spec.
 *
 * Columns absorbed from agent_skills: slug, body, topics, source, author,
 * version, tags. Doc-style skills set kind='instruction' with body populated;
 * executable skills set kind='code' with code populated.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { documents } from "./documents.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export type SkillKind = "instruction" | "code" | "declarative" | "builtin";

/**
 * Declarative spec for a `kind:'declarative'` capability verb — a deterministic
 * provider HTTP call the POD executes IN-PROCESS via `triggerProviderAction`
 * (no Intelligence Service, no sandbox isolate). The Tier-1 counterpart to a
 * `kind:'code'` skill (which runs untrusted JS in the IS isolate).
 *
 * Re-declared here (NOT imported) so the schema package stays dependency-free,
 * exactly like `ToolVerbCatalogEntry` in `schema/tools.ts`. The canonical copy
 * lives in `@synap/playbooks` and is kept in lock-step.
 *
 * Interpolation: `{{param}}` tokens in `pathTemplate`/`query`/`body` are filled
 * from the (param-mapped) call parameters. `default:"@now"` ⇒ current ISO
 * timestamp. Dot-paths in `responseShape` index into the response body.
 */
export type ProviderVerbSpec = {
  /** Tool NAME — passed verbatim to `triggerProviderAction.provider`. */
  tool: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path with `{{param}}` interpolation, e.g. "/calendar/v3/calendars/{{calendarId}}/events". */
  pathTemplate: string;
  /** Query params; values may be `{{param}}`; arrays → repeated query keys. */
  query?: Record<string, string | string[]>;
  body?: Record<string, unknown>;
  baseUrlOverride?: string;
  /** Static custom request headers (e.g. Cal.com's `cal-api-version`). Auth wins. */
  headers?: Record<string, string>;
  paramMapping?: Record<
    string,
    {
      required?: boolean;
      default?: unknown;
      clampMin?: number;
      clampMax?: number;
      encode?: "uri";
    }
  >;
  responseShape?: {
    /** Dot-path to the collection array in the response body. */
    collectionPath?: string;
    /** Output key for the mapped collection (default "results"). */
    collectionAs?: string;
    /** outField → dot-path within each collection element. */
    item?: Record<string, string>;
    /** outField → dot-path on the root body (value may be `{{param}}` or `@count`). */
    scalar?: Record<string, string>;
    /** outField → header-name (case-insensitive) — extracts Gmail `payload.headers:[{name,value}]`. */
    headers?: Record<string, string>;
  };
  expand?: {
    /** Dot-path (in the shaped list result) to the array of items to expand. */
    forEachIdFrom: string;
    /** Per-id detail call (its own responseShape merged into each list item). */
    detail: Omit<ProviderVerbSpec, "tool" | "expand">;
    /** Bounded parallelism for the detail fan-out (default 5). */
    concurrency?: number;
    merge: "detail-into-list-item";
  };
};
/**
 * pod       — visible to all users on the data pod (default)
 * user      — visible only to the owning user
 * workspace — visible to all members of the workspace
 */
export type SkillScope = "pod" | "user" | "workspace";

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // ── Ownership ────────────────────────────────────────────────────────

    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    // ── Identity (from agent_skills merge) ───────────────────────────────

    /** Human-readable unique identifier (e.g. "gsap-react", "synap-ui"). Nullable for legacy rows. */
    slug: text("slug"),

    // ── Classification ───────────────────────────────────────────────────

    /**
     * instruction — text appended to the agent system prompt
     * code        — JS/TS function executed in the IS sandbox (Tier-2)
     * declarative — in-process provider-verb spec (providerSpec) (Tier-1)
     * builtin     — first-party op run in-process via a governed handler (Tier-0)
     */
    kind: text("kind", {
      enum: ["instruction", "code", "declarative", "builtin"],
    })
      .notNull()
      .default("code")
      .$type<SkillKind>(),

    /**
     * pod       — visible to all users on the data pod (default)
     * user      — visible only to the owning user
     * workspace — visible to all members of the workspace
     */
    scope: text("scope", { enum: ["pod", "user", "workspace"] })
      .notNull()
      .default("pod")
      .$type<SkillScope>(),

    /**
     * Which agent types this skill applies to.
     * NULL = applies to all agents.
     * e.g. ["assistant", "research"]
     */
    agentTypes: jsonb("agent_types").$type<string[] | null>(),

    // ── Definition ───────────────────────────────────────────────────────

    name: text("name").notNull(),
    description: text("description"),

    /**
     * For kind='instruction': the skill body (Markdown), stored for agent
     * injection. Absorbed from agent_skills.body.
     */
    body: text("body"),

    /**
     * Canonical MinIO document for the skill body (versioned, collaborative).
     * `body` above is a denormalized CACHE of this document's content, populated
     * on skill save for fast per-turn IS prompt injection. When the body changes,
     * the linked document gets a new immutable version in `document_versions`.
     */
    bodyDocumentId: uuid("body_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),

    /**
     * Document IDs linked to this skill (e.g. reference files like
     * reference/02-scoring-framework.md). The skill owns the relationship —
     * documents are generic substrate that don't know who references them.
     */
    documentIds: text("document_ids").array().default([]),

    /**
     * For kind='code': the JavaScript/TypeScript function body.
     * Nullable — doc-style skills (kind='instruction') have no code.
     */
    code: text("code"),

    /**
     * For kind='declarative': the provider-verb spec the pod executes IN-PROCESS
     * via `triggerProviderAction` (Tier-1, no IS isolate). Nullable — only
     * `declarative` skills populate it.
     */
    providerSpec: jsonb("provider_spec").$type<ProviderVerbSpec | null>(),

    /** Parameter schema (code skills only) — describes callable arguments */
    parameters: jsonb("parameters"),

    category: text("category"), // e.g. 'action', 'context', 'crm', 'research'

    // ── Discoverability (from agent_skills merge) ─────────────────────────

    /** Searchable keywords — "animation", "react", "timeline", etc. */
    topics: text("topics").array().default([]),

    // ── Provenance (from agent_skills merge) ──────────────────────────────

    /** Source origin (e.g. "file://~/.claude/skills/gsap-react"). */
    source: text("source"),
    /** Original skill author or package name. */
    author: text("author"),
    /** Semver string. */
    version: text("version"),
    /** Free-form tags. */
    tags: text("tags").array().default([]),

    /**
     * Tool/verb NAMES this instruction skill teaches (e.g. 'create_document',
     * 'entity.create', 'synap_create_document') — the tool↔skill linkage for
     * the AI teaching substrate. Bidirectionally queryable via `= ANY()`.
     * See idx_skills_teaches_tools (GIN).
     */
    teachesTools: text("teaches_tools").array().notNull().default([]),

    /**
     * Progressive-disclosure group for the teaching substrate. Free text (no
     * enum), mirroring the IS SkillGroup: core|research|build|connect|govern|
     * feed|inbox|show.
     */
    skillGroup: text("skill_group"),

    /**
     * Core-DNA skill injected into every agent turn (not gated by
     * discover_tools/load_skill). `description` doubles as the L1 catalog
     * summary line for this skill.
     */
    alwaysOn: boolean("always_on").notNull().default(false),

    // ── Execution (code skills only) ─────────────────────────────────────

    executionMode: text("execution_mode", {
      enum: ["sync", "async"],
    })
      .notNull()
      .default("sync"),

    timeoutSeconds: integer("timeout_seconds").default(30),

    // ── Status ───────────────────────────────────────────────────────────

    status: text("status", {
      enum: ["active", "inactive", "error"],
    })
      .notNull()
      .default("active"),

    /**
     * Per-capability approval gate (orthogonal to `status` = lifecycle/health).
     * A skill is born NOT approved (DEFAULT false): a freshly-created or
     * AI-created `code` skill cannot execute and is not loaded as an agent tool
     * until an owner approves it. `instruction` skills (prompt-only, no side
     * effects) are seeded approved by the create path. Existing rows are
     * grandfathered to true by migration 0143. Mirrors `mcp_servers.approved`.
     */
    approved: boolean("approved").notNull().default(false),

    errorMessage: text("error_message"),

    // ── Metadata ─────────────────────────────────────────────────────────

    /**
     * Free-form metadata:
     * { executionCount, lastTestedAt, installedFromUrl, skillType (legacy) }
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // ── Timestamps ───────────────────────────────────────────────────────

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    slugIdx: uniqueIndex("idx_skills_slug").on(table.slug),
    userIdIdx: index("skills_user_id_idx").on(table.userId),
    workspaceIdIdx: index("skills_workspace_id_idx").on(table.workspaceId),
    statusIdx: index("skills_status_idx").on(table.status),
    approvedIdx: index("idx_skills_approved").on(table.approved),
    kindIdx: index("skills_kind_idx").on(table.kind),
    nameIdx: index("skills_name_idx").on(table.name),
    topicsIdx: index("idx_skills_topics").on(table.topics),
    teachesToolsIdx: index("idx_skills_teaches_tools").on(table.teachesTools),
  })
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

export const insertSkillSchema = createInsertSchema(skills);
export const selectSkillSchema = createSelectSchema(skills);
