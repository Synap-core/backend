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
        constraints: {},
        uiHints: { label: "Email", inputType: "email" },
      },
      {
        slug: "phone",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Phone", inputType: "phone" },
      },
    ];

    const createdPropertyDefs = new Map<string, string>();

    for (const propDef of propertyDefs) {
      const existing = await propertyDefRepo.getBySlug(propDef.slug);
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
    ];

    for (const propDef of capturePropertyDefs) {
      const existing = await propertyDefRepo.getBySlug(propDef.slug);
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
      {
        slug: "project",
        displayName: "Project",
        uiHints: {
          icon: "folder",
          color: "#8B5CF6",
          description: "Group of related work",
        },
      },
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
      // File
      {
        slug: "file",
        displayName: "File",
        uiHints: {
          icon: "file",
          color: "#64748B",
          description: "Uploaded file",
          hideFromCreate: true, // created programmatically via file upload, not manually
        },
      },
      // Quick capture — raw URL/text captured via browser extension or mobile
      {
        slug: "capture",
        displayName: "Capture",
        uiHints: {
          icon: "camera",
          color: "#84CC16",
          description: "Quick capture from browser or mobile",
          hideFromCreate: true, // created programmatically via browser/mobile capture
        },
        parentSlug: "bookmark",
      },
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
    ];

    const createdProfiles = new Map<string, string>();

    // First pass: create all profiles without parent links
    for (const profile of profiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      if (existing) {
        createdProfiles.set(profile.slug, existing.id);
      } else {
        const created = await profileRepo.create({
          slug: profile.slug,
          displayName: profile.displayName,
          uiHints: profile.uiHints,
          scope: ProfileScope.SYSTEM,
        });
        createdProfiles.set(profile.slug, created.id);
        profilesCreated++;
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
    const HIDE_FROM_CREATE_SLUGS = ["file", "capture", "anchor"];
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
      {
        profileSlug: "project",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "status",
            required: false,
            defaultValue: "todo",
            displayOrder: 1,
          },
          { slug: "tags", required: false, displayOrder: 2 },
          { slug: "description", required: false, displayOrder: 3 },
        ],
      },
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
          { slug: "tags", required: false, displayOrder: 3 },
          { slug: "description", required: false, displayOrder: 4 },
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
      // File
      {
        profileSlug: "file",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "fileName", required: false, displayOrder: 1 },
          { slug: "mimeType", required: false, displayOrder: 2 },
          { slug: "fileSize", required: false, displayOrder: 3 },
          { slug: "tags", required: false, displayOrder: 4 },
        ],
      },
      // Capture — raw capture from browser/mobile (inherits bookmark hierarchy)
      {
        profileSlug: "capture",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "url", required: false, displayOrder: 1 },
          { slug: "domain", required: false, displayOrder: 2 },
          { slug: "source", required: false, displayOrder: 3 },
          { slug: "content", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
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
