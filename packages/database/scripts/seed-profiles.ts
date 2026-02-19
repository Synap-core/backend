/**
 * Seed System Profiles and Property Definitions
 *
 * Creates initial system profiles (note, task, project, etc.) and their property definitions.
 * This script is idempotent - safe to run multiple times.
 */

import postgres from "postgres";
import { getDb } from "../dist/client-pg.js";
import {
  PropertyDefRepository,
  ProfileRepository,
  ProfilePropertyRepository,
  PropertyValueType,
  ProfileScope,
} from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

async function seedProfiles() {
  console.log("🌱 Seeding system profiles and property definitions...\n");

  const db = await getDb();
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
        slug: "content",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 100000 }, // 100KB limit for inline storage
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
        uiHints: {
          label: "Company",
          inputType: "text",
        },
      },
      // CRM properties
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
        uiHints: {
          label: "Deal Value",
          inputType: "number",
          prefix: "$",
        },
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
      // Capture/Bookmark properties
      {
        slug: "url",
        valueType: PropertyValueType.STRING,
        constraints: { format: "url", maxLength: 2000 },
        uiHints: {
          label: "URL",
          inputType: "url",
          placeholder: "https://...",
        },
      },
      {
        slug: "domain",
        valueType: PropertyValueType.STRING,
        constraints: { maxLength: 255 },
        uiHints: {
          label: "Domain",
          inputType: "text",
          readonly: true,
        },
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
        uiHints: {
          label: "Favicon",
          inputType: "url",
        },
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
        uiHints: {
          label: "Author",
          inputType: "text",
        },
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
        uiHints: {
          label: "Read Time",
          inputType: "number",
          suffix: "min",
        },
      },
    ];

    const createdPropertyDefs = new Map<string, string>();

    for (const propDef of propertyDefs) {
      const existing = await propertyDefRepo.getBySlug(propDef.slug);
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
        uiHints: { icon: "sticky-note", color: "#FEF3C7" }, // Yellow sticky note
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
      // CRM profiles
      {
        slug: "contact",
        displayName: "Contact",
        parentProfileSlug: "person", // Extends person
        uiHints: { icon: "user-check", color: "#06B6D4" }, // Cyan
      },
      {
        slug: "company",
        displayName: "Company",
        uiHints: { icon: "building-2", color: "#6366F1" }, // Indigo
      },
      {
        slug: "deal",
        displayName: "Deal",
        uiHints: { icon: "trending-up", color: "#EC4899" }, // Pink
      },
      // Capture profiles
      {
        slug: "bookmark",
        displayName: "Bookmark",
        uiHints: { icon: "bookmark", color: "#F97316" }, // Orange
      },
      {
        slug: "capture",
        displayName: "Capture",
        parentProfileSlug: "bookmark", // Extends bookmark
        uiHints: { icon: "camera", color: "#84CC16" }, // Lime
      },
      {
        slug: "website",
        displayName: "Website",
        parentProfileSlug: "bookmark", // Extends bookmark
        uiHints: { icon: "globe", color: "#14B8A6" }, // Teal
      },
      {
        slug: "article",
        displayName: "Article",
        parentProfileSlug: "bookmark", // Extends bookmark
        uiHints: { icon: "newspaper", color: "#A855F7" }, // Purple
      },
    ];

    const createdProfiles = new Map<string, string>();

    // First pass: create profiles without parents (or resolve parent IDs)
    for (const profile of profiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      if (existing) {
        console.log(`  ✓ Profile '${profile.slug}' already exists`);
        createdProfiles.set(profile.slug, existing.id);
      } else {
        // Resolve parent profile ID if specified
        let parentProfileId: string | undefined;
        if ((profile as any).parentProfileSlug) {
          const parentSlug = (profile as any).parentProfileSlug;
          parentProfileId = createdProfiles.get(parentSlug);
          if (!parentProfileId) {
            // Parent not yet created, try to fetch from DB
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

        const { parentProfileSlug: _ignored, ...profileData } = profile as any;
        const created = await profileRepo.create({
          ...profileData,
          parentProfileId,
          scope: ProfileScope.SYSTEM,
        });
        console.log(
          `  ✓ Created profile '${profile.slug}'${parentProfileId ? ` (extends ${(profile as any).parentProfileSlug})` : ""}`
        );
        createdProfiles.set(profile.slug, created.id);
      }
    }

    // 3. Link properties to profiles
    console.log("\n🔗 Linking properties to profiles...");

    // Task profile properties
    const taskProfileId = createdProfiles.get("task");
    if (taskProfileId) {
      const taskProperties = [
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
      ];

      for (const prop of taskProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: taskProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'task'`);
        }
      }
    }

    // Event profile properties
    const eventProfileId = createdProfiles.get("event");
    if (eventProfileId) {
      const eventProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: true, displayOrder: 0 },
        { slug: "startTime", required: false, displayOrder: 1 },
        { slug: "endTime", required: false, displayOrder: 2 },
        { slug: "tags", required: false, displayOrder: 3 },
      ];

      for (const prop of eventProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: eventProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'event'`);
        }
      }
    }

    // Note profile properties
    const noteProfileId = createdProfiles.get("note");
    if (noteProfileId) {
      const noteProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: false, displayOrder: 0 },
        { slug: "content", required: true, displayOrder: 1 },
        { slug: "tags", required: false, displayOrder: 2 },
      ];

      for (const prop of noteProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: noteProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'note'`);
        }
      }
    }

    // Project profile properties
    const projectProfileId = createdProfiles.get("project");
    if (projectProfileId) {
      const projectProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: true, displayOrder: 0 },
        {
          slug: "status",
          required: false,
          displayOrder: 1,
          defaultValue: "planning",
        },
        { slug: "tags", required: false, displayOrder: 2 },
      ];

      for (const prop of projectProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: projectProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'project'`);
        }
      }
    }

    // Person profile properties
    const personProfileId = createdProfiles.get("person");
    if (personProfileId) {
      const personProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: false, displayOrder: 0 }, // Full name
        { slug: "email", required: false, displayOrder: 1 },
        { slug: "phone", required: false, displayOrder: 2 },
        { slug: "company", required: false, displayOrder: 3 },
        { slug: "tags", required: false, displayOrder: 4 },
      ];

      for (const prop of personProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: personProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'person'`);
        }
      }
    }

    // Contact profile properties (extends person - adds role)
    const contactProfileId = createdProfiles.get("contact");
    if (contactProfileId) {
      const contactProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "role", required: false, displayOrder: 5 }, // After inherited person fields
      ];

      for (const prop of contactProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: contactProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'contact'`);
        }
      }
    }

    // Company profile properties
    const companyProfileId = createdProfiles.get("company");
    if (companyProfileId) {
      const companyProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: true, displayOrder: 0 }, // Company name
        { slug: "website", required: false, displayOrder: 1 },
        { slug: "industry", required: false, displayOrder: 2 },
        { slug: "size", required: false, displayOrder: 3 },
        { slug: "tags", required: false, displayOrder: 4 },
      ];

      for (const prop of companyProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: companyProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'company'`);
        }
      }
    }

    // Deal profile properties
    const dealProfileId = createdProfiles.get("deal");
    if (dealProfileId) {
      const dealProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: true, displayOrder: 0 }, // Deal name
        {
          slug: "stage",
          required: false,
          displayOrder: 1,
          defaultValue: "lead",
        },
        { slug: "value", required: false, displayOrder: 2 },
        { slug: "closeDate", required: false, displayOrder: 3 },
        { slug: "owner", required: false, displayOrder: 4 },
        { slug: "tags", required: false, displayOrder: 5 },
      ];

      for (const prop of dealProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: dealProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'deal'`);
        }
      }
    }

    // Bookmark profile properties (base for captures)
    const bookmarkProfileId = createdProfiles.get("bookmark");
    if (bookmarkProfileId) {
      const bookmarkProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "title", required: false, displayOrder: 0 },
        { slug: "url", required: true, displayOrder: 1 },
        { slug: "domain", required: false, displayOrder: 2 },
        { slug: "tags", required: false, displayOrder: 3 },
      ];

      for (const prop of bookmarkProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: bookmarkProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'bookmark'`);
        }
      }
    }

    // Capture profile properties (extends bookmark)
    const captureProfileId = createdProfiles.get("capture");
    if (captureProfileId) {
      const captureProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        {
          slug: "source",
          required: false,
          displayOrder: 4,
          defaultValue: "browser",
        },
        { slug: "capturedAt", required: false, displayOrder: 5 },
        { slug: "content", required: false, displayOrder: 6 }, // Captured content/selection
      ];

      for (const prop of captureProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: captureProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'capture'`);
        }
      }
    }

    // Website profile properties (extends bookmark)
    const websiteProfileId = createdProfiles.get("website");
    if (websiteProfileId) {
      const websiteProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "favicon", required: false, displayOrder: 4 },
        { slug: "description", required: false, displayOrder: 5 },
      ];

      for (const prop of websiteProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: websiteProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'website'`);
        }
      }
    }

    // Article profile properties (extends bookmark)
    const articleProfileId = createdProfiles.get("article");
    if (articleProfileId) {
      const articleProperties: Array<{
        slug: string;
        required: boolean;
        displayOrder: number;
        defaultValue?: any;
      }> = [
        { slug: "author", required: false, displayOrder: 4 },
        { slug: "publishedAt", required: false, displayOrder: 5 },
        { slug: "readTime", required: false, displayOrder: 6 },
        { slug: "content", required: false, displayOrder: 7 }, // Article body
      ];

      for (const prop of articleProperties) {
        const propertyDefId = createdPropertyDefs.get(prop.slug);
        if (propertyDefId) {
          await profilePropertyRepo.link({
            profileId: articleProfileId,
            propertyDefId,
            required: prop.required,
            defaultValue: prop.defaultValue,
            displayOrder: prop.displayOrder,
          });
          console.log(`  ✓ Linked '${prop.slug}' to 'article'`);
        }
      }
    }

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
