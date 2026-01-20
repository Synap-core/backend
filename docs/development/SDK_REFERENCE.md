# SDK Backend - Référence Complète

**Version :** 1.0 | **Date :** 2025-01-20

Ce document décrit l'API publique de chaque package du backend Synap, formant le SDK backend utilisable par les développeurs de capacités.

---

## 📦 Packages du SDK

### 1. `@synap/core` - Configuration & Utilitaires

**Exports principaux :**

```typescript
// Configuration
export { config } from "./config.js";
export type { SynapConfig } from "./config.js";

// Logging
export { createLogger } from "./logger.js";
export type { Logger } from "./logger.js";

// Errors
export {
  SynapError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
} from "./errors.js";

// Tracing
export { initializeTracing } from "./tracing.js";

// Metrics
export { recordMetric, incrementCounter } from "./metrics.js";
```

**Utilisation :**

```typescript
import { config, createLogger, ValidationError } from "@synap/core";

// Configuration
const dbUrl = config.database.url;
const aiModel = config.ai.anthropic.model;

// Logging
const logger = createLogger({ module: "my-handler" });
logger.info({ userId }, "Processing request");

// Errors
throw new ValidationError("Invalid input", { field: "email" });
```

---

### 2. `@synap/types` - Types Partagés

**Exports principaux :**

```typescript
// Event Types
export { EventTypes } from "./event-types.js";
export type { EventType } from "./event-types.js";

// SynapEvent
export {
  createSynapEvent,
  parseSynapEvent,
  validateEventData,
  SynapEventSchema,
  EventTypeSchemas,
} from "./synap-event.js";
export type { SynapEvent } from "./synap-event.js";
```

**Utilisation :**

```typescript
import { createSynapEvent, EventTypes, type SynapEvent } from "@synap/types";

// Créer un événement
const event = createSynapEvent({
  type: EventTypes.NOTE_CREATION_REQUESTED,
  userId: "user-123",
  subjectId: "entity-456",
  data: { content: "Hello" },
  source: "api",
});

// Valider les données d'un événement
import { validateEventData } from "@synap/types";
const isValid = validateEventData("note.creation.requested", {
  content: "Hello",
});
```

---

### 3. `@synap/database` - Persistance

**Exports principaux :**

```typescript
// Database Client
export { db } from "./client.js";

// Schema & Entities
export {
  entities,
  relations,
  tags,
  entityTags,
  taskDetails,
  contentBlocks,
  conversations,
  conversationMessages,
  // ... autres tables
} from "./schema/index.js";

// Repositories
export { getEventRepository } from "./repositories/event-repository.js";
export { getEntityRepository } from "./repositories/entity-repository.js";
export { getConversationRepository } from "./repositories/conversation-repository.js";

// Types
export type { Entity, Relation, Tag, TaskDetail } from "./schema/index.js";
```

**Utilisation :**

```typescript
import { db, entities, getEventRepository, eq } from "@synap/database";

// Requête
const userNotes = await db
  .select()
  .from(entities)
  .where(eq(entities.userId, userId))
  .where(eq(entities.type, "note"));

// Insert
await db.insert(entities).values({
  id: randomUUID(),
  userId,
  type: "note",
  title: "My Note",
});

// Event Repository
const eventRepo = getEventRepository();
await eventRepo.append(event);
const events = await eventRepo.findByType("note.creation.requested", {
  userId,
});
```

---

### 4. `@synap/storage` - Stockage Objet

**Exports principaux :**

```typescript
export { storage } from "./index.js";
export type {
  StorageProvider,
  StorageMetadata,
  UploadOptions,
} from "./types.js";
```

**Utilisation :**

```typescript
import { storage } from "@synap/storage";

// Upload
const metadata = await storage.upload(
  "user-123/note-456.md",
  "# My Note\n\nContent here",
  { contentType: "text/markdown" }
);

// Download
const content = await storage.download("user-123/note-456.md");

// Delete
await storage.delete("user-123/note-456.md");

// Build path
const path = storage.buildPath(userId, "note", entityId, "md");
```

---

### 5. `@synap/jobs` - Workers Inngest

**Exports principaux :**

