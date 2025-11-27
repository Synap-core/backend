# Plan Détaillé de Refactoring - Hub Protocol Réutilisable

**Date :** 2025-01-20  
**Statut :** ⏳ **En attente d'approbation**

---

## 🎯 Objectif

Rendre le Hub Protocol **100% réutilisable** pour n'importe quel Hub (notre Intelligence Hub ou un Hub tiers), tout en gardant notre Intelligence Hub comme solution propriétaire avec ses fonctionnalités spécifiques.

---

## 📊 Analyse du Code Actuel

### Fichiers à Analyser

| Fichier | Lignes | Réutilisabilité | Action |
|---------|--------|----------------|--------|
| `packages/intelligence-hub/src/clients/hub-protocol-client.ts` | ~150 | ✅ 90% | ⚠️ Extraire vers `@synap/hub-protocol-client` |
| `packages/intelligence-hub/src/services/hub-orchestrator.ts` | ~200 | ⚠️ 50% | ⚠️ Extraire interface vers `@synap/hub-orchestrator-base` |
| `packages/intelligence-hub/src/agents/action-extractor.ts` | ~150 | ❌ 0% | ✅ Garder (spécifique) |
| `apps/intelligence-hub/src/index.ts` | ~150 | ❌ 0% | ✅ Garder (spécifique) |
| `apps/intelligence-hub/src/routers/expertise.ts` | ~100 | ❌ 0% | ✅ Garder (spécifique) |

---

## 🏗️ Architecture Cible

### Packages à Créer

#### 1. `@synap/hub-protocol-client` ⚠️ **À CRÉER**

**Rôle :** Client tRPC réutilisable pour communiquer avec un Data Pod

**Contenu :**
- `HubProtocolClient` (classe)
- Types : `HubScope`, `HubClientConfig`
- Méthodes : `generateAccessToken()`, `requestData()`, `submitInsight()`

**Dépendances :**
- `@synap/hub-protocol` (schémas)
- `@synap/api` (AppRouter type)
- `@trpc/client`

**Réutilisabilité :** ✅ **100%** - Tout Hub peut l'utiliser

---

#### 2. `@synap/hub-orchestrator-base` ⚠️ **À CRÉER**

**Rôle :** Interface/pattern d'orchestration réutilisable

**Contenu :**
- Interface `HubOrchestratorInterface`
- Classe abstraite `HubOrchestratorBase`
- Types : `ExpertiseRequest`, `ExpertiseResponse`
- Erreurs : `HubOrchestratorError`

**Dépendances :**
- `@synap/hub-protocol` (types)
- `@synap/hub-protocol-client` (client)

**Réutilisabilité :** ✅ **100%** - Tout Hub peut l'étendre

---

### Packages à Garder (Spécifiques)

#### 3. `@synap/intelligence-hub` ✅ **GARDER**

**Rôle :** Implémentation spécifique de notre Intelligence Hub

**Contenu :**
- `SynapHubOrchestrator` (étend `HubOrchestratorBase`)
- Agents LangGraph (ActionExtractor, etc.)
- Services spécifiques (MemoryLayer, etc.)

**Dépendances :**
- `@synap/hub-protocol-client` (utilise)
- `@synap/hub-orchestrator-base` (étend)
- `@synap/hub-protocol` (utilise)

**Réutilisabilité :** ❌ **0%** - Spécifique à notre Hub

---

#### 4. `apps/intelligence-hub` ✅ **GARDER**

**Rôle :** Serveur Hono de notre Intelligence Hub

**Contenu :**
- Serveur Hono
- Endpoints API (`/api/expertise/request`)
- Authentification OAuth2 (notre instance Ory)
- Middleware de sécurité

**Dépendances :**
- `@synap/intelligence-hub` (utilise)

**Réutilisabilité :** ❌ **0%** - Spécifique à notre Hub

---

## 📋 Plan d'Action Détaillé

### Phase 1 : Créer `@synap/hub-protocol-client`

#### Étape 1.1 : Créer la structure

```bash
mkdir -p packages/hub-protocol-client/src
cd packages/hub-protocol-client
```

