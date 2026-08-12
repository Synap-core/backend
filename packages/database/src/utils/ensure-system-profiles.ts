/**
 * Ensure System Profiles Utility
 *
 * Idempotent function to ensure system profiles and property definitions exist.
 * Can be called from migrations, workspace creation, or manually.
 *
 * Safe to run multiple times - checks for existing data before creating.
 */

import { getDb } from "../client-pg.js";
import {
  PropertyDefRepository,
  ProfileRepository,
  ProfilePropertyRepository,
  PropertyValueType,
  ProfileScope,
} from "../index.js";

export interface EnsureSystemProfilesResult {
  status: "created" | "exists" | "error";
  message: string;
  profilesCreated: number;
  propertiesCreated: number;
  linksCreated: number;
  error?: string;
}

/**
 * Canonical slug set of every profile this seeder creates on every pod.
 *
 * SINGLE SOURCE OF TRUTH for pod-side referential validation: the template
 * cross-reference checks in `create-workspace-from-definition.ts`
 * (`collectCrossRefErrors` + the preflight resolver) treat these as
 * always-present, so a template may reference `company`/`person`/`task`/… in a
 * view scope, suggested entity, or entityLink WITHOUT re-declaring them — exactly
 * what the PUBLISH-time `SYSTEM_PROFILES` allow-list in
 * `@synap-core/workspace-templates` already permits. Without this the two doors
 * disagree: such templates PUBLISH but fail to APPLY (422).
 *
 * This MUST stay in lockstep with the `profiles` array built inside
 * `ensureSystemProfiles()` below. That function runs a coherence guard on every
 * pod startup and returns an error result if the two diverge — so adding a
 * profile to the seeder without listing it here fails loudly at boot instead of
 * silently re-breaking template apply.
 */
export const SYSTEM_PROFILE_SLUGS: ReadonlySet<string> = new Set([
  // Core capture hierarchy
  "note",
  "task",
  "event",
  "bookmark",
  "website",
  "article",
  // People / orgs / CRM
  "person",
  "contact",
  "company",
  "deal",
  // Files + programmatic kinds
  "file",
  "anchor",
  "signal_item",
  // Knowledge-work flow
  "decision",
  "question",
  "research",
  "knowledge",
  "report",
  "user_observation",
]);

/**
 * Ensure system profiles and property definitions exist
 *
 * @returns Result with status and counts
 */
