#!/usr/bin/env tsx
/**
 * Table Generator Script
 *
 * Generates boilerplate code for a new database table:
 * - Schema definition
 * - Repository
 * - Executor
 * - Router (optional)
 * - Index exports
 * - ValidationPolicy defaults
 *
 * Usage:
 *   pnpm generate:table --name knowledge_facts
 *   pnpm generate:table --name enrichments --skip-router
 */

import { program } from "commander";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

program
  .name("generate-table")
  .description("Generate boilerplate for a new database table")
  .requiredOption("-n, --name <name>", "Table name (e.g., knowledge_facts)")
  .option("-s, --skip-router", "Skip router generation")
  .option(
    "-d, --dry-run",
    "Show what would be generated without creating files"
  )
  .parse();

const options = program.opts();

// Utility functions
function toPascalCase(str: string): string {
  return str
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toKebabCase(str: string): string {
  return str.replace(/_/g, "-");
}

// Template generators
function generateSchemaTemplate(tableName: string, pascalCase: string): string {
  return `/**
 * ${pascalCase} Schema
 *
 * TODO: Add description of what this table stores
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const ${tableName} = pgTable(
  "${tableName}",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // TODO: Add your columns here
    name: text("name").notNull(),
    description: text("description"),
    
    // Metadata
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    // Multi-tenant
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id"),
    projectId: text("project_id"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Indexes
    userIdIdx: index("${tableName}_user_id_idx").on(table.userId),
    workspaceIdIdx: index("${tableName}_workspace_id_idx").on(table.workspaceId),
  }),
);

export type ${pascalCase} = typeof ${tableName}.$inferSelect;
export type New${pascalCase} = typeof ${tableName}.$inferInsert;
`;
}

function generateRepositoryTemplate(
  tableName: string,
  pascalCase: string
): string {
  return `/**
 * ${pascalCase} Repository
 * 
 * Manages ${tableName} CRUD operations.
 * Standalone implementation with event emission.
 */

import { eq, and, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ${tableName}, type ${pascalCase} } from "../schema/${toKebabCase(tableName)}.js";
import { EventRepository } from "./event-repository.js";

export interface Create${pascalCase}Data {
  id?: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId?: string;
  projectId?: string;
}

export interface Update${pascalCase}Data {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export class ${pascalCase}Repository {
  private eventRepo: EventRepository;

  constructor(private db: NodePgDatabase<any>) {
    this.eventRepo = new EventRepository(db as any);
  }

  /**
   * Create ${tableName.replace(/_/g, " ")}
   */
  async create(data: Create${pascalCase}Data, userId: string): Promise<${pascalCase}> {
    const { randomUUID } = await import("crypto");
    const id = data.id || randomUUID();

    const [item] = await this.db
      .insert(${tableName})
      .values({
        id,
        name: data.name,
        description: data.description,
        metadata: data.metadata,
        userId: data.userId,
        workspaceId: data.workspaceId,
        projectId: data.projectId,
      })
      .returning();

    await this.emitCompleted("create", id, userId);
    return item;
  }

  /**
   * Update ${tableName.replace(/_/g, " ")}
   */
  async update(id: string, data: Update${pascalCase}Data, userId: string): Promise<${pascalCase}> {
    const [item] = await this.db
      .update(${tableName})
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(${tableName}.id, id))
      .returning();

    if (!item) {
      throw new Error(\`${pascalCase} \${id} not found\`);
    }

    await this.emitCompleted("update", id, userId);
    return item;
  }

  /**
   * Delete ${tableName.replace(/_/g, " ")}
   */
  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .delete(${tableName})
      .where(eq(${tableName}.id, id));

    await this.emitCompleted("delete", id, userId);
  }

  /**
   * Get by ID
   */
  async getById(id: string): Promise<${pascalCase} | null> {
    const [item] = await this.db
      .select()
      .from(${tableName})
      .where(eq(${tableName}.id, id))
      .limit(1);
    return item || null;
  }

  /**
   * List by user
   */
  async listByUser(userId: string, workspaceId?: string): Promise<${pascalCase}[]> {
    const conditions = [eq(${tableName}.userId, userId)];
    
    if (workspaceId) {
      conditions.push(eq(${tableName}.workspaceId, workspaceId));
    }

    return await this.db
      .select()
      .from(${tableName})
      .where(and(...conditions))
      .orderBy(desc(${tableName}.createdAt));
  }

  /**
   * Emit completed event
   */
  private async emitCompleted(
    action: "create" | "update" | "delete",
    id: string,
    userId: string
  ): Promise<void> {
    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: \`${tableName}.\${action}.completed\`,
      subjectId: id,
      subjectType: "${tableName.replace(/_/g, "_")}",
      data: { id },
      userId,
      source: "api",
      timestamp: new Date(),
      metadata: {},
    });
  }
}
`;
}

function generateExecutorTemplate(
  tableName: string,
  pascalCase: string
): string {
  return `/**
 * ${pascalCase} Executor
 * 
 * Handles validated ${tableName} events.
 */

import { inngest } from "../client.js";
import { ${pascalCase}Repository } from "@synap/database";
import { getDb } from "@synap/database";

export const ${toCamelCase(tableName)}Executor = inngest.createFunction(
  {
    id: "${toKebabCase(tableName)}-executor",
    name: "${pascalCase} Executor",
    retries: 3,
  },
  [
    { event: "${tableName}.create.validated" },
    { event: "${tableName}.update.validated" },
    { event: "${tableName}.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-${toKebabCase(tableName)}-operation", async () => {
      const db = await getDb();
      const repo = new ${pascalCase}Repository(db as any);

      if (eventType === "${tableName}.create.validated") {
        const item = await repo.create({
          id: data.id,
          name: data.name,
          description: data.description,
          metadata: data.metadata,
          userId: data.userId,
          workspaceId: data.workspaceId,
          projectId: data.projectId,
        }, data.userId);

        return {
          status: "completed",
          id: item.id,
          message: "${pascalCase} created successfully",
        };
      }

      if (eventType === "${tableName}.update.validated") {
        const item = await repo.update(data.id, {
          name: data.name,
          description: data.description,
          metadata: data.metadata,
        }, data.userId);

        return {
          status: "completed",
          id: item.id,
          message: "${pascalCase} updated successfully",
        };
      }

      if (eventType === "${tableName}.delete.validated") {
        await repo.delete(data.id, data.userId);

        return {
          status: "completed",
          id: data.id,
          message: "${pascalCase} deleted successfully",
        };
      }

      throw new Error(\`Unknown event type: \${eventType}\`);
    });
  }
);
`;
}

function generateRouterTemplate(
  tableName: string,
  pascalCase: string,
  camelCase: string
): string {
  return `/**
 * ${pascalCase} Router
 * 
 * tRPC router for ${tableName} operations.
 */

import { router, protectedProcedure } from "../trpc.js";
import { z } from "zod";
import { ${pascalCase}Repository } from "@synap/database";
import { getDb } from "@synap/database";

// Zod schemas
const create${pascalCase}Schema = z.object({
  name: z.string(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
});

const update${pascalCase}Schema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ${camelCase}Router = router({
  /**
   * Create ${tableName.replace(/_/g, " ")}
   */
  create: protectedProcedure
    .input(create${pascalCase}Schema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new ${pascalCase}Repository(db as any);
      
      return await repo.create({
        ...input,
        userId: ctx.user.id,
      }, ctx.user.id);
    }),

  /**
   * Get by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new ${pascalCase}Repository(db as any);
      
      const item = await repo.getById(input.id);
      if (!item) {
        throw new Error("${pascalCase} not found");
      }
      
      return item;
    }),

  /**
   * List by user
   */
  list: protectedProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new ${pascalCase}Repository(db as any);
      
      return await repo.listByUser(ctx.user.id, input?.workspaceId);
    }),

  /**
   * Update ${tableName.replace(/_/g, " ")}
   */
  update: protectedProcedure
    .input(update${pascalCase}Schema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new ${pascalCase}Repository(db as any);
      
      const { id, ...data } = input;
      return await repo.update(id, data, ctx.user.id);
    }),

  /**
   * Delete ${tableName.replace(/_/g, " ")}
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new ${pascalCase}Repository(db as any);
      
      await repo.delete(input.id, ctx.user.id);
      return { success: true };
    }),
});
`;
}

// File generation functions
async function generateFiles(
  tableName: string,
  skipRouter: boolean,
  dryRun: boolean
) {
  const pascalCase = toPascalCase(tableName);
  const camelCase = toCamelCase(tableName);
  const kebabCase = toKebabCase(tableName);

  const files = [
    {
      path: `packages/database/src/schema/${kebabCase}.ts`,
      content: generateSchemaTemplate(tableName, pascalCase),
    },
    {
      path: `packages/database/src/repositories/${kebabCase}-repository.ts`,
      content: generateRepositoryTemplate(tableName, pascalCase),
    },
    {
      path: `packages/jobs/src/executors/${kebabCase}-executor.ts`,
      content: generateExecutorTemplate(tableName, pascalCase),
    },
  ];

  if (!skipRouter) {
    files.push({
      path: `packages/api/src/routers/${kebabCase}.ts`,
      content: generateRouterTemplate(tableName, pascalCase, camelCase),
    });
  }

  if (dryRun) {
    console.log("\n📋 Dry run - would generate the following files:\n");
    for (const file of files) {
      console.log(`  ✓ ${file.path}`);
    }
    console.log("\n📄 Preview of schema file:\n");
    console.log(files[0].content);
    return;
  }

  // Create files
  const rootDir = path.join(__dirname, "..");

  for (const file of files) {
    const fullPath = path.join(rootDir, file.path);
    const dir = path.dirname(fullPath);

    // Create directory if it doesn't exist
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, file.content, "utf-8");
    console.log(`✓ Created ${file.path}`);
  }

  // Update index exports
  await updateIndexExports(
    tableName,
    pascalCase,
    camelCase,
    kebabCase,
    rootDir
  );

  console.log(`\n✅ Generated boilerplate for ${tableName}\n`);
  console.log("Next steps:");
  console.log(`1. Edit packages/database/src/schema/${kebabCase}.ts`);
  console.log(
    `2. Edit packages/database/src/repositories/${kebabCase}-repository.ts`
  );
  console.log(`3. Add ValidationPolicy defaults for ${tableName}`);
  console.log(`4. Run: pnpm build`);
  console.log(`5. Test the new endpoints\n`);
}