**Fichiers à créer :**
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/client.ts`
- `src/types.ts`
- `README.md`

#### Étape 1.2 : Créer `package.json`

```json
{
  "name": "@synap/hub-protocol-client",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    "@synap/api": "workspace:*",
    "@trpc/client": "^11.7.1"
  },
  "devDependencies": {
    "typescript": "^5.3.3"
  }
}
```

#### Étape 1.3 : Déplacer le code

**Source :** `packages/intelligence-hub/src/clients/hub-protocol-client.ts`

**Destination :** `packages/hub-protocol-client/src/client.ts`

**Modifications :**
- Extraire types vers `types.ts`
- Mettre à jour imports
- Exporter depuis `index.ts`

#### Étape 1.4 : Créer `types.ts`

```typescript
export type HubScope = 
  | 'preferences'
  | 'calendar'
  | 'notes'
  | 'tasks'
  | 'projects'
  | 'conversations'
  | 'entities'
  | 'knowledge_facts';

export interface HubClientConfig {
  dataPodUrl: string;
  token: string; // User session token for initial auth
}
```

#### Étape 1.5 : Mettre à jour Intelligence Hub

**Fichier :** `packages/intelligence-hub/package.json`

```json
{
  "dependencies": {
    "@synap/hub-protocol-client": "workspace:*",
    // ... autres dépendances
  }
}
```

**Fichier :** `packages/intelligence-hub/src/services/hub-orchestrator.ts`

```typescript
// Avant
import { HubProtocolClient } from '../clients/hub-protocol-client.js';

// Après
import { HubProtocolClient } from '@synap/hub-protocol-client';
```

#### Étape 1.6 : Supprimer ancien fichier

```bash
rm packages/intelligence-hub/src/clients/hub-protocol-client.ts
rm -rf packages/intelligence-hub/src/clients/
```

---

### Phase 2 : Créer `@synap/hub-orchestrator-base`

#### Étape 2.1 : Créer la structure

```bash
mkdir -p packages/hub-orchestrator-base/src
cd packages/hub-orchestrator-base
```

**Fichiers à créer :**
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/types.ts`
- `src/base.ts`
- `src/errors.ts`
- `README.md`

#### Étape 2.2 : Créer `package.json`

```json
{
  "name": "@synap/hub-orchestrator-base",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    "@synap/hub-protocol-client": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.3.3"
  }
}
```

#### Étape 2.3 : Créer `types.ts`

```typescript
import type { HubInsight } from '@synap/hub-protocol';

export interface ExpertiseRequest {
  requestId: string;
  userId: string;
  dataPodUrl: string;
  query: string;
  agentId?: string;
  context?: Record<string, unknown>;
}

export interface ExpertiseResponse {
  requestId: string;
  status: 'completed' | 'failed';
  insight?: HubInsight;
  error?: string;
}
```

#### Étape 2.4 : Créer `base.ts`

```typescript
import type { ExpertiseRequest, ExpertiseResponse } from './types.js';

export abstract class HubOrchestratorBase {
  abstract executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse>;
}
```

#### Étape 2.5 : Mettre à jour Intelligence Hub

**Fichier :** `packages/intelligence-hub/src/services/hub-orchestrator.ts`

```typescript
import { HubOrchestratorBase, type ExpertiseRequest, type ExpertiseResponse } from '@synap/hub-orchestrator-base';

export class SynapHubOrchestrator extends HubOrchestratorBase {
  // Implémentation existante
  async executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse> {
    // Code existant
  }
}
```

---

### Phase 3 : Mettre à Jour Intelligence Hub

#### Étape 3.1 : Mettre à jour `package.json`

```json
{
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    "@synap/hub-protocol-client": "workspace:*",
    "@synap/hub-orchestrator-base": "workspace:*"
  }
}
```

#### Étape 3.2 : Mettre à jour exports

**Fichier :** `packages/intelligence-hub/src/index.ts`

```typescript
// Avant
export * from './clients/hub-protocol-client.js';
export * from './services/hub-orchestrator.js';

// Après
export * from './services/hub-orchestrator.js'; // SynapHubOrchestrator
// HubProtocolClient maintenant dans @synap/hub-protocol-client
```

#### Étape 3.3 : Mettre à jour imports dans `apps/intelligence-hub/`

**Fichier :** `apps/intelligence-hub/src/routers/expertise.ts`

```typescript
// Avant
import { HubOrchestrator } from '@synap/intelligence-hub';

// Après (si nécessaire)
import { SynapHubOrchestrator } from '@synap/intelligence-hub';
```

---

### Phase 4 : Tests et Validation

#### Étape 4.1 : Tests pour `@synap/hub-protocol-client`

**Fichier :** `packages/hub-protocol-client/src/__tests__/client.test.ts`

