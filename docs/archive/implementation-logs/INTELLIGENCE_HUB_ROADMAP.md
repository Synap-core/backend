# Plan d'Action - Intelligence Hub V1.0

**Version :** 1.0  
**Date :** 2025-01-20  
**Statut :** Plan Directeur Validé  
**Basé sur :** Recherche Technologique + Recommandations Pragmatiques

---

## 📋 Vue d'Ensemble

Ce document définit le plan d'action détaillé pour construire l'**Intelligence Hub** de Synap, en suivant une approche pragmatique et progressive.

### Principes Directeurs

1. **MVP First** : Commencer simple, ajouter la complexité seulement si nécessaire
2. **Pragmatisme** : Utiliser ce qui existe déjà (Better Auth, PostgreSQL, Inngest)
3. **Little Wins** : Chaque phase doit produire une valeur démontrable
4. **Évolutivité** : Architecture extensible pour ajouter des features plus tard

### Technologies Validées

- ✅ **LangGraph.js** - Orchestration d'agents (implémenter immédiatement)
- ✅ **Inngest + TensorFlow.js** - IA Proactive (déjà utilisé, continuer)
- ✅ **PostgreSQL + pgvector** - Base de données (déjà utilisé, continuer)
- ⚠️ **Mem0** - Super Memory (évaluer plus tard, commencer avec PostgreSQL temporal)
- ⚠️ **Ory Stack** - Sécurité (ajouter uniquement quand marketplace, garder Better Auth pour l'instant)

---

## 🎯 Objectifs Globaux

### Objectif Principal
Construire un **Intelligence Hub fonctionnel** qui peut :
1. Recevoir des requêtes du Data Pod via Hub Protocol
2. Exécuter des agents LangGraph complexes
3. Retourner des insights structurés au Data Pod
4. Générer des suggestions proactives basées sur les patterns utilisateur

### Objectifs Mesurables (MVP)

- ✅ **Agent ActionExtractor** : Transformer une phrase en tâche/note (95%+ accuracy)
- ✅ **Agent KnowledgeSynthesizer** : Répondre à des questions sur les données utilisateur (80%+ relevance)
- ✅ **Proactive Insights** : Générer 2-3 suggestions pertinentes par semaine par utilisateur
- ✅ **Latency** : <2s pour requête simple, <5s pour requête complexe
- ✅ **Uptime** : >99% (pour MVP)

---

## 📅 Timeline Global

```
Phase 1: Fondations (3 semaines)
  └─ Semaine 1-2: Structure Intelligence Hub + LangGraph
  └─ Semaine 3: Premier Agent (ActionExtractor)

Phase 2: Agents Experts (2 semaines)
  └─ Semaine 4: Agent KnowledgeSynthesizer
  └─ Semaine 5: Memory Layer (PostgreSQL temporal)

Phase 3: IA Proactive (2 semaines)
  └─ Semaine 6: Inngest Workflows + TensorFlow.js
  └─ Semaine 7: Premier Insight Proactif

Phase 4: Optimisations (1 semaine)
  └─ Semaine 8: Tests, Documentation, Polish

Total: 8 semaines (2 mois)
```

---

## 🏗️ Phase 1 : Fondations (Semaines 1-3)

### Objectif
Créer la structure de base de l'Intelligence Hub et le premier agent fonctionnel.

### Little Win 1.1 : Structure du Package Intelligence Hub (Semaine 1)

**Objectif :** Créer le package `@synap/intelligence-hub` avec structure de base.

**Tâches :**

1. **Créer le package**
   ```bash
   mkdir packages/intelligence-hub
   cd packages/intelligence-hub
   pnpm init
   ```

2. **Structure de base**
   ```
   packages/intelligence-hub/
   ├── src/
   │   ├── index.ts                    # Export principal
   │   ├── config.ts                   # Configuration
   │   ├── agents/                     # Agents LangGraph
   │   │   ├── index.ts
   │   │   ├── supervisor-agent.ts     # Orchestrateur principal
   │   │   └── action-extractor.ts     # Premier agent
   │   ├── services/                   # Services métier
   │   │   ├── hub-orchestrator.ts     # Orchestrateur Hub
   │   │   ├── memory-layer.ts         # Memory Layer (PostgreSQL)
   │   │   └── subscription-service.ts  # Gestion abonnements
   │   ├── clients/                    # Clients externes
   │   │   └── hub-protocol-client.ts  # Client Hub Protocol
   │   ├── tools/                      # LangChain Tools
   │   │   ├── datapod-tool.ts         # Tool pour accéder au Data Pod
   │   │   └── memory-tool.ts          # Tool pour Memory Layer
   │   └── types/                      # Types TypeScript
   │       └── index.ts
   ├── package.json
   ├── tsconfig.json
   └── README.md
   ```

3. **Dependencies**
   ```json
   {
     "dependencies": {
       "@langchain/langgraph": "^0.2.0",
       "@langchain/core": "^0.3.0",
       "@synap/hub-protocol": "workspace:*",
       "@synap/types": "workspace:*",
       "@trpc/client": "^10.45.0",
       "zod": "^3.22.0"
     },
     "devDependencies": {
       "@types/node": "^20.0.0",
       "typescript": "^5.3.0"
     }
   }
   ```

4. **Configuration de base**
   ```typescript
   // packages/intelligence-hub/src/config.ts
   import { z } from 'zod';

   const ConfigSchema = z.object({
     hubUrl: z.string().url(),
     openaiApiKey: z.string(),
     anthropicApiKey: z.string().optional(),
     databaseUrl: z.string().url(),
     inngestEventKey: z.string().optional(),
   });

   export const config = ConfigSchema.parse({
     hubUrl: process.env.INTELLIGENCE_HUB_URL || 'http://localhost:3001',
     openaiApiKey: process.env.OPENAI_API_KEY!,
     anthropicApiKey: process.env.ANTHROPIC_API_KEY,
     databaseUrl: process.env.DATABASE_URL!,
     inngestEventKey: process.env.INNGEST_EVENT_KEY,
   });
   ```

**Livrables :**
- ✅ Package `@synap/intelligence-hub` créé
- ✅ Structure de base avec dossiers
- ✅ Configuration TypeScript
- ✅ Dependencies installées

**Critères de succès :**
- Package compile sans erreur
- Structure prête pour développement

---

### Little Win 1.2 : Hub Protocol Client (Semaine 1)

**Objectif :** Créer le client pour communiquer avec les Data Pods via Hub Protocol.

**Tâches :**

1. **Créer le client Hub Protocol**
   ```typescript
   // packages/intelligence-hub/src/clients/hub-protocol-client.ts
   import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
   import type { AppRouter } from '@synap/api';
   import { config } from '../config.js';

   export class HubProtocolClient {
     private client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;

     constructor(dataPodUrl: string, apiKey: string) {
       this.client = createTRPCProxyClient<AppRouter>({
         links: [
           httpBatchLink({
             url: `${dataPodUrl}/trpc`,
             headers: {
               'Authorization': `Bearer ${apiKey}`,
             },
           }),
         ],
       });
     }

     async generateAccessToken(requestId: string, scope: string[]) {
       return this.client.hub.generateAccessToken.mutate({
         requestId,
         scope,
         expiresIn: 300, // 5 minutes
       });
     }

     async requestData(token: string, scope: string[], filters?: any) {
       return this.client.hub.requestData.query({
         token,
         scope,
         filters,
       });
     }

     async submitInsight(token: string, insight: any) {
       return this.client.hub.submitInsight.mutate({
         token,
         insight,
       });
     }
   }
   ```

2. **Tests unitaires**
   ```typescript
   // packages/intelligence-hub/src/clients/__tests__/hub-protocol-client.test.ts
   import { describe, it, expect } from 'vitest';
   import { HubProtocolClient } from '../hub-protocol-client.js';

   describe('HubProtocolClient', () => {
     it('should generate access token', async () => {
       const client = new HubProtocolClient('http://localhost:3000', 'test-key');
       // Mock tRPC client
       // Test token generation
     });
   });
   ```

**Livrables :**
- ✅ Client Hub Protocol fonctionnel
- ✅ Tests unitaires
- ✅ Gestion d'erreurs

**Critères de succès :**
- Client peut générer des tokens
- Client peut récupérer des données
- Client peut soumettre des insights
- Tests passent à 100%

---

### Little Win 1.3 : LangGraph Supervisor Agent (Semaine 2)

**Objectif :** Créer l'orchestrateur principal avec pattern Supervisor.

**Tâches :**

1. **Créer le Supervisor Agent**
   ```typescript
   // packages/intelligence-hub/src/agents/supervisor-agent.ts
   import { StateGraph, END } from "@langchain/langgraph";
   import { ChatOpenAI } from "@langchain/openai";
   import { MemoryLayer } from '../services/memory-layer.js';
   import { HubProtocolClient } from '../clients/hub-protocol-client.js';

   interface SupervisorState {
     requestId: string;
     userId: string;
     dataPodUrl: string;
     query: string;
     agentId: string;
     context: Record<string, unknown>;
     workerResults: Record<string, unknown>;
     finalOutput: string | null;
   }

   export function createSupervisorAgent(
     memoryLayer: MemoryLayer,
     hubClient: HubProtocolClient
   ) {
     const llm = new ChatOpenAI({
       modelName: "gpt-4o-mini",
       temperature: 0.7,
     });

     const graph = new StateGraph<SupervisorState>({
       channels: {
         requestId: { value: null },
         userId: { value: null },
         dataPodUrl: { value: null },
         query: { value: null },
         agentId: { value: null },
         context: { value: null },
         workerResults: { value: (x, y) => ({ ...x, ...y }), default: () => ({}) },
         finalOutput: { value: null },
       },
     });

     // Node: Router (détermine quel agent appeler)
     graph.addNode("router", async (state) => {
       const routingPrompt = `
         Détermine quel agent doit traiter cette requête:
         - "action_extractor": Pour créer des tâches/notes depuis une phrase
         - "knowledge_synthesizer": Pour répondre à des questions sur les données
         - "project_planner": Pour planifier des projets complexes
        
         Requête: ${state.query}
        
         Réponds uniquement avec l'ID de l'agent.
       `;

       const response = await llm.invoke(routingPrompt);
       const agentId = response.content.trim().toLowerCase();

       return { agentId };
     });

     // Node: Execute Agent (appelle l'agent approprié)
     graph.addNode("execute_agent", async (state) => {
       switch (state.agentId) {
         case "action_extractor":
           return await executeActionExtractor(state, llm, hubClient);
         case "knowledge_synthesizer":
           return await executeKnowledgeSynthesizer(state, llm, memoryLayer, hubClient);
         default:
           throw new Error(`Unknown agent: ${state.agentId}`);
       }
     });

     // Node: Aggregator (agrège les résultats)
     graph.addNode("aggregator", async (state) => {
       const aggregationPrompt = `
         Synthétise ces résultats en un insight structuré:
         ${JSON.stringify(state.workerResults)}
       `;

       const response = await llm.invoke(aggregationPrompt);
       
       return {
         finalOutput: response.content,
       };
     });

     // Edges
     graph.addEdge("router", "execute_agent");
     graph.addEdge("execute_agent", "aggregator");
     graph.addEdge("aggregator", END);

     return graph.compile();
   }
   ```

2. **Orchestrateur Hub**
   ```typescript
   // packages/intelligence-hub/src/services/hub-orchestrator.ts
   import { createSupervisorAgent } from '../agents/supervisor-agent.js';
   import { HubProtocolClient } from '../clients/hub-protocol-client.js';
   import { MemoryLayer } from './memory-layer.js';

   export class HubOrchestrator {
     private supervisorAgent: ReturnType<typeof createSupervisorAgent>;

     constructor(
       private memoryLayer: MemoryLayer,
       private hubClient: HubProtocolClient
     ) {
       this.supervisorAgent = createSupervisorAgent(memoryLayer, hubClient);
     }

     async executeRequest(request: {
       requestId: string;
       userId: string;
       dataPodUrl: string;
       query: string;
       agentId?: string;
     }) {
       // 1. Obtenir token d'accès
       const { token } = await this.hubClient.generateAccessToken(
         request.requestId,
         ['preferences', 'notes', 'tasks', 'knowledge_facts']
       );

       // 2. Récupérer contexte du Data Pod
       const context = await this.hubClient.requestData(token, [
         'preferences',
         'notes',
         'tasks',
         'knowledge_facts',
       ]);

       // 3. Exécuter supervisor agent
       const result = await this.supervisorAgent.invoke({
         requestId: request.requestId,
         userId: request.userId,
         dataPodUrl: request.dataPodUrl,
         query: request.query,
         agentId: request.agentId,
         context: context.data,
         workerResults: {},
         finalOutput: null,
       });

       // 4. Soumettre insight au Data Pod
       await this.hubClient.submitInsight(token, {
         version: '1.0',
         type: 'action_plan',
         correlationId: request.requestId,
         actions: result.finalOutput,
         confidence: 0.9,
       });

       return result;
     }
   }
   ```

**Livrables :**
- ✅ Supervisor Agent avec LangGraph
- ✅ Hub Orchestrator
- ✅ Routing vers agents spécialisés
- ✅ Tests unitaires

**Critères de succès :**
- Supervisor peut router vers agents
- Supervisor peut exécuter agents
- Supervisor peut agréger résultats
- Tests passent à 100%

---

### Little Win 1.4 : Premier Agent - ActionExtractor (Semaine 3)

**Objectif :** Créer le premier agent fonctionnel qui transforme une phrase en tâche/note.

**Tâches :**

1. **Créer ActionExtractor Agent**
   ```typescript
   // packages/intelligence-hub/src/agents/action-extractor.ts
   import { StateGraph, END } from "@langchain/langgraph";
   import { ChatOpenAI } from "@langchain/openai";
   import { z } from "zod";
   import { HubInsightSchema } from '@synap/hub-protocol';

   interface ActionExtractorState {
     query: string;
     context: Record<string, unknown>;
     extractedAction: {
       type: 'task' | 'note';
       title: string;
       description?: string;
       dueDate?: string;
       metadata?: Record<string, unknown>;
     } | null;
     insight: z.infer<typeof HubInsightSchema> | null;
   }

   export function createActionExtractorAgent() {
     const llm = new ChatOpenAI({
       modelName: "gpt-4o-mini",
       temperature: 0.3, // Plus déterministe
     });

     const graph = new StateGraph<ActionExtractorState>({
       channels: {
         query: { value: null },
         context: { value: null },
         extractedAction: { value: null },
         insight: { value: null },
       },
     });

     // Node: Extract Action
     graph.addNode("extract", async (state) => {
       const extractionPrompt = `
         Extrais une action depuis cette phrase:
         "${state.query}"
        
         Contexte utilisateur:
         ${JSON.stringify(state.context.preferences || {})}
        
         Réponds en JSON avec:
         - type: "task" ou "note"
         - title: Titre de l'action
         - description: Description (optionnel)
         - dueDate: Date d'échéance ISO (optionnel)
         - metadata: Métadonnées additionnelles (optionnel)
       `;

       const response = await llm.invoke(extractionPrompt);
       const extracted = JSON.parse(response.content);

       return { extractedAction: extracted };
     });

     // Node: Generate Insight
     graph.addNode("generate_insight", async (state) => {
       if (!state.extractedAction) {
         throw new Error("No action extracted");
       }

       const insight: z.infer<typeof HubInsightSchema> = {
         version: '1.0',
         type: 'action_plan',
         correlationId: randomUUID(),
         actions: [
           {
             eventType: state.extractedAction.type === 'task'
               ? 'task.creation.requested'
               : 'note.creation.requested',
             data: {
               title: state.extractedAction.title,
               description: state.extractedAction.description,
               dueDate: state.extractedAction.dueDate,
               ...state.extractedAction.metadata,
             },
             requiresConfirmation: true,
           },
         ],
         confidence: 0.9,
         reasoning: `Action extraite depuis: "${state.query}"`,
       };

       return { insight };
     });

     // Edges
     graph.addEdge("extract", "generate_insight");
     graph.addEdge("generate_insight", END);

     return graph.compile();
   }
   ```

2. **Intégrer dans Supervisor**
   ```typescript
   // Dans supervisor-agent.ts
   async function executeActionExtractor(
     state: SupervisorState,
     llm: ChatOpenAI,
     hubClient: HubProtocolClient
   ) {
     const actionExtractor = createActionExtractorAgent();
     
     const result = await actionExtractor.invoke({
       query: state.query,
       context: state.context,
       extractedAction: null,
       insight: null,
     });

     return {
       workerResults: {
         actionExtractor: result.insight,
       },
     };
   }
   ```

3. **Tests end-to-end**
   ```typescript
   // packages/intelligence-hub/src/agents/__tests__/action-extractor.test.ts
   import { describe, it, expect } from 'vitest';
   import { createActionExtractorAgent } from '../action-extractor.js';

   describe('ActionExtractor', () => {
     it('should extract task from phrase', async () => {
       const agent = createActionExtractorAgent();
       
       const result = await agent.invoke({
         query: "Rappelle-moi d'appeler Paul demain",
         context: {},
         extractedAction: null,
         insight: null,
       });

       expect(result.insight).toBeDefined();
       expect(result.insight?.actions?.[0]?.eventType).toBe('task.creation.requested');
       expect(result.insight?.actions?.[0]?.data.title).toContain('appeler Paul');
     });
   });
   ```

**Livrables :**
- ✅ ActionExtractor Agent fonctionnel
- ✅ Intégration dans Supervisor
- ✅ Tests end-to-end
- ✅ Documentation

**Critères de succès :**
- Agent extrait actions avec 95%+ accuracy
- Agent génère insights valides
- Tests passent à 100%
- Documentation complète

---

## 🧠 Phase 2 : Agents Experts (Semaines 4-5)

### Little Win 2.1 : Agent KnowledgeSynthesizer (Semaine 4)

**Objectif :** Créer l'agent qui répond aux questions sur les données utilisateur.

**Tâches :**

1. **Créer KnowledgeSynthesizer Agent**
   ```typescript
   // packages/intelligence-hub/src/agents/knowledge-synthesizer.ts
   import { StateGraph, END } from "@langchain/langgraph";
   import { ChatOpenAI } from "@langchain/openai";
   import { MemoryLayer } from '../services/memory-layer.js';
   import { HubProtocolClient } from '../clients/hub-protocol-client.js';

   interface KnowledgeSynthesizerState {
     query: string;
     userId: string;
     context: Record<string, unknown>;
     relevantFacts: Array<{ fact: any; relevance: number }>;
     answer: string | null;
     insight: any | null;
   }

   export function createKnowledgeSynthesizerAgent(
     memoryLayer: MemoryLayer,
     hubClient: HubProtocolClient
   ) {
     const llm = new ChatOpenAI({
       modelName: "gpt-4o",
       temperature: 0.7,
     });

     const graph = new StateGraph<KnowledgeSynthesizerState>({
       channels: {
         query: { value: null },
         userId: { value: null },
         context: { value: null },
         relevantFacts: { value: [] },
         answer: { value: null },
         insight: { value: null },
       },
     });

     // Node: Search Memory
     graph.addNode("search_memory", async (state) => {
       // Recherche dans Memory Layer (PostgreSQL temporal)
       const facts = await memoryLayer.searchTemporal(
         state.userId,
         state.query
       );

       return { relevantFacts: facts };
     });

     // Node: Search Data Pod
     graph.addNode("search_datapod", async (state) => {
       // Recherche vectorielle dans Data Pod
       const { token } = await hubClient.generateAccessToken(
         randomUUID(),
         ['notes', 'tasks', 'knowledge_facts']
       );

       const data = await hubClient.requestData(token, ['notes', 'tasks'], {
         filters: {
           // Filtres pour recherche sémantique
         },
       });

       return { context: { ...state.context, datapodData: data.data } };
     });

     // Node: Synthesize Answer
     graph.addNode("synthesize", async (state) => {
       const synthesisPrompt = `
         Question: ${state.query}
        
         Faits pertinents:
         ${JSON.stringify(state.relevantFacts.map(f => f.fact))}
        
         Données du Data Pod:
         ${JSON.stringify(state.context.datapodData || {})}
        
         Réponds à la question en utilisant ces informations.
       `;

       const response = await llm.invoke(synthesisPrompt);
       
       return { answer: response.content };
     });

     // Node: Generate Insight
     graph.addNode("generate_insight", async (state) => {
       const insight = {
         version: '1.0',
         type: 'analysis',
         correlationId: randomUUID(),
         analysis: {
           title: 'Réponse à votre question',
           content: state.answer,
           sources: state.relevantFacts.map(f => ({
             type: 'fact',
             id: f.fact.id,
           })),
         },
         confidence: 0.85,
       };

       return { insight };
     });

     // Edges
     graph.addEdge("search_memory", "search_datapod");
     graph.addEdge("search_datapod", "synthesize");
     graph.addEdge("synthesize", "generate_insight");
     graph.addEdge("generate_insight", END);

     return graph.compile();
   }
   ```

**Livrables :**
- ✅ KnowledgeSynthesizer Agent
- ✅ Intégration Memory Layer
- ✅ Recherche hybride (Memory + Data Pod)
- ✅ Tests

**Critères de succès :**
- Agent répond aux questions avec 80%+ relevance
- Agent utilise Memory Layer et Data Pod
- Tests passent à 100%

---

### Little Win 2.2 : Memory Layer (PostgreSQL Temporal) (Semaine 5)

**Objectif :** Créer la couche de mémoire avec PostgreSQL temporal (alternative simple à Mem0).

**Tâches :**

1. **Créer schéma PostgreSQL pour Memory**
   ```sql
   -- packages/database/migrations-custom/0012_create_memory_layer.sql
   CREATE TABLE memory_facts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id TEXT NOT NULL,
     
     -- Fact structure
     subject TEXT NOT NULL,
     predicate TEXT NOT NULL,
     object TEXT NOT NULL,
     
     -- Temporal tracking
     valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     valid_to TIMESTAMPTZ,
     
     -- Metadata
     metadata JSONB DEFAULT '{}',
     confidence FLOAT DEFAULT 1.0,
     
     -- Embedding for similarity search
     embedding vector(1536),
     
     -- Timestamps
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );

   -- Indexes
   CREATE INDEX idx_memory_facts_user ON memory_facts(user_id);
   CREATE INDEX idx_memory_facts_temporal ON memory_facts(valid_from, valid_to) WHERE valid_to IS NULL;
   CREATE INDEX idx_memory_facts_embedding ON memory_facts USING hnsw (embedding vector_cosine_ops);
   CREATE INDEX idx_memory_facts_subject_predicate ON memory_facts(subject, predicate);
   ```

2. **Implémenter MemoryLayer Service**
   ```typescript
   // packages/intelligence-hub/src/services/memory-layer.ts
   import { drizzle } from 'drizzle-orm/postgres-js';
   import { eq, and, gte, lte, isNull } from 'drizzle-orm';
   import { memoryFacts } from '@synap/database/schema/memory-facts';
   import { getEmbedding } from '@synap/ai/providers/openai';

   export class MemoryLayer {
     constructor(private db: ReturnType<typeof drizzle>) {}

     async addFact(
       userId: string,
       fact: {
         subject: string;
         predicate: string;
         object: string;
         validFrom?: Date;
         metadata?: Record<string, unknown>;
       }
     ) {
       // Générer embedding pour recherche sémantique
       const text = `${fact.subject} ${fact.predicate} ${fact.object}`;
       const embedding = await getEmbedding(text);

       await this.db.insert(memoryFacts).values({
         userId,
         subject: fact.subject,
         predicate: fact.predicate,
         object: fact.object,
         validFrom: fact.validFrom || new Date(),
         metadata: fact.metadata || {},
         embedding,
       });
     }

     async searchTemporal(
       userId: string,
       query: string,
       dateRange?: { start: Date; end: Date }
     ): Promise<Array<{ fact: any; relevance: number }>> {
       // Recherche vectorielle
       const queryEmbedding = await getEmbedding(query);
       
       let queryBuilder = this.db
         .select()
         .from(memoryFacts)
         .where(
           and(
             eq(memoryFacts.userId, userId),
             isNull(memoryFacts.validTo) // Seulement faits actifs
           )
         );

       // Filtre temporel
       if (dateRange) {
         queryBuilder = queryBuilder.where(
           and(
             gte(memoryFacts.validFrom, dateRange.start),
             lte(memoryFacts.validFrom, dateRange.end)
           )
         );
       }

       // Similarity search
       const results = await queryBuilder
         .orderBy(
           sql`1 - (embedding <=> ${queryEmbedding}::vector)`
         )
         .limit(10);

       return results.map(r => ({
         fact: {
           id: r.id,
           subject: r.subject,
           predicate: r.predicate,
           object: r.object,
           metadata: r.metadata,
         },
         relevance: 1 - (r.embedding <=> queryEmbedding), // Calculer similarity
       }));
     }

     async indexFromDataPod(
       userId: string,
       dataPodData: {
         knowledge_facts?: Array<{
           subject: string;
           predicate: string;
           object: string;
           createdAt: string;
         }>;
       }
     ) {
       for (const fact of dataPodData.knowledge_facts || []) {
         await this.addFact(userId, {
           subject: fact.subject,
           predicate: fact.predicate,
           object: fact.object,
           validFrom: new Date(fact.createdAt),
         });
       }
     }
   }
   ```

3. **Intégrer dans KnowledgeSynthesizer**
   - Utiliser MemoryLayer dans l'agent
   - Indexer automatiquement depuis Data Pod

**Livrables :**
- ✅ Schéma PostgreSQL pour Memory
- ✅ MemoryLayer Service
- ✅ Recherche temporelle
- ✅ Recherche vectorielle
- ✅ Indexation depuis Data Pod

**Critères de succès :**
- Memory Layer peut stocker des faits
- Memory Layer peut rechercher temporellement
- Memory Layer peut rechercher par similarité
- Performance acceptable (<500ms pour recherche)

---

## 🔮 Phase 3 : IA Proactive (Semaines 6-7)

### Little Win 3.1 : Inngest Workflows + TensorFlow.js (Semaine 6)

**Objectif :** Créer les workflows Inngest pour détecter des patterns et générer des insights proactifs.

**Tâches :**

1. **Créer modèle TensorFlow.js pour Anomaly Detection**
   ```typescript
   // packages/intelligence-hub/src/models/anomaly-detector.ts
   import * as tf from '@tensorflow/tfjs-node';

   export class AnomalyDetector {
     private model: tf.LayersModel | null = null;

     async loadModel() {
       // Charger modèle pré-entraîné ou créer modèle simple
       this.model = await tf.loadLayersModel('file://./models/anomaly-detector/model.json');
     }

     async detectAnomaly(events: Array<{
       actionType: string;
       timestamp: Date;
     }>): Promise<{ isAnomaly: boolean; score: number }> {
       if (!this.model) {
         await this.loadModel();
       }

       const features = this.prepareFeatures(events);
       const prediction = this.model!.predict(features) as tf.Tensor;
       const score = await prediction.data();

       return {
         isAnomaly: score[0] > 0.7,
         score: score[0],
       };
     }

     private prepareFeatures(events: any[]): tf.Tensor {
       // Convertir événements en features numériques
       const features = events.map(e => [
         this.encodeActionType(e.actionType),
         e.timestamp.getTime() / 1000,
       ]);

       // Padding à 10 événements
       while (features.length < 10) {
         features.push([0, 0]);
       }
       features.splice(10);

       return tf.tensor3d([features], [1, 10, 2]);
     }

     private encodeActionType(actionType: string): number {
       // Simple hash
       return actionType.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 100;
     }
   }
   ```

2. **Créer Inngest Workflow Quotidien**
   ```typescript
   // packages/intelligence-hub/src/functions/daily-pattern-analysis.ts
   import { Inngest } from "inngest";
   import { AnomalyDetector } from '../models/anomaly-detector.js';
   import { MemoryLayer } from '../services/memory-layer.js';
   import { HubProtocolClient } from '../clients/hub-protocol-client.js';

   const inngest = new Inngest({ name: "Synap Proactive Brain" });

   export const dailyPatternAnalysis = inngest.createFunction(
     { id: "daily-pattern-analysis" },
     { cron: "0 8 * * *" }, // Chaque matin 8h
     async ({ step }) => {
       // Step 1: Fetch events depuis TimescaleDB
       const events = await step.run("fetch-events", async () => {
         // Query TimescaleDB pour événements des 7 derniers jours
         return await timescaleDB.query(`
           SELECT user_id, action_type, timestamp, metadata
           FROM user_events
           WHERE timestamp > NOW() - INTERVAL '7 days'
           ORDER BY user_id, timestamp
         `);
       });

       // Step 2: Détecter anomalies avec TensorFlow.js
       const anomalies = await step.run("detect-anomalies", async () => {
         const detector = new AnomalyDetector();
         const results = [];

         for (const userEvents of groupByUser(events)) {
           const { isAnomaly, score } = await detector.detectAnomaly(userEvents);
           
           if (isAnomaly) {
             results.push({
               userId: userEvents[0].user_id,
               anomalyType: detectAnomalyType(userEvents),
               confidence: score,
             });
           }
         }

         return results;
       });

       // Step 3: Générer insights
       const insights = await step.run("generate-insights", async () => {
         // Utiliser LLM pour générer insights personnalisés
         // ...
       });

       // Step 4: Envoyer au Data Pod
       await step.run("push-to-inbox", async () => {
         // Utiliser Hub Protocol pour soumettre insights
         // ...
       });
     }
   );
   ```

**Livrables :**
- ✅ Modèle TensorFlow.js pour Anomaly Detection
- ✅ Inngest Workflow quotidien
- ✅ Détection d'anomalies
- ✅ Génération d'insights

**Critères de succès :**
- Workflow s'exécute quotidiennement
- Détecte anomalies avec 70%+ accuracy
- Génère insights pertinents
- Soumet insights au Data Pod

---

### Little Win 3.2 : Premier Insight Proactif (Semaine 7)

**Objectif :** Générer et envoyer le premier insight proactif fonctionnel.

**Tâches :**

1. **Créer Pattern Detector**
   ```typescript
   // packages/intelligence-hub/src/services/pattern-detector.ts
   export class PatternDetector {
     async detectPatterns(events: Array<{
       actionType: string;
       timestamp: Date;
       metadata: Record<string, unknown>;
     }>): Promise<Array<{
       pattern: string;
       confidence: number;
       description: string;
     }>> {
       // Détecter patterns simples:
       // - Tâches créées mais jamais ouvertes
       // - Tâches oubliées le vendredi
       // - Patterns de productivité
       
       const patterns = [];
       
       // Pattern: Tâches oubliées
       const forgottenTasks = this.detectForgottenTasks(events);
       if (forgottenTasks.length > 0) {
         patterns.push({
           pattern: 'forgotten_tasks',
           confidence: 0.8,
           description: `Vous avez ${forgottenTasks.length} tâches créées mais jamais ouvertes`,
         });
       }
       
       return patterns;
     }

     private detectForgottenTasks(events: any[]): any[] {
       // Logique de détection
       return [];
     }
   }
   ```

2. **Créer Insight Generator**
   ```typescript
   // packages/intelligence-hub/src/services/insight-generator.ts
   import { ChatOpenAI } from "@langchain/openai";

   export class InsightGenerator {
     private llm = new ChatOpenAI({
       modelName: "gpt-4o-mini",
       temperature: 0.7,
     });

     async generateInsight(
       pattern: {
         pattern: string;
         confidence: number;
         description: string;
       },
       context: Record<string, unknown>
     ) {
       const prompt = `
         Pattern détecté: ${pattern.description}
         Contexte: ${JSON.stringify(context)}
        
         Génère une suggestion proactive et actionnable pour l'utilisateur.
       `;

       const response = await this.llm.invoke(prompt);
       
       return {
         version: '1.0',
         type: 'suggestion',
         correlationId: randomUUID(),
         analysis: {
           title: 'Suggestion Proactive',
           content: response.content,
         },
         confidence: pattern.confidence,
       };
     }
   }
   ```

3. **Intégrer dans Inngest Workflow**
   - Utiliser PatternDetector
   - Utiliser InsightGenerator
   - Soumettre via Hub Protocol

**Livrables :**
- ✅ Pattern Detector
- ✅ Insight Generator
- ✅ Premier insight proactif fonctionnel
- ✅ Tests end-to-end

**Critères de succès :**
- Génère 2-3 insights pertinents par semaine
- Insights sont actionnables
- Insights sont soumis au Data Pod
- User voit insights dans Inbox IA

---

## 🎨 Phase 4 : Optimisations (Semaine 8)

### Little Win 4.1 : Tests, Documentation, Polish

**Objectif :** Finaliser le MVP avec tests complets, documentation, et optimisations.

**Tâches :**

1. **Tests E2E**
   - Tests complets du flux Data Pod → Hub → Data Pod
   - Tests de performance
   - Tests de charge

2. **Documentation**
   - README complet
   - Guide d'utilisation
   - Architecture documentation

3. **Optimisations**
   - Caching
   - Performance tuning
   - Error handling amélioré

4. **Monitoring**
   - Logging structuré
   - Métriques
   - Alertes

**Livrables :**
- ✅ Tests E2E complets
- ✅ Documentation complète
- ✅ Optimisations de performance
- ✅ Monitoring en place

**Critères de succès :**
- 100% de couverture de tests
- Documentation à jour
- Performance <2s pour requêtes simples
- Monitoring fonctionnel

---

## 📊 Métriques de Succès

### Métriques Techniques

- **Latency** : <2s pour requête simple, <5s pour requête complexe
- **Uptime** : >99% (pour MVP)
- **Accuracy** : 95%+ pour ActionExtractor, 80%+ pour KnowledgeSynthesizer
- **Coverage** : 100% de tests unitaires, 80%+ de tests E2E

### Métriques Business

- **Adoption** : 10+ utilisateurs beta testent le Hub
- **Engagement** : 2-3 insights proactifs par semaine par utilisateur
- **Satisfaction** : 70%+ des insights jugés utiles

---

## 🚀 Prochaines Étapes (Post-MVP)

### Phase 5 : Agents Avancés (Futur)
- Agent ProjectPlanner avec pattern Supervisor
- Multi-agent coordination
- Agents spécialisés (research, creative, etc.)

### Phase 6 : Super Memory Avancée (Futur)
- Évaluer migration vers Mem0 (si performances insuffisantes)
- Temporal reasoning avancé
- Multi-hop queries

### Phase 7 : Marketplace (Futur)
- Ory Hydra pour agents tiers
- Registry service
- Sandboxing

---

## 📝 Notes Importantes

### Décisions Architecturales

1. **Mem0** : Commencé avec PostgreSQL temporal, évaluer Mem0 plus tard
2. **Ory** : Gardé Better Auth + API Keys, ajouter Ory uniquement pour marketplace
3. **TensorFlow.js** : Utilisé pour MVP, migrer vers Python service si patterns complexes

### Risques Identifiés

1. **Complexité LangGraph** : Courbe d'apprentissage, nécessite formation équipe
2. **Performance Memory Layer** : PostgreSQL temporal peut être limité à grande échelle
3. **TensorFlow.js Limitations** : Moins puissant que Python pour ML avancé

### Mitigations

1. **Formation** : Documentation complète, exemples de code
2. **Monitoring** : Surveiller performances, migrer vers Mem0 si nécessaire
3. **Évolutivité** : Architecture extensible, migration vers Python possible

---

## ✅ Checklist de Démarrage

Avant de commencer :

- [ ] Valider ce plan avec l'équipe
- [ ] Créer repository pour Intelligence Hub (ou package dans monorepo)
- [ ] Configurer environnement de développement
- [ ] Installer dependencies (LangGraph, TensorFlow.js, etc.)
- [ ] Configurer accès aux APIs (OpenAI, Anthropic)
- [ ] Configurer accès à la base de données
- [ ] Configurer Inngest

---

**Prochaine étape** : Commencer Phase 1, Little Win 1.1 - Structure du Package Intelligence Hub

