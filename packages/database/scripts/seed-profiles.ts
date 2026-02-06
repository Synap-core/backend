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
    ];

    const createdProfiles = new Map<string, string>();

    for (const profile of profiles) {
      const existing = await profileRepo.getBySlug(profile.slug);
      if (existing) {
        console.log(`  ✓ Profile '${profile.slug}' already exists`);
        createdProfiles.set(profile.slug, existing.id);
      } else {
        const created = await profileRepo.create({
          ...profile,
          scope: ProfileScope.SYSTEM,
        });
        console.log(`  ✓ Created profile '${profile.slug}'`);
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
