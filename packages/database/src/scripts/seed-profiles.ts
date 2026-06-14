/**
 * Seed System Profiles and Property Definitions
 *
 * Creates initial system profiles (note, task, project, etc.) and their property definitions.
 * This script is idempotent — safe to run multiple times.
 *
 * Run automatically on pod startup after migrations and hub-key seeding.
 */

import { db, sql } from "../client-pg.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { PropertyValueType } from "../schema/property-defs.js";
import { ProfileScope } from "../schema/profiles.js";

async function seedProfiles() {
  console.log("🌱 Seeding system profiles and property definitions...\n");

  const propertyDefRepo = new PropertyDefRepository(db);
  const profileRepo = new ProfileRepository(db);
  const profilePropertyRepo = new ProfilePropertyRepository(db);

  try {
    // 1. Create system property definitions
    console.log("📝 Creating property definitions...");

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
        constraints: { enum: ["todo", "in-progress", "done", "cancelled"] },
        uiHints: { label: "Status", inputType: "select" },
      },
      {
        slug: "priority",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["low", "medium", "high", "urgent"] },
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
        slug: "attendees",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Attendees", inputType: "tags" },
      },
      {
        slug: "calendarLink",
        valueType: PropertyValueType.STRING,
        constraints: { format: "url", maxLength: 2000 },
        uiHints: { label: "Calendar Link", inputType: "url" },
      },
      {
        slug: "isAllDay",
        valueType: PropertyValueType.BOOLEAN,
        constraints: {},
        uiHints: { label: "All Day", inputType: "checkbox" },
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
        slug: "content",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 100000 },
        uiHints: {
          label: "Content",
          inputType: "markdown",
          placeholder: "Write your note...",
        },
      },
      {
        slug: "email",
        valueType: PropertyValueType.STRING,
        constraints: { format: "email", maxLength: 255 },
        uiHints: {
          label: "Email",
          inputType: "email",
          placeholder: "name@example.com",
        },
      },
      {
        slug: "phone",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 50 },
        uiHints: {
          label: "Phone",
          inputType: "tel",
          placeholder: "+1 (555) 000-0000",
        },
      },
      {
        slug: "company",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 200 },
        uiHints: { label: "Company", inputType: "text" },
      },
      {
        slug: "role",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 100 },
        uiHints: {
          label: "Role",
          inputType: "text",
          placeholder: "e.g., CEO, Developer",
        },
      },
      {
        slug: "website",
        valueType: PropertyValueType.STRING,
        constraints: { format: "url", maxLength: 500 },
        uiHints: {
          label: "Website",
          inputType: "url",
          placeholder: "https://example.com",
        },
      },
      {
        slug: "industry",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 100 },
        uiHints: {
          label: "Industry",
          inputType: "text",
          placeholder: "e.g., Technology, Healthcare",
        },
      },
      {
        slug: "size",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"],
        },
        uiHints: { label: "Company Size", inputType: "select" },
      },
      {
        slug: "stage",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
        },
        uiHints: { label: "Deal Stage", inputType: "select" },
      },
      {
        slug: "value",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Deal Value", inputType: "number", prefix: "$" },
      },
      {
        slug: "closeDate",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Expected Close Date", inputType: "date" },
      },
      {
        slug: "owner",
        valueType: PropertyValueType.ENTITY_ID,
        constraints: {},
        uiHints: { label: "Owner", inputType: "entity-select" },
      },
      {
        slug: "url",
        valueType: PropertyValueType.STRING,
        constraints: { format: "url", maxLength: 2000 },
        uiHints: { label: "URL", inputType: "url", placeholder: "https://..." },
      },
      {
        slug: "domain",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 255 },
        uiHints: { label: "Domain", inputType: "text", readonly: true },
      },
      {
        slug: "source",
        valueType: PropertyValueType.STRING,
        constraints: {
          enum: ["browser", "extension", "manual", "import", "api"],
        },
        uiHints: { label: "Capture Source", inputType: "select" },
      },
      {
        slug: "capturedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Captured At", inputType: "datetime-local" },
      },
      {
        slug: "favicon",
        valueType: PropertyValueType.STRING,
        constraints: { format: "url", maxLength: 500 },
        uiHints: { label: "Favicon", inputType: "url" },
      },
      {
        slug: "description",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 1000 },
        uiHints: {
          label: "Description",
          inputType: "textarea",
          placeholder: "Page description...",
        },
      },
      {
        slug: "author",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 200 },
        uiHints: { label: "Author", inputType: "text" },
      },
      {
        slug: "publishedAt",
        valueType: PropertyValueType.DATE,
        constraints: {},
        uiHints: { label: "Published Date", inputType: "date" },
      },
      {
        slug: "readTime",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Read Time", inputType: "number", suffix: "min" },
      },
      {
        slug: "channelId",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 255 },
        uiHints: { label: "Channel ID", inputType: "text", readonly: true },
      },
      {
        slug: "messageId",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 255 },
        uiHints: { label: "Message ID", inputType: "text", readonly: true },
      },
      {
        slug: "messageRole",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["user", "assistant", "system"] },
        uiHints: { label: "Message Role", inputType: "select", readonly: true },
      },
      {
        slug: "threadTitle",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 500 },
        uiHints: { label: "Thread Title", inputType: "text", readonly: true },
      },
      {
        slug: "fileName",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 500 },
        uiHints: { label: "File Name", inputType: "text", readonly: true },
      },
      {
        slug: "mimeType",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 255 },
        uiHints: { label: "MIME Type", inputType: "text", readonly: true },
      },
      {
        slug: "fileSize",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: {
          label: "File Size",
          inputType: "number",
          suffix: "bytes",
          readonly: true,
        },
      },
      {
        slug: "storageKey",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 2000 },
        uiHints: { label: "Storage Key", inputType: "text", readonly: true },
      },
      {
        slug: "width",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Width", inputType: "number", suffix: "px" },
      },
      {
        slug: "height",
        valueType: PropertyValueType.NUMBER,
        constraints: { min: 0 },
        uiHints: { label: "Height", inputType: "number", suffix: "px" },
      },
      {
        slug: "statement",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 2000 },
        uiHints: {
          label: "Statement",
          inputType: "textarea",
          placeholder: "The one outcome everything should advance toward...",
        },
      },
      {
        slug: "timeHorizon",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 100 },
        uiHints: {
          label: "Time Horizon",
          inputType: "text",
          placeholder: "e.g., Q3 2026, 12 months",
        },
      },
      {
        slug: "successCriteria",
        valueType: PropertyValueType.ARRAY,
        constraints: {},
        uiHints: { label: "Success Criteria", inputType: "tags" },
      },
      {
        slug: "northStarStatus",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["active", "achieved", "paused", "abandoned"] },
        uiHints: { label: "Status", inputType: "select" },
      },
      // `knowledge` profile properties (ek_*)
      {
        slug: "ek_type",
        valueType: PropertyValueType.STRING,
        constraints: { enum: ["gotcha", "lesson", "decision", "reference"] },
        uiHints: { label: "Type", inputType: "select", required: true },
      },
      {
        slug: "ek_claim",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 1000 },
        uiHints: {
          label: "Claim",
          inputType: "text",
          required: true,
          placeholder: "One-line assertion",
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
      // user_observation properties
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

    const createdPropertyDefs = new Map<string, string>();

    for (const propDef of propertyDefs) {
      const existing = await propertyDefRepo.getBySlug(
        propDef.slug,
        undefined,
        null
      );
      if (existing) {
        console.log(`  ✓ Property '${propDef.slug}' already exists`);
        createdPropertyDefs.set(propDef.slug, existing.id);
      } else {
        const created = await propertyDefRepo.create(propDef);
        console.log(`  ✓ Created property '${propDef.slug}'`);
        createdPropertyDefs.set(propDef.slug, created.id);
      }
    }

    // 2. Create system profiles
    console.log("\n📋 Creating system profiles...");

    const profiles = [
      {
        slug: "note",
        displayName: "Note",
        uiHints: { icon: "sticky-note", color: "#FEF3C7" },
      },
      {
        slug: "task",
        displayName: "Task",
        uiHints: { icon: "check-square", color: "#3B82F6" },
      },
      {
        slug: "project",
        displayName: "Project",
        uiHints: { icon: "folder", color: "#8B5CF6" },
      },
      {
        slug: "event",
        displayName: "Event",
        uiHints: { icon: "calendar", color: "#10B981" },
      },
      {
        slug: "person",
        displayName: "Person",
        uiHints: { icon: "user", color: "#F59E0B" },
      },
      {
        slug: "contact",
        displayName: "Contact",
        parentProfileSlug: "person",
        uiHints: { icon: "user-check", color: "#06B6D4" },
      },
      {
        slug: "company",
        displayName: "Company",
        uiHints: { icon: "building-2", color: "#6366F1" },
      },
      {
        slug: "deal",
        displayName: "Deal",
        uiHints: { icon: "trending-up", color: "#EC4899" },
      },
      {
        slug: "bookmark",
        displayName: "Bookmark",
        uiHints: { icon: "bookmark", color: "#F97316" },
      },
      {
        slug: "capture",
        displayName: "Capture",
        parentProfileSlug: "bookmark",
        uiHints: { icon: "camera", color: "#84CC16" },
      },
      {
        slug: "website",
        displayName: "Website",
        parentProfileSlug: "bookmark",
        uiHints: { icon: "globe", color: "#14B8A6" },
      },
      {
        slug: "article",
        displayName: "Article",
        parentProfileSlug: "bookmark",
        uiHints: { icon: "newspaper", color: "#A855F7" },
      },
      {
        slug: "file",
        displayName: "File",
        uiHints: { icon: "file", color: "#64748B" },
      },
      {
        slug: "anchor",
        displayName: "Anchor",
        uiHints: {
          icon: "pin",
          color: "#10B981",
          description: "Pinned conversation moment",
        },
      },
      {
        slug: "north_star",
        displayName: "North Star",
        uiHints: {
          icon: "compass",
          color: "#10B981",
          description: "The workspace's anchoring goal",
        },
      },
      // NOTE: `engineering_knowledge` was a backward-compat ALIAS of `knowledge`
      // (same ek_* shape, same scope, same displayName). It is removed from the
      // seed — capture now writes `knowledge` and migration
      // 0127_dedup_engineering_knowledge re-points any legacy entities. Do not
      // re-add it; it collides on the system-slug unique constraint.
      {
        slug: "knowledge",
        displayName: "Knowledge",
        entityScope: "workspace",
        uiHints: {
          icon: "brain",
          color: "#6366F1",
          description:
            "Validated knowledge: gotchas, lessons, decisions, references",
        },
      },
      {
        slug: "user_observation",
        displayName: "User Observation",
        entityScope: "pod",
        uiHints: {
          icon: "user-search",
          color: "#8B5CF6",
          description:
            "AI-inferred observations about the user: preferences, habits, working style",
        },
      },
      // NOTE: there is intentionally NO `skill` entity profile. A Skill is CONFIG
      // (AI know-how), not entity DATA — it lives in the `skills` / `agent_skills`
      // config tables and is wired into the graph via `links`, not `entities`.
      // The legacy `skill` entity profile is dead (0 entities); migration
      // 0128_dedup_skill_profile defensively deactivates any remnant row on
      // already-deployed pods. Do NOT add a `skill` profile object here — the
      // seed's existence check only finds ACTIVE profiles, so re-adding it would
      // resurrect the deactivated row.
    ];

    const createdProfiles = new Map<string, string>();

    for (const profile of profiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      if (existing) {
        console.log(`  ✓ Profile '${profile.slug}' already exists`);
        createdProfiles.set(profile.slug, existing.id);
      } else {
        let parentProfileId: string | undefined;
        const parentSlug = (profile as Record<string, unknown>)
          .parentProfileSlug as string | undefined;
        if (parentSlug) {
          parentProfileId = createdProfiles.get(parentSlug);
          if (!parentProfileId) {
            const parent = await profileRepo.getBySlug(parentSlug);
            if (parent) {
              parentProfileId = parent.id;
              createdProfiles.set(parentSlug, parent.id);
            } else {
              console.warn(
                `  ⚠ Parent profile '${parentSlug}' not found for '${profile.slug}'`
              );
            }
          }
        }

        const { parentProfileSlug: _ignored, ...profileData } =
          profile as Record<string, unknown>;
        const created = await profileRepo.create({
          ...profileData,
          parentProfileId,
          scope: ProfileScope.SYSTEM,
        } as Parameters<typeof profileRepo.create>[0]);
        console.log(
          `  ✓ Created profile '${profile.slug}'${parentProfileId ? ` (extends ${parentSlug})` : ""}`
        );
        createdProfiles.set(profile.slug, created.id);
      }
    }

    // 3. Link properties to profiles
    console.log("\n🔗 Linking properties to profiles...");

    async function linkProps(
      profileSlug: string,
      props: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: unknown;
      }>
    ) {
      const profileId = createdProfiles.get(profileSlug);
      if (!profileId) return;
      for (const prop of props) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (!propertyDefId) continue;
        await profilePropertyRepo.link({
          profileId,
          propertyDefId,
          required: prop.required,
          defaultValue: prop.defaultValue,
          displayOrder: prop.displayOrder,
        });
        console.log(`  ✓ Linked '${prop.slug}' to '${profileSlug}'`);
      }
    }

    await linkProps("task", [
      { slug: "title", required: true, displayOrder: 0 },
      {
        slug: "status",
        required: false,
        displayOrder: 1,
        defaultValue: "todo",
      },
      { slug: "priority", required: false, displayOrder: 2 },
      { slug: "dueDate", required: false, displayOrder: 3 },
      { slug: "assignee", required: false, displayOrder: 4 },
      { slug: "tags", required: false, displayOrder: 5 },
    ]);

    await linkProps("event", [
      { slug: "title", required: true, displayOrder: 0 },
      { slug: "startDate", required: false, displayOrder: 1 },
      { slug: "endDate", required: false, displayOrder: 2 },
      {
        slug: "isAllDay",
        required: false,
        displayOrder: 3,
        defaultValue: false,
      },
      { slug: "attendees", required: false, displayOrder: 5 },
      { slug: "calendarLink", required: false, displayOrder: 6 },
      { slug: "tags", required: false, displayOrder: 7 },
    ]);

    await linkProps("note", [
      { slug: "title", required: false, displayOrder: 0 },
      { slug: "content", required: true, displayOrder: 1 },
      { slug: "tags", required: false, displayOrder: 2 },
    ]);

    await linkProps("project", [
      { slug: "title", required: true, displayOrder: 0 },
      {
        slug: "status",
        required: false,
        displayOrder: 1,
        defaultValue: "planning",
      },
      { slug: "tags", required: false, displayOrder: 2 },
    ]);

    await linkProps("person", [
      { slug: "title", required: false, displayOrder: 0 },
      { slug: "email", required: false, displayOrder: 1 },
      { slug: "phone", required: false, displayOrder: 2 },
      { slug: "company", required: false, displayOrder: 3 },
      { slug: "tags", required: false, displayOrder: 4 },
    ]);

    await linkProps("contact", [
      { slug: "role", required: false, displayOrder: 5 },
    ]);

    await linkProps("company", [
      { slug: "title", required: true, displayOrder: 0 },
      { slug: "website", required: false, displayOrder: 1 },
      { slug: "industry", required: false, displayOrder: 2 },
      { slug: "size", required: false, displayOrder: 3 },
      { slug: "tags", required: false, displayOrder: 4 },
    ]);

    await linkProps("deal", [
      { slug: "title", required: true, displayOrder: 0 },
      { slug: "stage", required: false, displayOrder: 1, defaultValue: "lead" },
      { slug: "value", required: false, displayOrder: 2 },
      { slug: "closeDate", required: false, displayOrder: 3 },
      { slug: "owner", required: false, displayOrder: 4 },
      { slug: "tags", required: false, displayOrder: 5 },
    ]);

    await linkProps("bookmark", [
      { slug: "title", required: false, displayOrder: 0 },
      { slug: "url", required: true, displayOrder: 1 },
      { slug: "domain", required: false, displayOrder: 2 },
      { slug: "tags", required: false, displayOrder: 3 },
    ]);

    await linkProps("capture", [
      {
        slug: "source",
        required: false,
        displayOrder: 4,
        defaultValue: "browser",
      },
      { slug: "capturedAt", required: false, displayOrder: 5 },
      { slug: "content", required: false, displayOrder: 6 },
    ]);

    await linkProps("website", [
      { slug: "favicon", required: false, displayOrder: 4 },
      { slug: "description", required: false, displayOrder: 5 },
    ]);

    await linkProps("article", [
      { slug: "author", required: false, displayOrder: 4 },
      { slug: "publishedAt", required: false, displayOrder: 5 },
      { slug: "readTime", required: false, displayOrder: 6 },
      { slug: "content", required: false, displayOrder: 7 },
    ]);

    await linkProps("file", [
      { slug: "fileName", required: true, displayOrder: 0 },
      { slug: "mimeType", required: true, displayOrder: 1 },
      { slug: "fileSize", required: true, displayOrder: 2 },
      { slug: "storageKey", required: true, displayOrder: 3 },
      { slug: "width", required: false, displayOrder: 4 },
      { slug: "height", required: false, displayOrder: 5 },
    ]);

    await linkProps("anchor", [
      { slug: "title", required: false, displayOrder: 0 },
      { slug: "channelId", required: true, displayOrder: 1 },
      { slug: "messageId", required: true, displayOrder: 2 },
      { slug: "messageRole", required: false, displayOrder: 3 },
      { slug: "threadTitle", required: false, displayOrder: 4 },
      { slug: "content", required: false, displayOrder: 5 },
      { slug: "tags", required: false, displayOrder: 6 },
    ]);

    await linkProps("north_star", [
      { slug: "title", required: true, displayOrder: 0 },
      { slug: "statement", required: true, displayOrder: 1 },
      { slug: "timeHorizon", required: false, displayOrder: 2 },
      { slug: "successCriteria", required: false, displayOrder: 3 },
      {
        slug: "northStarStatus",
        required: false,
        displayOrder: 4,
        defaultValue: "active",
      },
    ]);

    const ekProps = [
      { slug: "ek_type", required: true, displayOrder: 0 },
      { slug: "ek_claim", required: true, displayOrder: 1 },
      { slug: "ek_why", required: false, displayOrder: 2 },
      { slug: "ek_evidence", required: false, displayOrder: 3 },
      { slug: "ek_tags", required: false, displayOrder: 4 },
    ];
    await linkProps("knowledge", ekProps);

    await linkProps("user_observation", [
      { slug: "uo_observation", required: true, displayOrder: 0 },
      { slug: "uo_category", required: true, displayOrder: 1 },
      { slug: "uo_confidence", required: false, displayOrder: 2 },
      { slug: "uo_validated", required: false, displayOrder: 3 },
    ]);

    console.log("\n✅ Seeding complete!\n");
  } catch (error) {
    console.error("❌ Error seeding profiles:", error);
    throw error;
  } finally {
    await sql.end();
  }
}

seedProfiles()
  .then(() => {
    console.log("✅ Seed script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Seed script failed:", error);
    process.exit(1);
  });