export async function ensureSystemProfiles(): Promise<EnsureSystemProfilesResult> {
  const db = await getDb();
  const propertyDefRepo = new PropertyDefRepository(db);
  const profileRepo = new ProfileRepository(db);
  const profilePropertyRepo = new ProfilePropertyRepository(db);

  let profilesCreated = 0;
  let propertiesCreated = 0;
  let linksCreated = 0;

  try {
    // 1. Create system property definitions
    const propertyDefs = [
      {
        slug: "title",
        valueType: PropertyValueType.STRING,
        constraints: { minLength: 1, maxLength: 500 },
        uiHints: { label: "Title", inputType: "text", required: true },
      },
      {
        slug: "status",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["todo", "in-progress", "done", "cancelled"],
        },
        uiHints: { label: "Status", inputType: "select" },
      },
      {
        slug: "priority",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["low", "medium", "high", "urgent"],
        },
        uiHints: { label: "Priority", inputType: "select" },
      },
      {
        slug: "dueDate",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Due Date", inputType: "date" },
      },
      {
        slug: "startTime",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Start Time", inputType: "datetime-local" },
      },
      {
        slug: "endTime",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "End Time", inputType: "datetime-local" },
      },
      {
        slug: "assignee",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Assignee", inputType: "entity-select" },
      },
      {
        slug: "tags",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Tags", inputType: "tags" },
      },
      {
        slug: "description",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Description", inputType: "textarea" },
      },
      {
        slug: "website",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Website", inputType: "url" },
      },
      {
        slug: "industry",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Industry", inputType: "text" },
      },
      {
        slug: "employees",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Employees", inputType: "number" },
      },
      {
        slug: "startDate",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Start Date", inputType: "datetime-local" },
      },
      {
        slug: "endDate",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "End Date", inputType: "datetime-local" },
      },
      {
        slug: "location",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Location", inputType: "text" },
      },
      {
        slug: "attendees",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Attendees", inputType: "tags" },
      },
      {
        slug: "calendarLink",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Calendar Link", inputType: "url" },
      },
      {
        slug: "isAllDay",
        valueType: PropertyValueType.BOOLEAN,
        constraints: {},
        uiHints: { label: "All Day", inputType: "checkbox" },
      },
      {
        slug: "email",
        valueType: PropertyValueType.STRING,
        constraints: { format: "email" },
        uiHints: { label: "Email", inputType: "email" },
      },
      {
        slug: "phone",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Phone", inputType: "phone" },
      },
      // Identity fields — searchable handles used to dedup people pod-wide
      // (see entity-resolution + capture dedup). Base defs so a lookup by
      // handle/alias resolves to the existing person across all workspaces.
      {
        slug: "discord-handle",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Discord", inputType: "text", helpText: "username" },
      },
      {
        slug: "aliases",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: {
          label: "Aliases",
          inputType: "tags",
          itemValueType: "string",
          helpText: "Other handles, nicknames, or former names",
        },
      },
    ];

    const createdPropertyDefs = new Map<string, string>();

    for (const propDef of propertyDefs) {
      // Seed creates "base" defs (workspace_id IS NULL). Match only base
      // rows so an overlay with the same slug in some workspace doesn't
      // make the seed skip creating the canonical global/base def.
      const existing = await propertyDefRepo.getBySlug(
        propDef.slug,
        undefined,
        null
      );
      if (existing) {
        createdPropertyDefs.set(propDef.slug, existing.id);
      } else {
        const created = await propertyDefRepo.create(propDef);
        createdPropertyDefs.set(propDef.slug, created.id);
        propertiesCreated++;
      }
    }

    // 2. Additional property definitions for capture hierarchy
    const capturePropertyDefs = [
      {
        slug: "url",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "URL", inputType: "url" },
      },
      {
        slug: "domain",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Domain", inputType: "text" },
      },
      {
        slug: "favicon",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Favicon", inputType: "url" },
      },
      {
        slug: "author",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Author", inputType: "text" },
      },
      {
        slug: "publishedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Published", inputType: "date" },
      },
      {
        slug: "readTime",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Read Time (min)", inputType: "number" },
      },
      {
        slug: "content",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 50000 },
        uiHints: { label: "Content", inputType: "textarea" },
      },
      {
        slug: "source",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Source", inputType: "text" },
      },
      {
        slug: "role",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Role", inputType: "text" },
      },
      {
        slug: "stage",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: [
            "lead",
            "qualified",
            "proposal",
            "negotiation",
            "closed-won",
            "closed-lost",
          ],
        },
        uiHints: { label: "Stage", inputType: "select" },
      },
      {
        slug: "value",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Value", inputType: "number" },
      },
      {
        slug: "closeDate",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Close Date", inputType: "date" },
      },
      {
        slug: "fileName",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "File Name", inputType: "text" },
      },
      {
        slug: "channelId",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Channel", inputType: "text" },
      },
      {
        slug: "messageId",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Message", inputType: "text" },
      },
      {
        slug: "messageRole",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["user", "assistant", "system"] },
        uiHints: { label: "Message Role", inputType: "text" },
      },
      {
        slug: "threadTitle",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Thread Title", inputType: "text" },
      },
      {
        slug: "mimeType",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "MIME Type", inputType: "text" },
      },
      {
        slug: "fileSize",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "File Size", inputType: "number" },
      },
      {
        slug: "projectId",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Project", inputType: "entity-select" },
      },
      {
        slug: "companyId",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Company", inputType: "entity-select" },
      },
      {
        slug: "contactId",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Contact", inputType: "entity-select" },
      },
      // Relay: extended person/contact properties
      {
        slug: "telegramHandle",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: {
          label: "Telegram",
          inputType: "text",
          helpText: "@username",
        },
      },
      {
        slug: "linkedinUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "LinkedIn", inputType: "url" },
      },
      {
        slug: "twitterHandle",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Twitter/X", inputType: "text" },
      },
      {
        slug: "farcasterFid",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Farcaster", inputType: "text" },
      },
      {
        slug: "walletAddresses",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Wallet Addresses", inputType: "tags" },
      },
      {
        slug: "sources",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: {
          label: "Sources",
          inputType: "tags",
          helpText: "Where this contact was imported from",
        },
      },
      {
        slug: "lastInteractionAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Last Interaction" },
      },
      {
        slug: "interactionCount",
        valueType: PropertyValueType.NUMBER,
        constraints: {},
        uiHints: { label: "Interactions", inputType: "number" },
      },
      {
        slug: "strengthScore",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0, max: 100 },
        uiHints: { label: "Relationship Strength" },
      },
      {
        slug: "aiSummary",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "AI Summary", inputType: "textarea" },
      },
      // Signal item properties
      {
        slug: "sourcePlatform",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: [
            "twitter",
            "reddit",
            "youtube",
            "github",
            "hackernews",
            "producthunt",
            "linkedin",
            "threads",
            "telegram",
            "rss",
          ],
        },
        uiHints: { label: "Platform", inputType: "select" },
      },
      {
        slug: "sourceRoute",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Source Route", inputType: "text" },
      },
      {
        slug: "authorUsername",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Author Username", inputType: "text" },
      },
      {
        slug: "authorDisplayName",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Author Name", inputType: "text" },
      },
      {
        slug: "authorUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Author Profile", inputType: "url" },
      },
      {
        slug: "fetchedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Fetched", inputType: "datetime-local" },
      },
      {
        slug: "topics",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Topics", inputType: "tags" },
      },
      {
        slug: "relevanceScore",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0, max: 1 },
        uiHints: { label: "Relevance", inputType: "number" },
      },
      {
        slug: "sentiment",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["positive", "neutral", "negative", "mixed"],
        },
        uiHints: { label: "Sentiment", inputType: "select" },
      },
      {
        slug: "importance",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0, max: 1 },
        uiHints: { label: "Importance", inputType: "number" },
      },
      {
        slug: "rawData",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Raw Data", inputType: "textarea" },
      },
      {
        slug: "capturedFromFeed",
        valueType: PropertyValueType.BOOLEAN,
        constraints: {},
        uiHints: { label: "Captured from Feed", inputType: "checkbox" },
      },
      {
        slug: "captureMethod",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["manual", "automation", "ai_suggestion"],
        },
        uiHints: { label: "Capture Method", inputType: "select" },
      },
      {
        slug: "autoLinkedEntities",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Linked Entities", inputType: "tags" },
      },
      // Question / research / decision work-flow properties.
      // Together these + project + task form the full "AI-assisted work" graph:
      //   question → research → decision → tasks, each linked to a project.
      {
        slug: "questionStatus",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["open", "exploring", "answered", "abandoned"],
        },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "askedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Asked at", inputType: "date" },
      },
      {
        slug: "answeredByDecisionId",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Answered by", inputType: "entity-select" },
      },
      {
        slug: "researchStatus",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["ongoing", "concluded", "abandoned"],
        },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "conclusion",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Conclusion", inputType: "richtext" },
      },
      {
        slug: "researchConfidence",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["low", "medium", "high"] },
        uiHints: { label: "Confidence", inputType: "select" },
      },
      {
        slug: "questionId",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Question", inputType: "entity-select" },
      },
      // Report properties — the header of a generated narrative. The body is
      // the linked document; nothing here duplicates it.
      {
        slug: "reportPeriod",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 120 },
        uiHints: {
          label: "Period",
          inputType: "text",
          helpText: "Timeframe this report covers (e.g. 2026-W30, July 2026)",
        },
      },
      {
        slug: "generatedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Generated at", inputType: "date" },
      },
      {
        slug: "reportStatus",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["generating", "ready", "failed"] },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "reportSources",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: {
          label: "Context used",
          inputType: "tags",
          helpText:
            "Entities, channels, and lenses this report was generated from",
        },
      },
      // Decision properties — structured architectural / product / business decisions
      {
        slug: "summary",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 500 },
        uiHints: { label: "Summary", inputType: "text" },
      },
      {
        slug: "rationale",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Rationale", inputType: "richtext" },
      },
      {
        slug: "alternatives",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: {
          label: "Alternatives considered",
          inputType: "richtext",
        },
      },
      {
        slug: "decisionStatus",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["proposed", "accepted", "superseded", "rejected"],
        },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "decidedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Decided at", inputType: "date" },
      },
      {
        slug: "supersededBy",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Superseded by", inputType: "entity-select" },
      },
      {
        slug: "viewCount",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Views", inputType: "number" },
      },
      {
        slug: "captureCount",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Captures", inputType: "number" },
      },
      {
        slug: "focusAreas",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Focus Areas", inputType: "tags" },
      },
      // `knowledge` profile properties. Knowledge remains a primary kind; its
      // form is an exactly-one discriminator, not an additive facet role.
      {
        slug: "knowledgeForm",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["insight", "caution"] },
        uiHints: {
          label: "Knowledge form",
          inputType: "select",
          required: true,
          helpText:
            "Insight is a reusable conclusion; caution is a failure mode or caveat.",
        },
      },
      // `ek_type` is retained for historic entities and import compatibility.
      // It is not the canonical classification for new Knowledge records.
      {
        slug: "ek_type",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["gotcha", "lesson", "decision", "reference"] },
        uiHints: {
          label: "Legacy classification",
          inputType: "select",
          helpText:
            "Retained for compatibility while historic records are reviewed.",
        },
      },
      {
        slug: "ek_claim",
        valueType: PropertyValueType.STRING,
        // Retained compact summary for legacy captures and Sheet/search use.
        // Long-form readable knowledge belongs in the linked document instead.
        constraints: { maxLength: 8000 },
        uiHints: {
          label: "Summary",
          inputType: "text",
          placeholder: "Optional one-line summary",
        },
      },
      {
        slug: "ek_why",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: {
          label: "Why",
          inputType: "textarea",
          placeholder: "Reasoning or context",
        },
      },
      {
        slug: "ek_evidence",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 2000 },
        uiHints: {
          label: "Evidence",
          inputType: "text",
          placeholder: "File path, URL, or code snippet",
        },
      },
      {
        slug: "ek_tags",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: {
          label: "Tags",
          inputType: "tags",
          placeholder: "e.g. repo:synap-backend, layer:migrations",
        },
      },
      // `user_observation` profile properties
      {
        slug: "uo_observation",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 1000 },
        uiHints: {
          label: "Observation",
          inputType: "textarea",
          required: true,
          placeholder: "What the AI observed about the user",
        },
      },
      {
        slug: "uo_category",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: [
            "working_style",
            "communication",
            "focus",
            "preferences",
            "habits",
            "technical",
          ],
        },
        uiHints: { label: "Category", inputType: "select", required: true },
      },
      {
        slug: "uo_confidence",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0, max: 1 },
        uiHints: {
          label: "Confidence",
          inputType: "number",
          placeholder: "0.0 – 1.0",
        },
      },
      {
        slug: "uo_validated",
        valueType: PropertyValueType.BOOLEAN,
        constraints: {},
        uiHints: { label: "User confirmed", inputType: "checkbox" },
      },
    ];

    for (const propDef of capturePropertyDefs) {
      // Seed creates "base" defs (workspace_id IS NULL). Match only base
      // rows so an overlay with the same slug in some workspace doesn't
      // make the seed skip creating the canonical global/base def.
      const existing = await propertyDefRepo.getBySlug(
        propDef.slug,
        undefined,
        null
      );
      if (existing) {
        createdPropertyDefs.set(propDef.slug, existing.id);
      } else {
        const created = await propertyDefRepo.create(propDef);
        createdPropertyDefs.set(propDef.slug, created.id);
        propertiesCreated++;
      }
    }

    // 3. Create system profiles (core + hierarchy)
    const profiles = [
      // Core
      {
        slug: "note",
        displayName: "Note",
        uiHints: {
          icon: "file-text",
          color: "#6B7280",
          description: "Freeform text capture",
        },
      },
      {
        slug: "task",
        displayName: "Task",
        uiHints: {
          icon: "check-square",
          color: "#3B82F6",
          description: "Actionable item with status tracking",
        },
      },
      // "project" profile removed — projects are now first-class table rows
      // (see schema/projects.ts). Migration 0151 handles the cutover.
      {
        slug: "event",
        displayName: "Event",
        uiHints: {
          icon: "calendar",
          color: "#10B981",
          description: "Calendar event",
        },
      },
      // Capture hierarchy: bookmark → website, article
      {
        slug: "bookmark",
        displayName: "Bookmark",
        uiHints: {
          icon: "bookmark",
          color: "#F97316",
          description: "Saved URL",
        },
      },
      {
        slug: "website",
        displayName: "Website",
        uiHints: {
          icon: "globe",
          color: "#0D9488",
          description: "Website with metadata",
        },
        parentSlug: "bookmark",
      },
      {
        slug: "article",
        displayName: "Article",
        uiHints: {
          icon: "newspaper",
          color: "#7C3AED",
          description: "Article or blog post",
        },
        parentSlug: "bookmark",
      },
      // People hierarchy: person → contact
      {
        slug: "person",
        displayName: "Person",
        uiHints: {
          icon: "user",
          color: "#F59E0B",
          description: "A human being",
        },
      },
      {
        slug: "contact",
        displayName: "Contact",
        uiHints: {
          icon: "user-check",
          color: "#06B6D4",
          description: "Business contact",
        },
        parentSlug: "person",
      },
      // Organization
      {
        slug: "company",
        displayName: "Company",
        uiHints: {
          icon: "building",
          color: "#6366F1",
          description: "Organization",
        },
      },
      // CRM
      {
        slug: "deal",
        displayName: "Deal",
        uiHints: {
          icon: "trending-up",
          color: "#EC4899",
          description: "Sales opportunity",
        },
      },
      // File — the canonical uploaded/attached file kind (pod-wide). Storage
      // pointers live on the `documents` row + `entities.documentId`, never in
      // entity properties. Created via upload, not manually.
      {
        slug: "file",
        displayName: "File",
        uiHints: {
          icon: "file",
          color: "#64748B",
          description: "Uploaded or referenced file",
          hideFromCreate: true, // created via upload, not manually
        },
      },
      // 'capture' profile removed — the AI capture pipeline is the only
      // capture path and it stores into `bookmark`, `article`, `note`, etc.
      // Existing `capture` entities in user pods are NOT auto-migrated; if
      // a future migration is needed, run a one-time backfill: `capture`
      // → `bookmark` (parent slug), copying `url`/`domain`/`source` props.
      // AI Anchor — pinned reference to a specific message in a conversation
      {
        slug: "anchor",
        displayName: "Anchor",
        uiHints: {
          icon: "pin",
          color: "#10B981",
          description: "Pinned conversation moment",
          hideFromCreate: true, // created programmatically when pinning messages
        },
      },
      // Signal Item — external content from signal feeds
      {
        slug: "signal_item",
        displayName: "Signal Item",
        uiHints: {
          icon: "signal",
          color: "#06B6D4",
          description:
            "External content captured from signal feeds (Twitter, Reddit, Hacker News, etc.)",
        },
        parentSlug: "bookmark",
      },
      // Decision — structured architectural / product / business decision.
      // First-class entity (not memory) so it shows up in project views,
      // can be superseded, and links to the project it affects.
      {
        slug: "decision",
        displayName: "Decision",
        uiHints: {
          icon: "git-branch",
          color: "#A855F7",
          description:
            "A recorded decision — architectural, product, or business. Captures rationale, alternatives, and lifecycle (proposed → accepted → superseded).",
        },
      },
      // Question — a substantive inquiry the user is working on figuring out.
      // The entry point of the AI work flow: question → research → decision → tasks.
      {
        slug: "question",
        displayName: "Question",
        uiHints: {
          icon: "help-circle",
          color: "#0EA5E9",
          description:
            "A substantive question the user is investigating (not casual chatter). The starting node of research → decision workflows.",
        },
      },
      // Research — an investigation artifact with sources + conclusion + confidence.
      // Distinct from a `note` because it has process: what was consulted, what was found, how confident.
      {
        slug: "research",
        displayName: "Research",
        uiHints: {
          icon: "microscope",
          color: "#14B8A6",
          description:
            "An investigation: sources consulted, findings, confidence, and conclusion. Answers a question; informs a decision.",
        },
      },
      // Knowledge — reusable insights and cautions, connected to decisions and
      // sources as separate graph entities when those relationships matter.
      {
        slug: "knowledge",
        displayName: "Knowledge",
        uiHints: {
          icon: "brain",
          color: "#6366F1",
          description:
            "Reusable insights and cautions, with evidence and related graph entities.",
        },
      },
      // Report — a generated, read-only narrative artifact over a lens.
      // The body lives in a linked document (markdown + directives); the
      // properties below are only what the header needs to make sense.
      // Workspace-scoped (NOT in POD_WIDE_SLUGS): a report is *about* the
      // workspace/project lens it was generated over, so surfacing every
      // workspace's reports in every lens would be noise, not reach.
      {
        slug: "report",
        displayName: "Report",
        uiHints: {
          icon: "file-text",
          color: "#F59E0B",
          description:
            "A generated narrative over a lens: what happened, what it means, what to do. Read-only — the body is an AI-assembled document, not an editable note.",
        },
      },
      // User Observation — AI-inferred observations about the user.
      {
        slug: "user_observation",
        displayName: "User Observation",
        uiHints: {
          icon: "user-search",
          color: "#8B5CF6",
          description:
            "AI-inferred observations about the user: preferences, habits, working style",
        },
      },
    ];

    // Coherence tripwire: SYSTEM_PROFILE_SLUGS is the SSOT consumed by template
    // referential validation; it MUST list exactly what this seeder creates.
    // Fail loudly here (caught below → status:"error") rather than let a template
    // that references a newly-seeded system profile silently fail to apply.
    const seededSlugs = new Set(profiles.map((p) => p.slug));
    const missingFromSsot = [...seededSlugs].filter(
      (s) => !SYSTEM_PROFILE_SLUGS.has(s)
    );
    const staleInSsot = [...SYSTEM_PROFILE_SLUGS].filter(
      (s) => !seededSlugs.has(s)
    );
    if (missingFromSsot.length > 0 || staleInSsot.length > 0) {
      throw new Error(
        `SYSTEM_PROFILE_SLUGS drift vs ensureSystemProfiles() seeder: ` +
          `seeded-but-unlisted=[${missingFromSsot.join(", ")}], ` +
          `listed-but-unseeded=[${staleInSsot.join(", ")}]`
      );
    }

    const createdProfiles = new Map<string, string>();

    // Pod-wide profiles: entities of these types are visible across all workspaces
    const POD_WIDE_SLUGS = new Set([
      "note",
      "task",
      // "project" removed — projects are now first-class table rows (0151)
      "event",
      "person",
      "contact",
      "company",
      "bookmark",
      "website",
      "article",
      "decision",
      "question",
      "research",
      "knowledge",
      "user_observation",
      "file",
    ]);

    // First pass: create all profiles without parent links
    for (const profile of profiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      const expectedScope = POD_WIDE_SLUGS.has(profile.slug)
        ? "pod"
        : "workspace";
      if (existing) {
        createdProfiles.set(profile.slug, existing.id);
        // Backfill entityScope on existing profiles (idempotent)
        if (existing.entityScope !== expectedScope) {
          await profileRepo.update(existing.id, { entityScope: expectedScope });
        }
        // Repair only the known system-owned Knowledge copy. A custom
        // description is user configuration, so leave it entirely untouched.
        if (profile.slug === "knowledge") {
          const existingHints = (existing.uiHints ?? {}) as Record<
            string,
            unknown
          >;
          if (
            existingHints.description ===
            "Validated knowledge: gotchas, lessons, decisions, references"
          ) {
            await profileRepo.update(existing.id, {
              uiHints: {
                ...existingHints,
                description:
                  "Reusable insights and cautions, with evidence and related graph entities.",
              },
            });
          }
        }
      } else {
        const created = await profileRepo.create({
          slug: profile.slug,
          displayName: profile.displayName,
          uiHints: profile.uiHints,
          scope: ProfileScope.SYSTEM,
          entityScope: expectedScope,
        });
        createdProfiles.set(profile.slug, created.id);
        profilesCreated++;
      }
    }

    // Reconcile the two system-owned *active* Knowledge fields without ever
    // rewriting a global definition another profile uses. A custom global slug
    // collision gets a Knowledge-scoped def instead; the external profile keeps
    // its own contract untouched. `ek_type` is deliberately excluded: it is
    // retained raw on historic entities, but no longer linked/editable.
    const knowledgeProfileId = createdProfiles.get("knowledge");
    const knowledgeContractDefs = capturePropertyDefs.filter((propDef) =>
      ["knowledgeForm", "ek_claim"].includes(propDef.slug)
    );
    if (!knowledgeProfileId) {
      throw new Error("System knowledge profile was not created or resolved");
    }
    for (const propDef of knowledgeContractDefs) {
      const resolved = await propertyDefRepo.getBySlug(
        propDef.slug,
        knowledgeProfileId,
        null
      );
      if (resolved?.profileId === knowledgeProfileId) {
        await propertyDefRepo.update(resolved.id, {
          valueType: propDef.valueType,
          constraints: propDef.constraints,
          uiHints: propDef.uiHints,
        });
        createdPropertyDefs.set(propDef.slug, resolved.id);
        continue;
      }

      const globalDefId = createdPropertyDefs.get(propDef.slug);
      if (!resolved || !globalDefId) {
        throw new Error(
          `System knowledge property '${propDef.slug}' could not be resolved`
        );
      }
      const externalLinks = (
        await profilePropertyRepo.getByProperty(globalDefId)
      ).filter((link) => link.profileId !== knowledgeProfileId);
      if (externalLinks.length > 0) {
        // A same-slug global field belongs to another profile. Do not hijack
        // it; shadow it with the correct profile-scoped definition instead.
        const scoped = await propertyDefRepo.create({
          ...propDef,
          profileId: knowledgeProfileId,
          workspaceId: null,
        });
        createdPropertyDefs.set(propDef.slug, scoped.id);
        propertiesCreated++;
        // A prior partial rollout may already have linked the global field to
        // Knowledge. Remove only that link; it remains intact for its owners.
        await profilePropertyRepo.unlink(knowledgeProfileId, globalDefId);
      } else {
        await propertyDefRepo.update(globalDefId, {
          valueType: propDef.valueType,
          constraints: propDef.constraints,
          uiHints: propDef.uiHints,
        });
      }
    }

    // Second pass: set parent profile relationships
    for (const profile of profiles) {
      const parentSlug = (profile as { parentSlug?: string }).parentSlug;
      if (!parentSlug) continue;
      const profileId = createdProfiles.get(profile.slug);
      const parentId = createdProfiles.get(parentSlug);
      if (profileId && parentId) {
        try {
          await profileRepo.update(profileId, { parentProfileId: parentId });
        } catch {
          // Ignore if already set
        }
      }
    }

    // Third pass: backfill hideFromCreate flag on system-only profiles (idempotent)
    const HIDE_FROM_CREATE_SLUGS = ["file", "anchor"];
    for (const slug of HIDE_FROM_CREATE_SLUGS) {
      const profileId = createdProfiles.get(slug);
      if (!profileId) continue;
      const existing = await profileRepo.getBySlug(slug);
      if (
        existing &&
        !(existing.uiHints as Record<string, unknown>)?.hideFromCreate
      ) {
        await profileRepo.update(profileId, {
          uiHints: {
            ...(existing.uiHints as Record<string, unknown>),
            hideFromCreate: true,
          },
        });
      }
    }

    // Fourth pass: bind per-profile RENDERERS (idempotent, never clobbers).
    //
    // WHY THIS EXISTS — the naming-convention fallback cannot fire.
    // `ProfileEntityDetailCell`'s `detailFallback` computes
    // `entity-detail-<profileSlug>` and the browser registry has such cells, but
    // that fallback is UNREACHABLE: `useSlotResolver` (profileSlotRenderer.tsx)
    // takes the backend's answer whenever it returns anything —
    //     const target = result?.[contentKind]; if (target) return target;
    // — and `getEffectiveRenderer`'s layer 3 is a HARDCODED system fallback that
    // always returns `{cellKey: "entity-detail"}` (see this file's sibling,
    // profile-resolution-service.ts). So the generic default always wins and no
    // profile can get a specific detail renderer by convention alone. Dogfooded
    // 2026-07-26: a `report` entity rendered through the generic entity card.
    //
    // The fix is to use the mechanism as designed rather than lean on a
    // convention: bind the renderer as DATA at layer 2 (`profiles.defaultRenderers`),
    // which outranks the layer-3 default. This is the north-star path — the
    // binding is configuration, not code.
    //
    // ONLY fills a key that is absent. A user who bound their own renderer via
    // the Renderer Studio is never overwritten; this seeds the default, it does
    // not own it.
    const PROFILE_DEFAULT_RENDERERS: Record<
      string,
      Record<string, { kind: "cell"; cellKey: string; props: object }>
    > = {
      report: {
        "entity-detail": {
          kind: "cell",
          cellKey: "entity-detail-report",
          props: {},
        },
      },
      knowledge: {
        "entity-detail": {
          kind: "cell",
          cellKey: "entity-detail-knowledge",
          props: {},
        },
      },
    };
    for (const [slug, renderers] of Object.entries(PROFILE_DEFAULT_RENDERERS)) {
      const profileId = createdProfiles.get(slug);
      if (!profileId) continue;
      const existing = await profileRepo.getBySlug(slug);
      if (!existing) continue;
      const current = (
        existing as { defaultRenderers?: Record<string, unknown> }
      ).defaultRenderers;
      const merged = { ...(current ?? {}) };
      let changed = false;
      for (const [contentKind, ref] of Object.entries(renderers)) {
        if (merged[contentKind] == null) {
          merged[contentKind] = ref;
          changed = true;
        }
      }
      if (changed) {
        await profileRepo.update(profileId, { defaultRenderers: merged });
      }
    }

    // 4. Link properties to profiles
    const profilePropertyLinks: Array<{
      profileSlug: string;
      propertySlugs: Array<{
        slug: string;
        required?: boolean;
        defaultValue?: unknown;
        displayOrder: number;
      }>;
    }> = [
      // Core
      {
        profileSlug: "note",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "content", required: false, displayOrder: 1 },
          { slug: "tags", required: false, displayOrder: 2 },
        ],
      },
      {
        profileSlug: "task",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "status",
            required: false,
            defaultValue: "todo",
            displayOrder: 1,
          },
          { slug: "priority", required: false, displayOrder: 2 },
          { slug: "dueDate", required: false, displayOrder: 3 },
          { slug: "assignee", required: false, displayOrder: 4 },
          { slug: "projectId", required: false, displayOrder: 5 },
          { slug: "tags", required: false, displayOrder: 6 },
          { slug: "description", required: false, displayOrder: 7 },
        ],
      },
      // "project" profile removed — projects are now first-class table rows
      // (see schema/projects.ts). Migration 0151 handles the cutover.
      {
        profileSlug: "event",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "startDate", required: false, displayOrder: 1 },
          { slug: "endDate", required: false, displayOrder: 2 },
          {
            slug: "isAllDay",
            required: false,
            defaultValue: false,
            displayOrder: 3,
          },
          { slug: "location", required: false, displayOrder: 4 },
          { slug: "attendees", required: false, displayOrder: 5 },
          { slug: "calendarLink", required: false, displayOrder: 6 },
          { slug: "tags", required: false, displayOrder: 7 },
          { slug: "description", required: false, displayOrder: 8 },
        ],
      },
      // Capture hierarchy
      {
        profileSlug: "bookmark",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "url", required: true, displayOrder: 1 },
          { slug: "domain", required: false, displayOrder: 2 },
          { slug: "source", required: false, displayOrder: 3 },
          { slug: "content", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
      {
        profileSlug: "website",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "url", required: true, displayOrder: 1 },
          { slug: "domain", required: false, displayOrder: 2 },
          { slug: "favicon", required: false, displayOrder: 3 },
          { slug: "description", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
        ],
      },
      {
        profileSlug: "article",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "url", required: true, displayOrder: 1 },
          { slug: "domain", required: false, displayOrder: 2 },
          { slug: "author", required: false, displayOrder: 3 },
          { slug: "publishedAt", required: false, displayOrder: 4 },
          { slug: "readTime", required: false, displayOrder: 5 },
          { slug: "content", required: false, displayOrder: 6 },
          { slug: "tags", required: false, displayOrder: 7 },
        ],
      },
      // People hierarchy
      {
        profileSlug: "person",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "email", required: false, displayOrder: 1 },
          { slug: "phone", required: false, displayOrder: 2 },
          { slug: "discord-handle", required: false, displayOrder: 16 },
          { slug: "aliases", required: false, displayOrder: 17 },
          { slug: "telegramHandle", required: false, displayOrder: 3 },
          { slug: "linkedinUrl", required: false, displayOrder: 4 },
          { slug: "twitterHandle", required: false, displayOrder: 5 },
          { slug: "farcasterFid", required: false, displayOrder: 6 },
          { slug: "walletAddresses", required: false, displayOrder: 7 },
          { slug: "sources", required: false, displayOrder: 8 },
          { slug: "lastInteractionAt", required: false, displayOrder: 9 },
          { slug: "interactionCount", required: false, displayOrder: 10 },
          { slug: "strengthScore", required: false, displayOrder: 11 },
          { slug: "aiSummary", required: false, displayOrder: 12 },
          { slug: "focusAreas", required: false, displayOrder: 13 },
          { slug: "tags", required: false, displayOrder: 14 },
          { slug: "description", required: false, displayOrder: 15 },
        ],
      },
      {
        profileSlug: "contact",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "email", required: false, displayOrder: 1 },
          { slug: "phone", required: false, displayOrder: 2 },
          { slug: "role", required: false, displayOrder: 3 },
          { slug: "companyId", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
      // Organization
      {
        profileSlug: "company",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "website", required: false, displayOrder: 1 },
          { slug: "industry", required: false, displayOrder: 2 },
          { slug: "employees", required: false, displayOrder: 3 },
          { slug: "location", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
      // CRM
      {
        profileSlug: "deal",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "stage",
            required: false,
            defaultValue: "lead",
            displayOrder: 1,
          },
          { slug: "value", required: false, displayOrder: 2 },
          { slug: "closeDate", required: false, displayOrder: 3 },
          { slug: "contactId", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
      // File — canonical. `title` replaces the legacy `fileName`; storage
      // pointers live on the documents row + entities.documentId, never as
      // properties.
      {
        profileSlug: "file",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "mimeType", required: false, displayOrder: 1 },
          { slug: "fileSize", required: false, displayOrder: 2 },
          { slug: "tags", required: false, displayOrder: 3 },
        ],
      },
      // 'capture' property assignment removed — the profile itself is gone.
      // The AI capture pipeline writes to `bookmark`/`article`/`note`/etc.
      // Anchor — pinned conversation moment
      {
        profileSlug: "anchor",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "channelId", required: true, displayOrder: 1 },
          { slug: "messageId", required: true, displayOrder: 2 },
          { slug: "messageRole", required: false, displayOrder: 3 },
          { slug: "threadTitle", required: false, displayOrder: 4 },
          { slug: "content", required: false, displayOrder: 5 },
          { slug: "tags", required: false, displayOrder: 6 },
        ],
      },
      // Signal Item — external content from signal feeds
      {
        profileSlug: "signal_item",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "url", required: true, displayOrder: 1 },
          { slug: "domain", required: false, displayOrder: 2 },
          { slug: "sourcePlatform", required: true, displayOrder: 3 },
          { slug: "sourceRoute", required: true, displayOrder: 4 },
          { slug: "authorUsername", required: false, displayOrder: 5 },
          { slug: "authorDisplayName", required: false, displayOrder: 6 },
          { slug: "authorUrl", required: false, displayOrder: 7 },
          { slug: "publishedAt", required: true, displayOrder: 8 },
          { slug: "fetchedAt", required: false, displayOrder: 9 },
          { slug: "aiSummary", required: false, displayOrder: 10 },
          {
            slug: "topics",
            required: true,
            defaultValue: [],
            displayOrder: 11,
          },
          {
            slug: "relevanceScore",
            required: false,
            defaultValue: 0.5,
            displayOrder: 12,
          },
          { slug: "sentiment", required: false, displayOrder: 13 },
          { slug: "importance", required: false, displayOrder: 14 },
          { slug: "rawData", required: false, displayOrder: 15 },
          {
            slug: "capturedFromFeed",
            required: false,
            defaultValue: false,
            displayOrder: 16,
          },
          { slug: "captureMethod", required: false, displayOrder: 17 },
          {
            slug: "autoLinkedEntities",
            required: false,
            defaultValue: [],
            displayOrder: 18,
          },
          {
            slug: "viewCount",
            required: false,
            defaultValue: 0,
            displayOrder: 19,
          },
          {
            slug: "captureCount",
            required: false,
            defaultValue: 0,
            displayOrder: 20,
          },
          { slug: "tags", required: false, displayOrder: 21 },
          { slug: "description", required: false, displayOrder: 22 },
        ],
      },
      // Decision — the full structured-decision record.
      {
        profileSlug: "decision",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "summary", required: false, displayOrder: 1 },
          {
            slug: "decisionStatus",
            required: false,
            defaultValue: "accepted",
            displayOrder: 2,
          },
          { slug: "decidedAt", required: false, displayOrder: 3 },
          { slug: "rationale", required: false, displayOrder: 4 },
          { slug: "alternatives", required: false, displayOrder: 5 },
          { slug: "projectId", required: false, displayOrder: 6 },
          { slug: "supersededBy", required: false, displayOrder: 7 },
          { slug: "tags", required: false, displayOrder: 8 },
          { slug: "description", required: false, displayOrder: 9 },
        ],
      },
      // Question — what the user is investigating.
      {
        profileSlug: "question",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "questionStatus",
            required: false,
            defaultValue: "open",
            displayOrder: 1,
          },
          { slug: "askedAt", required: false, displayOrder: 2 },
          { slug: "projectId", required: false, displayOrder: 3 },
          { slug: "answeredByDecisionId", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          // description = why this question matters, constraints
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
      // Research — investigation artifact with sources + findings + confidence.
      {
        profileSlug: "research",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "researchStatus",
            required: false,
            defaultValue: "ongoing",
            displayOrder: 1,
          },
          { slug: "questionId", required: false, displayOrder: 2 },
          { slug: "projectId", required: false, displayOrder: 3 },
          { slug: "conclusion", required: false, displayOrder: 4 },
          { slug: "researchConfidence", required: false, displayOrder: 5 },
          { slug: "tags", required: false, displayOrder: 6 },
          // description = method, scope, any context that doesn't fit conclusion
          { slug: "description", required: false, displayOrder: 7 },
        ],
      },
      // Report — the header of a generated narrative. Body = linked document.
      {
        profileSlug: "report",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "reportPeriod", required: false, displayOrder: 1 },
          { slug: "generatedAt", required: false, displayOrder: 2 },
          {
            slug: "reportStatus",
            required: false,
            defaultValue: "ready",
            displayOrder: 3,
          },
          { slug: "summary", required: false, displayOrder: 4 },
          { slug: "reportSources", required: false, displayOrder: 5 },
          { slug: "tags", required: false, displayOrder: 6 },
        ],
      },
      // Knowledge — one required canonical form plus optional compact metadata.
      // Historic entities receive a form only when their legacy payload is
      // explicitly normalised at a write/import/capture door; no JSONB backfill.
      {
        profileSlug: "knowledge",
        propertySlugs: [
          {
            slug: "knowledgeForm",
            required: true,
            displayOrder: 0,
          },
          { slug: "ek_claim", required: false, displayOrder: 1 },
          { slug: "ek_why", required: false, displayOrder: 2 },
          { slug: "ek_evidence", required: false, displayOrder: 3 },
          { slug: "ek_tags", required: false, displayOrder: 4 },
        ],
      },
      // User Observation — uo_* properties
      {
        profileSlug: "user_observation",
        propertySlugs: [
          { slug: "uo_observation", required: true, displayOrder: 0 },
          { slug: "uo_category", required: true, displayOrder: 1 },
          { slug: "uo_confidence", required: false, displayOrder: 2 },
          { slug: "uo_validated", required: false, displayOrder: 3 },
        ],
      },
    ];

    for (const link of profilePropertyLinks) {
      const profileId = createdProfiles.get(link.profileSlug);
      if (!profileId) continue;

      for (const prop of link.propertySlugs) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (!propertyDefId) continue;

        // Link is idempotent (onConflictDoUpdate), so safe to call always
        // Check if link exists first to count accurately
        const existingLinks = await profilePropertyRepo.getByProfile(profileId);
        const linkExists = existingLinks.some(
          (link) => link.propertyDefId === propertyDefId
        );

        await profilePropertyRepo.link({
          profileId,
          propertyDefId,
          required: prop.required || false,
          defaultValue: prop.defaultValue,
          displayOrder: prop.displayOrder,
        });

        if (!linkExists) {
          linksCreated++;
        }
      }
    }

    // Legacy ek_type survives in entity JSON for migration/renderer fallback,
    // but removing the profile link means it is not a second editable
    // classification. New writes normalise it into the sole knowledgeForm.
    const legacyKnowledgeTypeId = createdPropertyDefs.get("ek_type");
    if (legacyKnowledgeTypeId && knowledgeProfileId) {
      await profilePropertyRepo.unlink(
        knowledgeProfileId,
        legacyKnowledgeTypeId
      );
    }

    const totalCreated = profilesCreated + propertiesCreated + linksCreated;

    return {
      status: totalCreated > 0 ? "created" : "exists",
      message:
        totalCreated > 0
          ? `Created ${profilesCreated} profiles, ${propertiesCreated} properties, ${linksCreated} links`
          : "All system profiles already exist",
      profilesCreated,
      propertiesCreated,
      linksCreated,
    };
  } catch (error: any) {
    return {
      status: "error",
      message: "Failed to ensure system profiles",
      profilesCreated,
      propertiesCreated,
      linksCreated,
      error: error.message,
    };
  }
}