async function updateIndexExports(
  tableName: string,
  pascalCase: string,
  camelCase: string,
  kebabCase: string,
  rootDir: string
) {
  // Update database/src/schema/index.ts
  const schemaIndexPath = path.join(
    rootDir,
    "packages/database/src/schema/index.ts"
  );
  const schemaIndex = await fs.readFile(schemaIndexPath, "utf-8");
  if (!schemaIndex.includes(`${kebabCase}.js`)) {
    const newExport = `export * from "./${kebabCase}.js";\n`;
    await fs.appendFile(schemaIndexPath, newExport);
    console.log(`✓ Updated packages/database/src/schema/index.ts`);
  }

  // Update database/src/repositories/index.ts
  const repoIndexPath = path.join(
    rootDir,
    "packages/database/src/repositories/index.ts"
  );
  const repoIndex = await fs.readFile(repoIndexPath, "utf-8");
  if (!repoIndex.includes(`${kebabCase}-repository.js`)) {
    const newExport = `export * from "./${kebabCase}-repository.js";\n`;
    await fs.appendFile(repoIndexPath, newExport);
    console.log(`✓ Updated packages/database/src/repositories/index.ts`);
  }

  // Update jobs/src/executors/index.ts
  const executorIndexPath = path.join(
    rootDir,
    "packages/jobs/src/executors/index.ts"
  );
  const executorIndex = await fs.readFile(executorIndexPath, "utf-8");
  if (!executorIndex.includes(`${kebabCase}-executor.js`)) {
    const newExport = `export * from "./${kebabCase}-executor.js";\n`;
    await fs.appendFile(executorIndexPath, newExport);
    console.log(`✓ Updated packages/jobs/src/executors/index.ts`);
  }
}

// Main execution
const tableName = options.name;
const skipRouter = options.skipRouter || false;
const dryRun = options.dryRun || false;

console.log(`\n🚀 Generating table: ${tableName}\n`);

generateFiles(tableName, skipRouter, dryRun).catch((error) => {
  console.error("❌ Error:", error.message);
  process.exit(1);
});
