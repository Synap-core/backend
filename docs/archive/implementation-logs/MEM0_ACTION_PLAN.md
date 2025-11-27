# Plan d'Action : Installation et Intégration Mem0

**Version :** 1.0  
**Date :** 2025-01-20  
**Statut :** Plan d'Action - En Attente de Validation  
**Objectif :** Déployer Mem0 (Super Memory) et créer l'interface d'intégration pour l'Intelligence Hub

---

## 📋 Table des Matières

1. [Vue d'Ensemble](#vue-densemble)
2. [Architecture Cible](#architecture-cible)
3. [Fichiers à Créer](#fichiers-à-créer)
4. [Fichiers à Modifier](#fichiers-à-modifier)
5. [Fichiers à Supprimer](#fichiers-à-supprimer)
6. [Roadmap d'Implémentation](#roadmap-dimplémentation)
7. [Tests et Validation](#tests-et-validation)
8. [Risques et Mitigations](#risques-et-mitigations)

---

## 1. Vue d'Ensemble

### 1.1. Objectif

Déployer **Mem0** (Super Memory System) en mode auto-hébergé et créer l'interface d'intégration TypeScript pour l'Intelligence Hub.

### 1.2. Scope

**Inclus :**
- Déploiement Mem0 via Docker
- Service `MemoryLayer` (abstraction TypeScript)
- Tool LangGraph pour agents
- Configuration et variables d'environnement
- Documentation

**Exclus (pour l'instant) :**
- Worker d'indexation depuis Data Pod (Phase suivante)
- Intégration complète avec agents (Phase suivante)
- Monitoring avancé (Phase suivante)

### 1.3. Approche

**Clean Slate :** Pas de migration nécessaire, installation nouvelle.

---

## 2. Architecture Cible

### 2.1. Architecture Globale

```
┌─────────────────────────────────────────────────────────┐
│  Intelligence Hub (Futur Package)                       │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  LangGraph Agents                                │  │
│  │  - ActionExtractor                               │  │
│  │  - KnowledgeSynthesizer                          │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
│  ┌──────────────▼───────────────────────────────────┐  │
│  │  MemoryLayer Service                             │  │
│  │  - Wrapper REST API Mem0                         │  │
│  │  - Abstraction TypeScript                        │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
│  ┌──────────────▼───────────────────────────────────┐  │
│  │  Mem0MemoryTool (LangGraph)                      │  │
│  │  - Tool pour agents                              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                 │
                 │ HTTP REST API
                 │
┌────────────────▼─────────────────────────────────────────┐
│  Mem0 Service (Docker)                                    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Mem0 API Server (Python/FastAPI)                │  │
│  │  - Port: 8765                                    │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
│  ┌──────────────▼───────────────────────────────────┐  │
│  │  PostgreSQL + pgvector                          │  │
│  │  - Stockage mémoires                             │  │
│  │  - Vector embeddings                              │  │
│  │  - Graphe temporel                               │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 2.2. Flux de Données

**Ajout de Mémoire :**
```
Agent → MemoryLayer.addMemory() → Mem0 API → PostgreSQL
```

**Recherche :**
```
Agent → MemoryLayer.searchMemory() → Mem0 API → PostgreSQL → Résultats
```

---

## 3. Fichiers à Créer

### 3.1. Infrastructure Docker

#### **`docker-compose.yml`** (Modification)

**Ajouter service Mem0 :**

```yaml
  # PostgreSQL for Mem0 (separate from main postgres)
  postgres-mem0:
    image: postgres:15-alpine
    container_name: synap-postgres-mem0
    restart: unless-stopped
    environment:
      POSTGRES_DB: mem0
      POSTGRES_USER: mem0
      POSTGRES_PASSWORD: ${MEM0_DB_PASSWORD:-mem0_dev_password}
    ports:
      - "5434:5432"
    volumes:
      - mem0_db_data:/var/lib/postgresql/data
      - ./scripts/init-mem0-extensions.sql:/docker-entrypoint-initdb.d/01-init-extensions.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mem0"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - synap-network

  # Mem0 - Super Memory System
  mem0:
    image: mem0ai/mem0:latest  # Ou build depuis source
    container_name: synap-mem0
    restart: unless-stopped
    ports:
      - "8765:8765"  # API Server
    environment:
      - MEM0_DATABASE_URL=postgresql://mem0:${MEM0_DB_PASSWORD:-mem0_dev_password}@postgres-mem0:5432/mem0?sslmode=disable
      - MEM0_API_KEY=${MEM0_API_KEY:-change-me-in-production}
      - OPENAI_API_KEY=${OPENAI_API_KEY}  # Pour embeddings
      - MEM0_LOG_LEVEL=${MEM0_LOG_LEVEL:-info}
    depends_on:
      postgres-mem0:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8765/health"]
      interval: 30s
      timeout: 10s
      retries: 5
    networks:
      - synap-network
```

**Ajouter volume :**
```yaml
volumes:
  # ... existing volumes
  mem0_db_data:
    driver: local
```

#### **`scripts/init-mem0-extensions.sql`** ✨ CRÉER

```sql
-- Enable pgvector extension for Mem0
CREATE EXTENSION IF NOT EXISTS vector;

-- Mem0 will create its own tables
```

### 3.2. Package Intelligence Hub (Structure de Base)

**Note :** Le package `@synap/intelligence-hub` n'existe pas encore. Nous créons la structure minimale pour Mem0.

#### **`packages/intelligence-hub/package.json`** ✨ CRÉER

```json
{
  "name": "@synap/intelligence-hub",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest"
  },
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    "@synap/types": "workspace:*",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.3.3",
    "vitest": "^4.0.7"
  }
}
```

#### **`packages/intelligence-hub/tsconfig.json`** ✨ CRÉER

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### **`packages/intelligence-hub/src/index.ts`** ✨ CRÉER

```typescript
/**
 * Intelligence Hub Package
 * 
 * Provides services and tools for the Intelligence Hub
 */

export * from './services/memory-layer.js';
export * from './tools/mem0-tool.js';
export * from './types/index.js';
```

#### **`packages/intelligence-hub/src/types/index.ts`** ✨ CRÉER

```typescript
/**
 * Type definitions for Intelligence Hub
 */

export interface Memory {
  id: string;
  user_id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Fact {
  subject: string;
  predicate: string;
  object: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  searchType?: 'temporal' | 'hybrid' | 'vector';
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  vectorSimilarity?: number;
  graphDepth?: number;
}

export interface SearchResult {
  fact?: Fact;
  memory?: Memory;
  relevance: number;
  score: number;
}
```

#### **`packages/intelligence-hub/src/services/memory-layer.ts`** ✨ CRÉER

```typescript
/**
 * MemoryLayer Service
 * 
 * Abstraction TypeScript around Mem0 REST API
 */

import type { Memory, Fact, SearchOptions, SearchResult } from '../types/index.js';

export class MemoryLayer {
  private apiUrl: string;
  private apiKey: string;

  constructor() {
    this.apiUrl = process.env.MEM0_API_URL || 'http://localhost:8765';
    this.apiKey = process.env.MEM0_API_KEY || '';
    
    if (!this.apiKey) {
      throw new Error('MEM0_API_KEY environment variable is required');
    }
  }

  /**
   * Add a memory
   */
  async addMemory(
    userId: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<Memory> {
    const response = await fetch(`${this.apiUrl}/api/v1/memories`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        user_id: userId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Mem0 API error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Search memories
   */
  async searchMemory(
    userId: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const response = await fetch(`${this.apiUrl}/api/v1/memories/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        text: query,
        search_type: options?.searchType || 'hybrid',
        limit: options?.limit || 10,
        ...(options?.dateRange && {
          start_date: options.dateRange.start,
          end_date: options.dateRange.end,
        }),
        ...(options?.vectorSimilarity && {
          vector_similarity: options.vectorSimilarity,
        }),
        ...(options?.graphDepth && {
          graph_depth: options.graphDepth,
        }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Mem0 API error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Add a structured fact
   */
  async addFact(userId: string, fact: Fact): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/v1/facts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        fact,
      }),
    });

    if (!response.ok) {
      throw new Error(`Mem0 API error: ${response.statusText}`);
    }
  }

  /**
   * Search facts (temporal)
   */
  async searchFacts(
    userId: string,
    query: string,
    dateRange?: { start: string; end: string }
  ): Promise<SearchResult[]> {
    const response = await fetch(`${this.apiUrl}/api/v1/facts/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        text: query,
        ...(dateRange && {
          start_date: dateRange.start,
          end_date: dateRange.end,
        }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Mem0 API error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Delete a memory
   */
  async deleteMemory(userId: string, memoryId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/v1/memories/${memoryId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Mem0 API error: ${response.statusText}`);
    }
  }
}

// Singleton instance
export const memoryLayer = new MemoryLayer();
```

#### **`packages/intelligence-hub/src/tools/mem0-tool.ts`** ✨ CRÉER

```typescript
/**
 * Mem0 Memory Tool for LangGraph
 * 
 * Tool that allows LangGraph agents to search Mem0
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { memoryLayer } from '../services/memory-layer.js';

export const Mem0MemoryTool = new DynamicStructuredTool({
  name: "mem0_search",
  description: "Recherche dans la Super Memory (Mem0) pour trouver des faits, préférences, ou décisions passées de l'utilisateur",
  schema: z.object({
    userId: z.string().describe("ID de l'utilisateur"),
    query: z.string().describe("Question ou recherche à effectuer"),
    searchType: z.enum(["temporal", "hybrid", "vector"]).default("hybrid").describe("Type de recherche"),
    dateRange: z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
    }).optional().describe("Plage de dates pour recherche temporelle"),
    limit: z.number().int().min(1).max(50).default(10).describe("Nombre maximum de résultats"),
  }),
  func: async ({ userId, query, searchType, dateRange, limit }) => {
    try {
      const results = await memoryLayer.searchMemory(
        userId,
        query,
        {
          searchType,
          dateRange: dateRange ? {
            start: dateRange.start,
            end: dateRange.end,
          } : undefined,
          limit,
        }
      );

      return JSON.stringify({
        results: results.map(r => ({
          fact: r.fact,
          memory: r.memory,
          relevance: r.relevance,
          score: r.score,
        })),
        count: results.length,
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
        results: [],
        count: 0,
      });
    }
  },
});
```

#### **`packages/intelligence-hub/README.md`** ✨ CRÉER

```markdown
# @synap/intelligence-hub

Intelligence Hub package for Synap.

## Services

- `MemoryLayer` - Abstraction around Mem0 API

## Tools

- `Mem0MemoryTool` - LangGraph tool for Mem0 search

## Usage

```typescript
import { memoryLayer } from '@synap/intelligence-hub';

// Add memory
await memoryLayer.addMemory('user-123', [
  { role: 'user', content: 'I work on Synap project' },
]);

// Search
const results = await memoryLayer.searchMemory(
  'user-123',
  'What are my projects?'
);
```
```

### 3.3. Configuration

#### **`env.example`** (Modification)

**Ajouter variables Mem0 :**

```env
# Mem0 - Super Memory System
MEM0_API_URL=http://localhost:8765
MEM0_API_KEY=change-me-in-production
MEM0_DB_PASSWORD=mem0_dev_password
MEM0_LOG_LEVEL=info
```

#### **`env.production.example`** (Modification)

**Ajouter variables Mem0 :**

```env
# Mem0 - Super Memory System
MEM0_API_URL=https://mem0.yourdomain.com
MEM0_API_KEY=your-secure-api-key-here  # Generate: openssl rand -base64 32
MEM0_DB_PASSWORD=your-secure-db-password
MEM0_LOG_LEVEL=info
```

#### **`packages/core/src/config.ts`** (Modification)

**Ajouter validation Mem0 :**

```typescript
const Mem0ConfigSchema = z.object({
  apiUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dbPassword: z.string().optional(),
  logLevel: z.string().optional(),
});

// Dans loadConfig()
mem0: {
  apiUrl: process.env.MEM0_API_URL,
  apiKey: process.env.MEM0_API_KEY,
  dbPassword: process.env.MEM0_DB_PASSWORD,
  logLevel: process.env.MEM0_LOG_LEVEL,
},

// Dans validateConfig()
case 'mem0':
  if (!config.mem0.apiKey) {
    throw new Error('Mem0 requires MEM0_API_KEY environment variable');
  }
  break;
```

---

## 4. Fichiers à Modifier

### 4.1. Infrastructure

1. **`docker-compose.yml`** ✏️ MODIFIER
   - Ajouter service `postgres-mem0`
   - Ajouter service `mem0`
   - Ajouter volume `mem0_db_data`

### 4.2. Configuration

2. **`env.example`** ✏️ MODIFIER
   - Ajouter variables Mem0

3. **`env.production.example`** ✏️ MODIFIER
   - Ajouter variables Mem0

4. **`packages/core/src/config.ts`** ✏️ MODIFIER
   - Ajouter `Mem0ConfigSchema`
   - Ajouter validation `mem0`

### 4.3. Workspace

5. **`pnpm-workspace.yaml`** ✏️ MODIFIER (si nécessaire)
   - S'assurer que `packages/intelligence-hub` est inclus

---

## 5. Fichiers à Supprimer

**Aucun fichier à supprimer** (installation nouvelle).

---

## 6. Roadmap d'Implémentation

### Phase 1 : Infrastructure Mem0 (Jour 1-2)

**Objectif :** Déployer Mem0 en Docker

#### **Jour 1 : Docker Setup**

- [ ] Créer `scripts/init-mem0-extensions.sql`
- [ ] Modifier `docker-compose.yml`
  - [ ] Ajouter service `postgres-mem0`
  - [ ] Ajouter service `mem0`
  - [ ] Ajouter volume `mem0_db_data`
- [ ] Tester déploiement local
  ```bash
  docker compose up -d postgres-mem0 mem0
  ```

#### **Jour 2 : Configuration et Tests**

- [ ] Modifier `env.example` (variables Mem0)
- [ ] Modifier `env.production.example` (variables Mem0)
- [ ] Générer `MEM0_API_KEY` sécurisé
- [ ] Tester API Mem0
  ```bash
  curl http://localhost:8765/health
  curl -X POST http://localhost:8765/api/v1/memories \
    -H "Authorization: Bearer ${MEM0_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"messages": [{"role": "user", "content": "test"}], "user_id": "test"}'
  ```

**Livrables :**
- ✅ Mem0 déployé et fonctionnel
- ✅ Variables d'environnement configurées
- ✅ Tests API réussis

---

### Phase 2 : Service Layer (Jour 3-4)

**Objectif :** Créer l'interface TypeScript

#### **Jour 3 : Structure Package**

- [ ] Créer `packages/intelligence-hub/`
- [ ] Créer `package.json`
- [ ] Créer `tsconfig.json`
- [ ] Créer `src/index.ts`
- [ ] Créer `src/types/index.ts`
- [ ] Installer dependencies
  ```bash
  cd packages/intelligence-hub
  pnpm install
  ```

#### **Jour 4 : Service MemoryLayer**

- [ ] Créer `src/services/memory-layer.ts`
- [ ] Implémenter `addMemory()`
- [ ] Implémenter `searchMemory()`
- [ ] Implémenter `addFact()`
- [ ] Implémenter `searchFacts()`
- [ ] Implémenter `deleteMemory()`
- [ ] Tests unitaires basiques

**Livrables :**
- ✅ Package `@synap/intelligence-hub` créé
- ✅ Service `MemoryLayer` fonctionnel
- ✅ Tests unitaires

---

### Phase 3 : Tool LangGraph (Jour 5)

**Objectif :** Créer le tool pour agents LangGraph

#### **Jour 5 : Mem0MemoryTool**

- [ ] Créer `src/tools/mem0-tool.ts`
- [ ] Implémenter tool avec schema Zod
- [ ] Tester avec agent LangGraph simple
- [ ] Documentation

**Livrables :**
- ✅ `Mem0MemoryTool` fonctionnel
- ✅ Tests d'intégration
- ✅ Documentation

---

### Phase 4 : Configuration et Documentation (Jour 6)

**Objectif :** Finaliser configuration et documentation

#### **Jour 6 : Finalisation**

- [ ] Modifier `packages/core/src/config.ts`
  - [ ] Ajouter `Mem0ConfigSchema`
  - [ ] Ajouter validation
- [ ] Créer `packages/intelligence-hub/README.md`
- [ ] Créer documentation d'utilisation
- [ ] Tests end-to-end
- [ ] Validation complète

**Livrables :**
- ✅ Configuration complète
- ✅ Documentation complète
- ✅ Tests E2E réussis

---

## 7. Tests et Validation

### 7.1. Tests Infrastructure

**Test 1 : Health Check**
```bash
curl http://localhost:8765/health
# Expected: {"status": "ok"}
```

**Test 2 : API Authentication**
```bash
curl -X POST http://localhost:8765/api/v1/memories \
  -H "Authorization: Bearer ${MEM0_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "test"}], "user_id": "test"}'
# Expected: Memory object with ID
```

### 7.2. Tests Service Layer

**Test 3 : MemoryLayer.addMemory()**
```typescript
import { memoryLayer } from '@synap/intelligence-hub';

const memory = await memoryLayer.addMemory('user-123', [
  { role: 'user', content: 'I work on Synap' },
]);
// Expected: Memory object
```

**Test 4 : MemoryLayer.searchMemory()**
```typescript
const results = await memoryLayer.searchMemory(
  'user-123',
  'What are my projects?'
);
// Expected: Array of SearchResult
```

### 7.3. Tests Tool LangGraph

**Test 5 : Mem0MemoryTool**
```typescript
import { Mem0MemoryTool } from '@synap/intelligence-hub';

const result = await Mem0MemoryTool.invoke({
  userId: 'user-123',
  query: 'What do I know?',
  searchType: 'hybrid',
});
// Expected: JSON string with results
```

---

## 8. Risques et Mitigations

| Risque | Impact | Probabilité | Mitigation |
|:---|:---|:---|:---|
| **Service Python à maintenir** | Moyen | Élevée | Docker + monitoring, documentation complète |
| **Image Docker Mem0 non disponible** | Élevé | Faible | Build depuis source, fallback PostgreSQL temporal |
| **Performance insuffisante** | Faible | Faible | Benchmarks avant déploiement, cache |
| **API Mem0 change** | Moyen | Faible | Versionner API, tests d'intégration |
| **Coût embeddings OpenAI** | Faible | Moyenne | Cache, batch processing, modèle local optionnel |

---

## 9. Checklist Finale

### Infrastructure
- [ ] Mem0 déployé en Docker
- [ ] PostgreSQL + pgvector configuré
- [ ] Health checks fonctionnels
- [ ] Variables d'environnement configurées

### Code
- [ ] Package `@synap/intelligence-hub` créé
- [ ] Service `MemoryLayer` implémenté
- [ ] Tool `Mem0MemoryTool` créé
- [ ] Configuration ajoutée

### Tests
- [ ] Tests infrastructure
- [ ] Tests service layer
- [ ] Tests tool LangGraph
- [ ] Tests E2E

### Documentation
- [ ] README package
- [ ] Documentation d'utilisation
- [ ] Guide de déploiement

---

## 10. Prochaines Étapes (Post-Installation)

1. **Worker d'Indexation** : Créer worker Inngest pour indexer données Data Pod
2. **Intégration Agents** : Intégrer Mem0 dans agents LangGraph
3. **Monitoring** : Ajouter métriques et alertes
4. **Optimisation** : Cache, batch processing, etc.

---

**Prochaine étape :** Valider ce plan, puis commencer Phase 1 (Infrastructure Mem0).