/**
 * Ensure DevPlane profiles and property definitions exist
 *
 * Idempotent — safe to call multiple times. Creates 6 DevPlane profiles
 * (devplane_app, devplane_feature, devplane_service, devplane_package,
 * devplane_environment, devplane_deployment) plus their property defs.
 * All profiles are workspace-scoped.
 */
export async function ensureDevplaneProfiles(): Promise<EnsureSystemProfilesResult> {
  const db = await getDb();
  const propertyDefRepo = new PropertyDefRepository(db);
  const profileRepo = new ProfileRepository(db);
  const profilePropertyRepo = new ProfilePropertyRepository(db);

  let profilesCreated = 0;
  let propertiesCreated = 0;
  let linksCreated = 0;

  try {
    // 1. Property definitions for all DevPlane profiles
    const devplanePropertyDefs = [
      // devplane_app
      {
        slug: "appName",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 200 },
        uiHints: { label: "App Name", inputType: "text" },
      },
      {
        slug: "repoUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Repository URL", inputType: "url" },
      },
      {
        slug: "techStack",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Tech Stack", inputType: "text" },
      },
      {
        slug: "port",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 1, max: 65535 },
        uiHints: { label: "Port", inputType: "number" },
      },
      {
        slug: "deployUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Deploy URL", inputType: "url" },
      },
      {
        slug: "appDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Description", inputType: "textarea" },
      },
      // devplane_feature
      {
        slug: "featureStatus",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["planned", "in-progress", "done", "error"] },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "featureDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Description", inputType: "textarea" },
      },
      {
        slug: "linkedAppSlugs",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Linked Apps", inputType: "text" },
      },
      {
        slug: "linkedPackageSlugs",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Linked Packages", inputType: "text" },
      },
      // devplane_service
      {
        slug: "serviceType",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Service Type", inputType: "text" },
      },
      {
        slug: "host",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Host", inputType: "text" },
      },
      {
        slug: "servicePort",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 1, max: 65535 },
        uiHints: { label: "Port", inputType: "number" },
      },
      {
        slug: "healthUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Health URL", inputType: "url" },
      },
      {
        slug: "repoLocalPath",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Repo Local Path", inputType: "text" },
      },
      // devplane_package
      {
        slug: "npmName",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "NPM Name", inputType: "text" },
      },
      {
        slug: "packageVersion",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Version", inputType: "text" },
      },
      {
        slug: "packageDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Description", inputType: "textarea" },
      },
      {
        slug: "usedByApps",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Used By Apps", inputType: "text" },
      },
      // devplane_environment
      {
        slug: "envName",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["dev", "staging", "prod"] },
        uiHints: { label: "Environment", inputType: "select" },
      },
      {
        slug: "envHost",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Host", inputType: "text" },
      },
      {
        slug: "sshUser",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "SSH User", inputType: "text" },
      },
      {
        slug: "sshKeyVaultRef",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "SSH Key (Vault Ref)", inputType: "text" },
      },
      {
        slug: "linkedAppSlug",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Linked App", inputType: "text" },
      },
      // devplane_deployment
      {
        slug: "deployStatus",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["pending", "running", "success", "failed"],
        },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "commitSha",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Commit SHA", inputType: "text" },
      },
      {
        slug: "deployedAppSlug",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Deployed App", inputType: "text" },
      },
      {
        slug: "deployedEnv",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Environment", inputType: "text" },
      },
      {
        slug: "logsUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Logs URL", inputType: "url" },
      },
      {
        slug: "webhookUrl",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Webhook URL", inputType: "url" },
      },
      // devplane_recipe
      {
        slug: "recipeSteps",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: {
          label: "Recipe Steps",
          inputType: "textarea",
          description:
            "JSON array of steps: [{name, command, continueOnError}]",
        },
      },
      {
        slug: "recipeName",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 200 },
        uiHints: { label: "Recipe Name", inputType: "text" },
      },
      {
        slug: "recipeDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Description", inputType: "textarea" },
      },
      {
        slug: "linkedEnvironmentId",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Linked Environment", inputType: "text" },
      },
      {
        slug: "onFailure",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["stop", "continue", "rollback"] },
        uiHints: { label: "On Failure", inputType: "select" },
      },
      {
        slug: "rollbackRecipeId",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Rollback Recipe", inputType: "text" },
      },
      {
        slug: "recipeTemplate",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["kamal", "docker-compose", "git-pull", "custom"],
        },
        uiHints: { label: "Template", inputType: "select" },
      },
      // devplane_recipe_run
      {
        slug: "recipeId",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Recipe", inputType: "text" },
      },
      {
        slug: "runStatus",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["running", "success", "failed", "cancelled"],
        },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "runSteps",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: {
          label: "Run Steps",
          inputType: "textarea",
          description:
            "JSON array: [{name, command, status, exitCode, output, startedAt, finishedAt}]",
        },
      },
      {
        slug: "runStartedAt",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Started At", inputType: "text" },
      },
      {
        slug: "runFinishedAt",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Finished At", inputType: "text" },
      },
      {
        slug: "runDuration",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Duration (ms)", inputType: "number" },
      },
      {
        slug: "triggeredBy",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["manual", "automation"] },
        uiHints: { label: "Triggered By", inputType: "select" },
      },
      // devplane_prompt_snippet
      {
        slug: "snippetTitle",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 200 },
        uiHints: { label: "Snippet Title", inputType: "text" },
      },
      {
        slug: "snippetBody",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 10000 },
        uiHints: {
          label: "Prompt Template",
          inputType: "textarea",
          description: "Use @{arg:NAME} for dynamic variables",
        },
      },
      {
        slug: "snippetCategory",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["deploy", "debug", "test", "audit", "review", "custom"],
        },
        uiHints: { label: "Category", inputType: "select" },
      },
      {
        slug: "snippetDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 500 },
        uiHints: { label: "Description", inputType: "text" },
      },
      // devplane_incident
      {
        slug: "severity",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["critical", "high", "medium", "low"] },
        uiHints: {
          label: "Severity",
          inputType: "select",
          displayAs: "status",
        },
      },
      {
        slug: "incidentStatus",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["open", "investigating", "resolved"] },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "affectedApps",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 1000 },
        uiHints: {
          label: "Affected Apps",
          inputType: "text",
          description: "Comma-separated list of app slugs",
        },
      },
      {
        slug: "rootCause",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 2000 },
        uiHints: { label: "Root Cause", inputType: "textarea" },
      },
      {
        slug: "resolvedAt",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Resolved At", inputType: "text" },
      },
      {
        slug: "incidentDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 5000 },
        uiHints: { label: "Description", inputType: "textarea" },
      },
      // devplane_cron
      {
        slug: "cronExpression",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 100 },
        uiHints: {
          label: "Cron Expression",
          inputType: "text",
          description: "e.g. 0 9 * * 1-5",
        },
      },
      {
        slug: "linkedAppSlug",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 200 },
        uiHints: { label: "Linked App", inputType: "text" },
      },
      {
        slug: "cronStatus",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["active", "paused", "error"] },
        uiHints: { label: "Status", inputType: "select", displayAs: "status" },
      },
      {
        slug: "lastRunAt",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Last Run At", inputType: "text" },
      },
      {
        slug: "lastRunStatus",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["success", "failed"] },
        uiHints: {
          label: "Last Run Status",
          inputType: "select",
          displayAs: "status",
        },
      },
      {
        slug: "nextRunAt",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Next Run At", inputType: "text" },
      },
      {
        slug: "cronDescription",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 1000 },
        uiHints: { label: "Description", inputType: "text" },
      },
    ];

    const createdPropertyDefs = new Map<string, string>();

    for (const propDef of devplanePropertyDefs) {
      // Match only base rows (workspace_id IS NULL) — same convention as seed
      const existing = await propertyDefRepo.getBySlug(
        propDef.slug,
        undefined,
        null
      );
      if (existing) {
        createdPropertyDefs.set(propDef.slug, existing.id);
      } else {
        const created = await propertyDefRepo.create(propDef);
        createdPropertyDefs.set(propDef.slug, created.id);
        propertiesCreated++;
      }
    }

    // 2. DevPlane profiles — all workspace-scoped
    const devplaneProfiles = [
      {
        slug: "devplane_app",
        displayName: "App",
        uiHints: {
          icon: "layout-dashboard",
          color: "#6366F1",
          description: "A software application in DevPlane",
        },
      },
      {
        slug: "devplane_feature",
        displayName: "Feature",
        uiHints: {
          icon: "git-branch",
          color: "#0EA5E9",
          description: "A feature or work item tracked in DevPlane",
        },
      },
      {
        slug: "devplane_service",
        displayName: "Service",
        uiHints: {
          icon: "server",
          color: "#10B981",
          description: "A backing service (database, queue, cache, etc.)",
        },
      },
      {
        slug: "devplane_package",
        displayName: "Package",
        uiHints: {
          icon: "package",
          color: "#F59E0B",
          description: "An npm / library package",
        },
      },
      {
        slug: "devplane_environment",
        displayName: "Environment",
        uiHints: {
          icon: "cloud",
          color: "#8B5CF6",
          description: "A deployment environment (dev / staging / prod)",
        },
      },
      {
        slug: "devplane_deployment",
        displayName: "Deployment",
        uiHints: {
          icon: "rocket",
          color: "#EC4899",
          description: "A deployment event for an app to an environment",
        },
      },
      {
        slug: "devplane_recipe",
        displayName: "Recipe",
        uiHints: {
          icon: "play-circle",
          color: "#8B5CF6",
          description:
            "An ordered list of shell commands to run on a remote server",
        },
      },
      {
        slug: "devplane_recipe_run",
        displayName: "Recipe Run",
        uiHints: {
          icon: "activity",
          color: "#0EA5E9",
          description:
            "A single execution of a recipe with per-step status tracking",
        },
      },
      {
        slug: "devplane_prompt_snippet",
        displayName: "Prompt Snippet",
        uiHints: {
          icon: "sparkles",
          color: "#F59E0B",
          description: "A reusable AI prompt template with dynamic variables",
        },
      },
      {
        slug: "devplane_incident",
        displayName: "Incident",
        uiHints: {
          icon: "alert-triangle",
          color: "#EF4444",
          description:
            "A production incident with severity, status, and root cause tracking",
        },
      },
      {
        slug: "devplane_cron",
        displayName: "Cron Job",
        uiHints: {
          icon: "timer",
          color: "#06B6D4",
          description: "A scheduled task with cron expression and run history",
        },
      },
    ];

    const createdProfiles = new Map<string, string>();

    for (const profile of devplaneProfiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      if (existing) {
        createdProfiles.set(profile.slug, existing.id);
      } else {
        const created = await profileRepo.create({
          slug: profile.slug,
          displayName: profile.displayName,
          uiHints: profile.uiHints,
          scope: ProfileScope.SYSTEM,
          entityScope: "workspace",
        });
        createdProfiles.set(profile.slug, created.id);
        profilesCreated++;
      }
    }

    // 3. Link properties to profiles
    const profilePropertyLinks: Array<{
      profileSlug: string;
      propertySlugs: Array<{
        slug: string;
        required?: boolean;
        defaultValue?: unknown;
        displayOrder: number;
      }>;
    }> = [
      {
        profileSlug: "devplane_app",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "appName", required: false, displayOrder: 1 },
          { slug: "repoUrl", required: false, displayOrder: 2 },
          { slug: "techStack", required: false, displayOrder: 3 },
          { slug: "port", required: false, displayOrder: 4 },
          { slug: "deployUrl", required: false, displayOrder: 5 },
          { slug: "appDescription", required: false, displayOrder: 6 },
        ],
      },
      {
        profileSlug: "devplane_feature",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "featureStatus",
            required: false,
            defaultValue: "planned",
            displayOrder: 1,
          },
          { slug: "priority", required: false, displayOrder: 2 },
          { slug: "featureDescription", required: false, displayOrder: 3 },
          { slug: "linkedAppSlugs", required: false, displayOrder: 4 },
          { slug: "linkedPackageSlugs", required: false, displayOrder: 5 },
        ],
      },
      {
        profileSlug: "devplane_service",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "serviceType", required: false, displayOrder: 1 },
          { slug: "host", required: false, displayOrder: 2 },
          { slug: "servicePort", required: false, displayOrder: 3 },
          { slug: "healthUrl", required: false, displayOrder: 4 },
        ],
      },
      {
        profileSlug: "devplane_package",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "npmName", required: false, displayOrder: 1 },
          { slug: "packageVersion", required: false, displayOrder: 2 },
          { slug: "packageDescription", required: false, displayOrder: 3 },
          { slug: "usedByApps", required: false, displayOrder: 4 },
        ],
      },
      {
        profileSlug: "devplane_environment",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "envName",
            required: false,
            defaultValue: "dev",
            displayOrder: 1,
          },
          { slug: "envHost", required: false, displayOrder: 2 },
          { slug: "sshUser", required: false, displayOrder: 3 },
          { slug: "sshKeyVaultRef", required: false, displayOrder: 4 },
          { slug: "linkedAppSlug", required: false, displayOrder: 5 },
        ],
      },
      {
        profileSlug: "devplane_deployment",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "deployStatus",
            required: false,
            defaultValue: "pending",
            displayOrder: 1,
          },
          { slug: "commitSha", required: false, displayOrder: 2 },
          { slug: "deployedAppSlug", required: false, displayOrder: 3 },
          { slug: "deployedEnv", required: false, displayOrder: 4 },
          { slug: "logsUrl", required: false, displayOrder: 5 },
          { slug: "webhookUrl", required: false, displayOrder: 6 },
        ],
      },
      {
        profileSlug: "devplane_recipe",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "recipeName", required: false, displayOrder: 1 },
          { slug: "recipeDescription", required: false, displayOrder: 2 },
          { slug: "recipeSteps", required: false, displayOrder: 3 },
          { slug: "linkedEnvironmentId", required: false, displayOrder: 4 },
          { slug: "linkedAppSlug", required: false, displayOrder: 5 },
          {
            slug: "onFailure",
            required: false,
            defaultValue: "stop",
            displayOrder: 6,
          },
          { slug: "rollbackRecipeId", required: false, displayOrder: 7 },
          { slug: "recipeTemplate", required: false, displayOrder: 8 },
        ],
      },
      {
        profileSlug: "devplane_recipe_run",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "recipeId", required: false, displayOrder: 1 },
          {
            slug: "runStatus",
            required: false,
            defaultValue: "running",
            displayOrder: 2,
          },
          { slug: "runSteps", required: false, displayOrder: 3 },
          { slug: "runStartedAt", required: false, displayOrder: 4 },
          { slug: "runFinishedAt", required: false, displayOrder: 5 },
          { slug: "runDuration", required: false, displayOrder: 6 },
          { slug: "triggeredBy", required: false, displayOrder: 7 },
        ],
      },
      {
        profileSlug: "devplane_prompt_snippet",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "snippetTitle", required: false, displayOrder: 1 },
          {
            slug: "snippetCategory",
            required: false,
            defaultValue: "custom",
            displayOrder: 2,
          },
          { slug: "snippetDescription", required: false, displayOrder: 3 },
          { slug: "snippetBody", required: true, displayOrder: 4 },
        ],
      },
      {
        profileSlug: "devplane_incident",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "severity", required: false, displayOrder: 1 },
          {
            slug: "incidentStatus",
            required: false,
            defaultValue: "open",
            displayOrder: 2,
          },
          { slug: "affectedApps", required: false, displayOrder: 3 },
          { slug: "rootCause", required: false, displayOrder: 4 },
          { slug: "resolvedAt", required: false, displayOrder: 5 },
          { slug: "incidentDescription", required: false, displayOrder: 6 },
        ],
      },
      {
        profileSlug: "devplane_cron",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "cronExpression", required: false, displayOrder: 1 },
          { slug: "linkedAppSlug", required: false, displayOrder: 2 },
          {
            slug: "cronStatus",
            required: false,
            defaultValue: "active",
            displayOrder: 3,
          },
          { slug: "lastRunAt", required: false, displayOrder: 4 },
          { slug: "lastRunStatus", required: false, displayOrder: 5 },
          { slug: "nextRunAt", required: false, displayOrder: 6 },
          { slug: "cronDescription", required: false, displayOrder: 7 },
        ],
      },
    ];

    // Resolve the shared "title" and "priority" property def IDs from the seed
    const sharedSlugs = ["title", "priority"];
    for (const slug of sharedSlugs) {
      const existing = await propertyDefRepo.getBySlug(slug, undefined, null);
      if (existing) {
        createdPropertyDefs.set(slug, existing.id);
      }
    }

    for (const link of profilePropertyLinks) {
      const profileId = createdProfiles.get(link.profileSlug);
      if (!profileId) continue;

      for (const prop of link.propertySlugs) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (!propertyDefId) continue;

        const existingLinks = await profilePropertyRepo.getByProfile(profileId);
        const linkExists = existingLinks.some(
          (l) => l.propertyDefId === propertyDefId
        );

        await profilePropertyRepo.link({
          profileId,
          propertyDefId,
          required: prop.required ?? false,
          defaultValue: prop.defaultValue,
          displayOrder: prop.displayOrder,
        });

        if (!linkExists) {
          linksCreated++;
        }
      }
    }

    const totalCreated = profilesCreated + propertiesCreated + linksCreated;

    return {
      status: totalCreated > 0 ? "created" : "exists",
      message:
        totalCreated > 0
          ? `DevPlane: created ${profilesCreated} profiles, ${propertiesCreated} properties, ${linksCreated} links`
          : "All DevPlane profiles already exist",
      profilesCreated,
      propertiesCreated,
      linksCreated,
    };
  } catch (error: any) {
    return {
      status: "error",
      message: "Failed to ensure DevPlane profiles",
      profilesCreated,
      propertiesCreated,
      linksCreated,
      error: error.message,
    };
  }
}

