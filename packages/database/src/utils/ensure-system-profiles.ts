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
        slug: "location",
        valueType: PropertyValueType.STRING,
        constraints: {},
        uiHints: { label: "Location", inputType: "text" },
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

    // 2. Create system profiles
    const profiles = [
      {
        slug: "note",
        displayName: "Note",
        uiHints: { icon: "file-text", color: "#6B7280" },
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
        slug: "company",
        displayName: "Company",
        uiHints: { icon: "building", color: "#6366F1" },
      },
    ];

    const createdProfiles = new Map<string, string>();

    for (const profile of profiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      if (existing) {
        createdProfiles.set(profile.slug, existing.id);
      } else {
        const created = await profileRepo.create({
          ...profile,
          scope: ProfileScope.SYSTEM,
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
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
        ],
      },
      {
        profileSlug: "event",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          { slug: "startTime", required: false, displayOrder: 1 },
          { slug: "endTime", required: false, displayOrder: 2 },
          { slug: "tags", required: false, displayOrder: 3 },
          { slug: "description", required: false, displayOrder: 4 },
        ],
      },
      {
        profileSlug: "note",
        propertySlugs: [
          { slug: "title", required: false, displayOrder: 0 },
          { slug: "tags", required: false, displayOrder: 1 },
          { slug: "description", required: false, displayOrder: 2 },
        ],
      },
      {
        profileSlug: "project",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 },
          {
            slug: "status",
            required: false,
            defaultValue: "active",
            displayOrder: 1,
          },
          { slug: "tags", required: false, displayOrder: 2 },
          { slug: "description", required: false, displayOrder: 3 },
        ],
      },
      {
        profileSlug: "person",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 }, // Name
          { slug: "email", required: false, displayOrder: 1 },
          { slug: "phone", required: false, displayOrder: 2 },
          { slug: "tags", required: false, displayOrder: 3 },
          { slug: "description", required: false, displayOrder: 4 },
        ],
      },
      {
        profileSlug: "company",
        propertySlugs: [
          { slug: "title", required: true, displayOrder: 0 }, // Company name
          { slug: "website", required: false, displayOrder: 1 },
          { slug: "industry", required: false, displayOrder: 2 },
          { slug: "employees", required: false, displayOrder: 3 },
          { slug: "location", required: false, displayOrder: 4 },
          { slug: "tags", required: false, displayOrder: 5 },
          { slug: "description", required: false, displayOrder: 6 },
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
