# Guide d'Extensibilité Synap Core OS

**Version :** 1.0 | **Date :** 2025-01-20

Ce guide documente comment étendre le Synap Core OS via The Architech pour créer des "capacités" (plugins internes) et intégrer des services externes.

---

## 📋 Table des Matières

1. [Architecture d'Extensibilité](#architecture-dextensibilité)
2. [Ajouter une Capacité (Plugin Interne)](#ajouter-une-capacité-plugin-interne)
3. [Intégrer un Service Externe](#intégrer-un-service-externe)
4. [SDK Backend](#sdk-backend)
5. [Exemples Complets](#exemples-complets)

---

## Architecture d'Extensibilité

Le Synap Core OS supporte deux types d'extensions :

### Type 1 : Plugins Internes (Capacités Installées)

**Quoi :** Code exécuté **à l'intérieur** du backend de l'utilisateur.

**Mécanisme :** Installation via The Architech qui modifie le code source du Core OS.

**Composants extensibles :**
- ✅ Migrations SQL (schémas de base de données)
- ✅ Event Handlers (workers Inngest)
- ✅ Event Types (types d'événements)
- ✅ tRPC Routers (endpoints API)
- ✅ AI Tools (outils pour l'agent LangGraph)

**Exemple :** Plugin "Suivi des Habitudes" qui ajoute :
- Table `habits` (migration SQL)
- Worker `habit.reminder.scheduled` (event handler)
- Router `/api/habits` (tRPC router)
- Tool `create_habit` (AI tool)

### Type 2 : Services Externes (Agents & API Connectés)

**Quoi :** Services hébergés **à l'extérieur** du Data Pod.

**Mécanisme :** Le Core OS appelle ces services via des API sécurisées.

**Composants :**
- ✅ HTTP clients pour appels API externes
- ✅ AI Tools qui appellent des services externes
- ✅ Event Handlers qui déclenchent des appels externes

**Exemple :** Intégration Google Calendar :
- Tool `call_google_calendar` qui fait des appels HTTP à l'API Google
- Handler qui synchronise les événements depuis Google Calendar

---

## Ajouter une Capacité (Plugin Interne)

### Vue d'Ensemble

Pour ajouter une capacité, vous devez créer/modifier :

1. **Migration SQL** → Nouvelle table/schéma
2. **Event Types** → Nouveaux types d'événements
3. **Event Handler** → Worker Inngest pour traiter les événements
4. **tRPC Router** → Endpoints API (optionnel)
5. **AI Tool** → Outil pour l'agent (optionnel)

### 1. Créer une Migration SQL

**Fichier :** `packages/database/src/schema/[entity-name].ts`

```typescript
import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Exemple : Table "habits"
export const habits = pgTable('habits', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  frequency: text('frequency').notNull(), // 'daily', 'weekly', etc.
  streak: integer('streak').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Habit = typeof habits.$inferSelect;
export type NewHabit = typeof habits.$inferInsert;
```

**Fichier :** `packages/database/src/schema/index.ts`

```typescript
// Ajouter l'export
export * from './habits.js';
```

**Migration :** Générer la migration avec Drizzle Kit

```bash
cd packages/database
pnpm drizzle-kit generate
# Crée packages/database/migrations-pg/XXXX_add_habits.sql
```

### 2. Ajouter un Event Type

**Fichier :** `packages/types/src/event-types.ts`

```typescript
export const EventTypes = {
  // ... types existants ...
  
  // ============================================================================
  // Habit Events
  // ============================================================================
  HABIT_CREATION_REQUESTED: 'habit.creation.requested',
  HABIT_CREATION_COMPLETED: 'habit.creation.completed',
  HABIT_COMPLETION_REQUESTED: 'habit.completion.requested',
  HABIT_COMPLETION_COMPLETED: 'habit.completion.completed',
} as const;
```

**Fichier :** `packages/types/src/synap-event.ts`

```typescript
export const EventTypeSchemas = {
  // ... schémas existants ...
  
  'habit.creation.requested': z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
  }),
  
  'habit.creation.completed': z.object({
    habitId: z.string().uuid(),
  }),
} as const;
```

### 3. Créer un Event Handler

**Fichier :** `packages/jobs/src/handlers/habit-creation-handler.ts`

```typescript
import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';
import { db, habits } from '@synap/database';
import { inngest } from '../client.js';
import { createLogger } from '@synap/core';
import { broadcastRealtimeMessage } from '../utils/realtime-broadcast.js';

const logger = createLogger({ module: 'habit-creation-handler' });

export class HabitCreationHandler implements IEventHandler {
  eventType = EventTypes.HABIT_CREATION_REQUESTED;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    const { name, description, frequency } = event.data as {
      name: string;
      description?: string;
      frequency: 'daily' | 'weekly' | 'monthly';
    };

    const habitId = event.aggregateId || randomUUID();
    const userId = event.userId;

    try {
      // Step 1: Create habit in database
      await step.run('create-habit', async () => {
        await db.insert(habits).values({
          id: habitId,
          userId,
          name,
          description,
          frequency,
          streak: 0,
        });
        logger.info({ habitId, userId }, 'Habit created');
      });

      // Step 2: Publish completion event
      await step.run('publish-completion', async () => {
        const completionEvent = createSynapEvent({
          type: EventTypes.HABIT_CREATION_COMPLETED,
          userId,
          aggregateId: habitId,
          data: { habitId },
          source: 'automation',
          causationId: event.id,
          correlationId: event.correlationId,
        });

        const eventRepo = getEventRepository();
        await eventRepo.append(completionEvent);
        await publishEvent('api/event.logged', { /* ... */ }, userId);
      });

      // Step 3: Broadcast real-time notification
      await broadcastRealtimeMessage(userId, {
        type: 'habit.creation.completed',
        data: { habitId, name },
        requestId: event.requestId,
      });

      return { success: true, message: 'Habit created successfully' };
    } catch (error) {
      logger.error({ err: error, habitId }, 'Failed to create habit');
      
      await broadcastRealtimeMessage(userId, {
        type: 'habit.creation.failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: event.requestId,
      });

      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create habit',
      };
    }
  }
}
```

**Fichier :** `packages/jobs/src/handlers/index.ts`

```typescript
// Importer et enregistrer le handler
import { HabitCreationHandler } from './habit-creation-handler.js';

const habitCreationHandler = new HabitCreationHandler();
handlerRegistry.register(habitCreationHandler);
```

### 4. Créer un tRPC Router

**Fichier :** `packages/api/src/routers/habits.ts`

```typescript
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { randomUUID } from 'crypto';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { publishEvent } from '../utils/inngest-client.js';
import { db, habits } from '@synap/database';
import { eq } from 'drizzle-orm';

const CreateHabitInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
});

export const habitsRouter = router({
  create: protectedProcedure
    .input(CreateHabitInputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      const requestId = randomUUID();
      const habitId = randomUUID();

      // Publish event (CQRS pattern)
      const event = createSynapEvent({
        type: EventTypes.HABIT_CREATION_REQUESTED,
        userId,
        aggregateId: habitId,
        data: input,
        source: 'api',
        requestId,
      });

      const eventRepo = getEventRepository();
      await eventRepo.append(event);
      await publishEvent('api/event.logged', { /* ... */ }, userId);

      return {
        success: true,
        status: 'pending',
        requestId,
        habitId,
      };
    }),

  list: protectedProcedure
    .query(async ({ ctx }) => {
      const userId = ctx.userId as string;
      const userHabits = await db
        .select()
        .from(habits)
        .where(eq(habits.userId, userId));
      return userHabits;
    }),
});
```

**Fichier :** `packages/api/src/index.ts`

```typescript
// Enregistrer le router
import { habitsRouter } from './routers/habits.js';
import { dynamicRouterRegistry } from './router-registry.js';

dynamicRouterRegistry.register('habits', habitsRouter, {
  version: '1.0.0',
  source: 'capability-habits',
  description: 'Habit tracking capability',
});
```

### 5. Créer un AI Tool

**Fichier :** `packages/ai/src/tools/create-habit-tool.ts`

```typescript
import { z } from 'zod';
import type { AgentToolDefinition, AgentToolContext, ToolExecutionResult } from './types.js';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { publishEvent } from '@synap/api/utils/inngest-client.js';

const createHabitSchema = z.object({
  name: z.string().describe('Habit name'),
  description: z.string().optional().describe('Habit description'),
  frequency: z.enum(['daily', 'weekly', 'monthly']).describe('Habit frequency'),
});

export const createHabitTool: AgentToolDefinition<
  typeof createHabitSchema,
  { habitId: string; name: string }
> = {
  name: 'create_habit',
  description: 'Create a new habit to track',
  schema: createHabitSchema,
  execute: async (params, context) => {
    const { userId } = context;
    const habitId = randomUUID();

    // Publish event
    const event = createSynapEvent({
      type: EventTypes.HABIT_CREATION_REQUESTED,
      userId,
      aggregateId: habitId,
      data: params,
      source: 'automation',
    });

    const eventRepo = getEventRepository();
    await eventRepo.append(event);
    await publishEvent('api/event.logged', { /* ... */ }, userId);

    return {
      habitId,
      name: params.name,
    };
  },
};
```

**Fichier :** `packages/ai/src/tools/index.ts`

```typescript
// Enregistrer le tool
import { createHabitTool } from './create-habit-tool.js';
import { registerTool } from './dynamic-registry.js';

registerTool(createHabitTool, {
  version: '1.0.0',
  source: 'capability-habits',
});
```

---

## Intégrer un Service Externe

### Vue d'Ensemble

Pour intégrer un service externe (ex: Google Calendar, OpenAI API), vous devez :

1. **Créer un client HTTP** pour appeler l'API externe
2. **Créer un AI Tool** qui utilise ce client (optionnel)
3. **Créer un Event Handler** qui déclenche des appels (optionnel)

### Exemple : Intégration Google Calendar

#### 1. Créer un Client HTTP

**Fichier :** `packages/ai/src/tools/external-services/google-calendar-client.ts`

```typescript
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'google-calendar-client' });

export interface GoogleCalendarEvent {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

export class GoogleCalendarClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  async createEvent(event: GoogleCalendarEvent): Promise<{ id: string }> {
    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error, status: response.status }, 'Failed to create Google Calendar event');
      throw new Error(`Google Calendar API error: ${error}`);
    }

    const data = await response.json();
    return { id: data.id };
  }

  async listEvents(timeMin: string, timeMax: string): Promise<GoogleCalendarEvent[]> {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error('Failed to list Google Calendar events');
    }

    const data = await response.json();
    return data.items || [];
  }
}
```

#### 2. Créer un AI Tool

**Fichier :** `packages/ai/src/tools/google-calendar-tool.ts`

```typescript
import { z } from 'zod';
import type { AgentToolDefinition, AgentToolContext, ToolExecutionResult } from './types.js';
import { GoogleCalendarClient } from './external-services/google-calendar-client.js';

const createCalendarEventSchema = z.object({
  summary: z.string().describe('Event title'),
  description: z.string().optional().describe('Event description'),
  startTime: z.string().describe('Start time (ISO 8601)'),
  endTime: z.string().describe('End time (ISO 8601)'),
  timeZone: z.string().default('UTC').describe('Time zone'),
});

export const createGoogleCalendarEventTool: AgentToolDefinition<
  typeof createCalendarEventSchema,
  { eventId: string; summary: string }
> = {
  name: 'create_google_calendar_event',
  description: 'Create an event in Google Calendar',
  schema: createCalendarEventSchema,
  execute: async (params, context) => {
    const { userId } = context;
    
    // TODO: Récupérer le token OAuth depuis la config utilisateur
    // Pour l'instant, on suppose qu'il est dans les variables d'environnement
    const accessToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    
    if (!accessToken) {
      throw new Error('Google Calendar access token not configured');
    }

    const client = new GoogleCalendarClient(accessToken);
    
    const event = await client.createEvent({
      summary: params.summary,
      description: params.description,
      start: {
        dateTime: params.startTime,
        timeZone: params.timeZone,
      },
      end: {
        dateTime: params.endTime,
        timeZone: params.timeZone,
      },
    });

    return {
      eventId: event.id,
      summary: params.summary,
    };
  },
};
```

**Enregistrer le tool :**

```typescript
import { registerTool } from './dynamic-registry.js';
registerTool(createGoogleCalendarEventTool, {
  version: '1.0.0',
  source: 'external-service-google-calendar',
});
```

#### 3. Créer un Event Handler (Optionnel)

Si vous voulez synchroniser des événements depuis Google Calendar :

**Fichier :** `packages/jobs/src/handlers/google-calendar-sync-handler.ts`

```typescript
import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { GoogleCalendarClient } from '@synap/ai/tools/external-services/google-calendar-client.js';
import { createSynapEvent, EventTypes } from '@synap/types';
import { db, entities } from '@synap/database';

export class GoogleCalendarSyncHandler implements IEventHandler {
  eventType = 'google.calendar.sync.requested';

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    const userId = event.userId;
    const accessToken = await this.getAccessToken(userId); // Récupérer depuis la DB

    const client = new GoogleCalendarClient(accessToken);
    
    // Récupérer les événements des 7 derniers jours
    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 7);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 7);

    const events = await step.run('fetch-calendar-events', async () => {
      return await client.listEvents(timeMin.toISOString(), timeMax.toISOString());
    });

    // Créer des entités pour chaque événement
    for (const calendarEvent of events) {
      await step.run(`create-entity-${calendarEvent.id}`, async () => {
        const entityId = randomUUID();
        await db.insert(entities).values({
          id: entityId,
          userId,
          type: 'calendar_event',
          title: calendarEvent.summary,
          preview: calendarEvent.description || '',
        });
      });
    }

    return { success: true, message: `Synced ${events.length} events` };
  }

  private async getAccessToken(userId: string): Promise<string> {
    // TODO: Récupérer depuis la table user_oauth_tokens
    throw new Error('Not implemented');
  }
}
```

---

## SDK Backend

### Structure des Packages

Le backend Synap est organisé en packages monorepo :

```
packages/
├── core/          # Configuration, logging, errors (SDK de base)
├── types/         # Types TypeScript partagés (events, etc.)
├── database/      # ORM, schémas, migrations (SDK de persistance)
├── storage/       # Abstraction S3 (R2/MinIO) (SDK de stockage)
├── api/           # tRPC routers, middleware (SDK API)
├── jobs/           # Inngest workers, handlers (SDK de jobs)
├── ai/             # LangGraph agent, tools (SDK IA)
└── auth/           # Authentification (SDK auth)
```

### Utilisation du SDK

#### 1. Configuration (`@synap/core`)

```typescript
import { config } from '@synap/core';

// Accès à la configuration
const dbUrl = config.database.url;
const storageProvider = config.storage.provider;
```

#### 2. Base de Données (`@synap/database`)

```typescript
import { db, entities, getEventRepository } from '@synap/database';

// Requête
const userNotes = await db.select().from(entities).where(eq(entities.userId, userId));

// Event Store
const eventRepo = getEventRepository();
await eventRepo.append(event);
```

#### 3. Stockage (`@synap/storage`)

```typescript
import { storage } from '@synap/storage';

// Upload
const metadata = await storage.upload(path, content, { contentType: 'text/markdown' });

// Download
const content = await storage.download(path);
```

#### 4. Jobs (`@synap/jobs`)

```typescript
import { inngest, publishEvent } from '@synap/jobs';

// Publier un événement Inngest
await publishEvent('api/event.logged', eventData, userId);
```

#### 5. Types (`@synap/types`)

```typescript
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';

const event = createSynapEvent({
  type: EventTypes.NOTE_CREATION_REQUESTED,
  userId,
  data: { content: 'Hello' },
});
```

---

## Exemples Complets

### Exemple 1 : Capacité "Habits" (Plugin Interne)

Voir les sections précédentes pour un exemple complet d'une capacité "Habits" avec :
- Migration SQL
- Event Types
- Event Handler
- tRPC Router
- AI Tool

### Exemple 2 : Service Externe "Google Calendar"

Voir la section "Intégrer un Service Externe" pour un exemple complet d'intégration Google Calendar.

---

## Checklist pour The Architech

Pour qu'une capacité soit installable via The Architech, elle doit inclure :

- [ ] **Migration SQL** : Fichier de migration Drizzle
- [ ] **Event Types** : Ajout dans `packages/types/src/event-types.ts`
- [ ] **Event Handler** : Classe implémentant `IEventHandler`
- [ ] **Enregistrement Handler** : Ajout dans `packages/jobs/src/handlers/index.ts`
- [ ] **tRPC Router** (optionnel) : Router avec enregistrement dans `dynamicRouterRegistry`
- [ ] **AI Tool** (optionnel) : Tool avec enregistrement dans `dynamicToolRegistry`
- [ ] **Tests** : Tests unitaires pour chaque composant
- [ ] **Documentation** : README expliquant la capacité

---

**Note :** Ce guide sera utilisé par The Architech pour générer automatiquement les blueprints de capacités pour la marketplace Synap.