/**
 * Ensure the `team-member` ROLE profile exists (profileKind='role',
 * applicableKinds=['person']).
 *
 * The team roster → person bridge (`ensureTeamPersonForMember`,
 * `team-person-bridge.ts`) always tries to attach this facet when a human
 * joins a workspace, but every kind/role profile in this pod is otherwise
 * either seeded above (kinds, pod-wide) or created ad hoc by a user/AI via
 * the governed `profiles.create` door (roles like `client`/`partner`/
 * `investor` — there is no code-level seed for those). `team-member` is
 * different: it is load-bearing substrate the bridge depends on existing on
 * EVERY pod, not a workspace's own CRM vocabulary, so — unlike the other
 * roles — it gets a system seed here, mirroring `ensureSystemProfiles()`'s
 * idempotent existence-guarded pattern (profileRepo.getBySlug then create).
 *
 * SYSTEM scope (not per-workspace) so `ProfileRepository.getBySlugForWorkspace`
 * resolves it for every workspace without a per-workspace row. `entityScope`
 * resolves to `'workspace'` automatically for `profileKind: 'role'`
 * (`resolveEntityScope` — role profiles cannot be pod-wide).
 *
 * Idempotent: safe to call on every boot.
 */
export async function ensureTeamMemberRoleProfile(): Promise<EnsureSystemProfilesResult> {
  const db = await getDb();
  const profileRepo = new ProfileRepository(db);

  let profilesCreated = 0;

  try {
    const existing = await profileRepo.getBySlug("team-member");
    if (!existing) {
      await profileRepo.create({
        slug: "team-member",
        displayName: "Team Member",
        profileKind: "role",
        applicableKinds: ["person"],
        scope: ProfileScope.SYSTEM,
        uiHints: {
          icon: "users",
          color: "#22C55E",
          description: "Human member of a workspace's team.",
        },
      });
      profilesCreated = 1;
    }

    return {
      status: profilesCreated > 0 ? "created" : "exists",
      message:
        profilesCreated > 0
          ? "Created team-member role profile"
          : "team-member role profile already exists",
      profilesCreated,
      propertiesCreated: 0,
      linksCreated: 0,
    };
  } catch (error: any) {
    return {
      status: "error",
      message: "Failed to ensure team-member role profile",
      profilesCreated,
      propertiesCreated: 0,
      linksCreated: 0,
      error: error.message,
    };
  }
}