- Copier depuis `packages/intelligence-hub/src/clients/__tests__/hub-protocol-client.test.ts`
- Mettre à jour imports

#### Étape 4.2 : Tests pour `@synap/hub-orchestrator-base`

**Fichier :** `packages/hub-orchestrator-base/src/__tests__/base.test.ts`

- Tests pour l'interface
- Tests pour la classe abstraite

#### Étape 4.3 : Vérifier Intelligence Hub

- [ ] Compile sans erreur
- [ ] Tests passent
- [ ] E2E tests passent

---

### Phase 5 : Documentation

#### Étape 5.1 : README pour `@synap/hub-protocol-client`

**Contenu :**
- Description
- Installation
- Exemple d'utilisation
- API reference

#### Étape 5.2 : README pour `@synap/hub-orchestrator-base`

**Contenu :**
- Description
- Installation
- Exemple d'implémentation
- API reference

#### Étape 5.3 : Guide pour Hub Tiers

**Fichier :** `docs/development/CREATING_CUSTOM_HUB.md`

**Contenu :**
- Architecture recommandée
- Exemple complet
- Bonnes pratiques

---

## 📊 Impact sur les Fichiers

### Fichiers à Créer

```
packages/hub-protocol-client/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── client.ts
│   └── types.ts
└── README.md

packages/hub-orchestrator-base/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── base.ts
│   └── errors.ts
└── README.md
```

### Fichiers à Modifier

```
packages/intelligence-hub/
├── package.json                    (ajouter dépendances)
├── src/
│   ├── index.ts                    (mettre à jour exports)
│   └── services/
│       └── hub-orchestrator.ts     (étendre HubOrchestratorBase)
└── src/clients/                    (supprimer dossier)

apps/intelligence-hub/
└── src/routers/
    └── expertise.ts                (mettre à jour imports si nécessaire)
```

### Fichiers à Supprimer

```
packages/intelligence-hub/src/clients/
└── hub-protocol-client.ts          (déplacé vers @synap/hub-protocol-client)
```

---

## ✅ Checklist de Validation

### Phase 1 : Hub Protocol Client
- [ ] Package créé
- [ ] Code déplacé et fonctionnel
- [ ] Tests unitaires créés et passent
- [ ] Intelligence Hub utilise le nouveau package
- [ ] Compilation sans erreur

### Phase 2 : Hub Orchestrator Base
- [ ] Package créé
- [ ] Interface définie
- [ ] Classe abstraite créée
- [ ] Intelligence Hub étend la classe
- [ ] Tests passent

### Phase 3 : Mise à Jour Intelligence Hub
- [ ] Imports mis à jour
- [ ] Code compile
- [ ] Tests unitaires passent
- [ ] E2E tests passent

### Phase 4 : Documentation
- [ ] README pour `@synap/hub-protocol-client`
- [ ] README pour `@synap/hub-orchestrator-base`
- [ ] Guide pour Hub tiers
- [ ] Exemples de code

---

## 🚀 Ordre d'Exécution

1. **Phase 1** : Créer `@synap/hub-protocol-client` (2-3h)
2. **Phase 2** : Créer `@synap/hub-orchestrator-base` (2-3h)
3. **Phase 3** : Mettre à jour Intelligence Hub (1-2h)
4. **Phase 4** : Tests et validation (1-2h)
5. **Phase 5** : Documentation (2-3h)

**Total estimé :** 8-13h

---

## 🎯 Résultat Final

### Pour un Hub Tiers

```typescript
import { HubProtocolClient } from '@synap/hub-protocol-client';
import { HubOrchestratorBase, type ExpertiseRequest, type ExpertiseResponse } from '@synap/hub-orchestrator-base';
import { HubInsightSchema } from '@synap/hub-protocol';

class MyCustomHub extends HubOrchestratorBase {
  private client: HubProtocolClient;

  constructor() {
    super();
    this.client = new HubProtocolClient({
      dataPodUrl: 'https://user-datapod.com',
      token: 'user-session-token',
    });
  }

  async executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse> {
    // Implémentation spécifique
  }
}
```

### Pour notre Intelligence Hub

```typescript
import { HubProtocolClient } from '@synap/hub-protocol-client';
import { HubOrchestratorBase } from '@synap/hub-orchestrator-base';
import { SynapHubOrchestrator } from '@synap/intelligence-hub'; // Notre implémentation
```

---

**Document créé le :** 2025-01-20  
**Version :** 1.0.0  
**Statut :** ⏳ **En attente d'approbation**