```typescript
// Inngest Client
export { inngest } from "./client.js";

// Event Publishing
export { publishEvent } from "./utils/inngest-client.js";

// Handler Interface
export type {
  IEventHandler,
  HandlerResult,
  InngestStep,
} from "./handlers/interface.js";

// Handler Registry
export { handlerRegistry } from "./handlers/registry.js";

// Realtime Broadcasting
export { broadcastRealtimeMessage } from "./utils/realtime-broadcast.js";
```

**Utilisation :**

```typescript
import {
  inngest,
  publishEvent,
  handlerRegistry,
  broadcastRealtimeMessage,
} from "@synap/jobs";
import type { IEventHandler } from "@synap/jobs";

// Publier un événement Inngest
await publishEvent(
  "api/event.logged",
  {
    id: event.id,
    type: event.type,
    data: event.data,
    userId: event.userId,
  },
  userId
);

// Créer un handler
export class MyHandler implements IEventHandler {
  eventType = "my.event.type";

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    // ... logique
    return { success: true };
  }
}

// Enregistrer le handler
handlerRegistry.register(new MyHandler());

// Broadcast real-time
await broadcastRealtimeMessage(userId, {
  type: "my.event.completed",
  data: { result: "success" },
  requestId: event.requestId,
});
```

---

### 6. `@synap/api` - API tRPC

**Exports principaux :**

```typescript
// Router Registry
export {
  dynamicRouterRegistry,
  registerRouter,
  unregisterRouter,
} from "./router-registry.js";

// tRPC Utilities
export { router, protectedProcedure } from "./trpc.js";

// Context
export { createContext } from "./context.js";

// App Router
export { appRouter } from "./index.js";
export type { AppRouter } from "./index.js";

// Event Publishing
export { publishEvent } from "./utils/inngest-client.js";
```

**Utilisation :**

```typescript
import { router, protectedProcedure, registerRouter } from "@synap/api";
import { z } from "zod";

// Créer un router
export const myRouter = router({
  create: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      // ... logique
      return { success: true };
    }),
});

// Enregistrer le router
registerRouter("my-capability", myRouter, {
  version: "1.0.0",
  source: "my-plugin",
  description: "My capability router",
});
```

---

### 7. `@synap/ai` - Intelligence Artificielle

**Exports principaux :**

```typescript
// Agent
export { runSynapAgent } from "./agent/graph.js";
export type { SynapAgentResult } from "./agent/graph.js";

// Tools
export {
  dynamicToolRegistry,
  registerTool,
  unregisterTool,
  getTool,
  getAllTools,
  executeTool,
} from "./tools/dynamic-registry.js";

// Tool Types
export type {
  AgentToolDefinition,
  AgentToolContext,
  ToolExecutionResult,
} from "./tools/types.js";
```

**Utilisation :**

```typescript
import {
  runSynapAgent,
  registerTool,
  type AgentToolDefinition,
} from "@synap/ai";
import { z } from "zod";

// Exécuter l'agent
const result = await runSynapAgent({
  userId: "user-123",
  threadId: "thread-456",
  message: "Create a note about AI",
});

// Créer un tool
const myTool: AgentToolDefinition<typeof mySchema, MyResult> = {
  name: "my_tool",
  description: "My custom tool",
  schema: mySchema,
  execute: async (params, context) => {
    // ... logique
    return { result: "success" };
  },
};

// Enregistrer le tool
registerTool(myTool, {
  version: "1.0.0",
  source: "my-plugin",
});
```

---

## 🔗 Flux de Données Typique

### Exemple : Créer une Note via API

```typescript
// 1. API Router (packages/api/src/routers/notes.ts)
import { createSynapEvent, EventTypes } from "@synap/types";
import { getEventRepository } from "@synap/database";
import { publishEvent } from "@synap/api/utils/inngest-client.js";

export const notesRouter = router({
  create: protectedProcedure
    .input(z.object({ content: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;

      // 2. Créer l'événement
      const event = createSynapEvent({
        type: EventTypes.NOTE_CREATION_REQUESTED,
        userId,
        data: input,
      });

      // 3. Sauvegarder dans Event Store
      const eventRepo = getEventRepository();
      await eventRepo.append(event);

      // 4. Publier vers Inngest
      await publishEvent("api/event.logged", eventData, userId);

      return { success: true, status: "pending" };
    }),
});
```

```typescript
// 5. Event Handler (packages/jobs/src/handlers/note-creation-handler.ts)
import { IEventHandler } from "@synap/jobs";
import { storage } from "@synap/storage";
import { db, entities } from "@synap/database";
import { broadcastRealtimeMessage } from "@synap/jobs";

export class NoteCreationHandler implements IEventHandler {
  eventType = EventTypes.NOTE_CREATION_REQUESTED;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    // 6. Upload vers storage
    const metadata = await step.run("upload", async () => {
      return await storage.upload(path, content, {
        contentType: "text/markdown",
      });
    });

    // 7. Créer l'entité dans la DB
    await step.run("create-entity", async () => {
      await db.insert(entities).values({
        /* ... */
      });
    });

    // 8. Broadcast real-time
    await broadcastRealtimeMessage(userId, {
      type: "note.creation.completed",
      data: { entityId },
    });

    return { success: true };
  }
}
```

---

## 📝 Patterns Recommandés

### 1. Créer un Handler

```typescript
import {
  IEventHandler,
  type HandlerResult,
  type InngestStep,
} from "@synap/jobs";
import { createSynapEvent, EventTypes, type SynapEvent } from "@synap/types";
import { createLogger } from "@synap/core";

const logger = createLogger({ module: "my-handler" });

export class MyHandler implements IEventHandler {
  eventType = "my.event.type";

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    try {
      // Logique métier avec step.run() pour retry
      await step.run("my-step", async () => {
        // ... logique
      });

      return { success: true, message: "Done" };
    } catch (error) {
      logger.error({ err: error }, "Handler failed");
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
```

### 2. Créer un Router

```typescript
import { router, protectedProcedure } from "@synap/api";
import { z } from "zod";
import { createSynapEvent, EventTypes } from "@synap/types";
import { getEventRepository } from "@synap/database";
import { publishEvent } from "@synap/api/utils/inngest-client.js";

export const myRouter = router({
  create: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;

      // CQRS: Publier événement, pas de logique métier
      const event = createSynapEvent({
        type: EventTypes.MY_CREATION_REQUESTED,
        userId,
        data: input,
      });

      const eventRepo = getEventRepository();
      await eventRepo.append(event);
      await publishEvent("api/event.logged", eventData, userId);

      return { success: true, status: "pending" };
    }),
});
```

### 3. Créer un Tool

```typescript
import { z } from "zod";
import type { AgentToolDefinition, AgentToolContext } from "@synap/ai";
import { createSynapEvent, EventTypes } from "@synap/types";
import { getEventRepository } from "@synap/database";
import { publishEvent } from "@synap/api/utils/inngest-client.js";

const myToolSchema = z.object({
  name: z.string().describe("Name of the item"),
});

export const myTool: AgentToolDefinition<typeof myToolSchema, { id: string }> =
  {
    name: "create_my_item",
    description: "Create a new item",
    schema: myToolSchema,
    execute: async (params, context) => {
      const { userId } = context;

      // Publier événement
      const event = createSynapEvent({
        type: EventTypes.MY_CREATION_REQUESTED,
        userId,
        data: params,
        source: "automation",
      });

      const eventRepo = getEventRepository();
      await eventRepo.append(event);
      await publishEvent("api/event.logged", eventData, userId);

      return { id: randomUUID() };
    },
  };
```

---

## ✅ Checklist pour Utiliser le SDK

- [ ] Importer les packages nécessaires (`@synap/core`, `@synap/types`, etc.)
- [ ] Utiliser `createSynapEvent()` pour créer des événements
- [ ] Utiliser `getEventRepository()` pour l'Event Store
- [ ] Utiliser `publishEvent()` pour publier vers Inngest
- [ ] Implémenter `IEventHandler` pour les workers
- [ ] Utiliser `step.run()` dans les handlers pour retry
- [ ] Enregistrer les handlers dans `handlerRegistry`
- [ ] Enregistrer les routers dans `dynamicRouterRegistry`
- [ ] Enregistrer les tools dans `dynamicToolRegistry`
- [ ] Utiliser `broadcastRealtimeMessage()` pour les notifications temps réel

---

**Note :** Ce SDK est utilisé par The Architech pour générer automatiquement le code des capacités.
