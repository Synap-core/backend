# Plan de Refactoring - Hub Protocol Réutilisable

**Date :** 2025-01-20  
**Objectif :** Rendre le Hub Protocol réutilisable pour n'importe quel Hub (propriétaire ou tiers)

---

## 🎯 Objectif Final

Permettre à **n'importe quel Hub** (notre Intelligence Hub ou un Hub tiers) de se connecter à un Data Pod via le Hub Protocol, tout en gardant notre Intelligence Hub comme solution propriétaire avec ses fonctionnalités spécifiques.

---

## 📊 État Actuel

### Packages Existants

| Package | Réutilisabilité | Action |
|---------|----------------|--------|
| `@synap/hub-protocol` | ✅ 100% | ✅ Déjà réutilisable |
| `packages/intelligence-hub/src/clients/hub-protocol-client.ts` | ⚠️ 70% | ⚠️ À extraire |
| `packages/intelligence-hub/src/services/hub-orchestrator.ts` | ⚠️ 50% | ⚠️ À abstraire |
| `apps/intelligence-hub/` | ❌ 0% | ✅ Spécifique (garder) |
| `packages/intelligence-hub/src/agents/` | ❌ 0% | ✅ Spécifique (garder) |

---

## 🏗️ Architecture Cible

### Packages Réutilisables (à créer)

```
@synap/hub-protocol              ✅ Existe
  └─ Schémas Zod, types, validation

@synap/hub-protocol-client        ⚠️ À créer
  └─ Client tRPC Hub → Data Pod
  └─ Méthodes : generateAccessToken, requestData, submitInsight

@synap/hub-orchestrator-base      ⚠️ À créer
  └─ Interface/pattern d'orchestration
  └─ Classe abstraite réutilisable
```

### Packages Spécifiques (notre Intelligence Hub)

```
@synap/intelligence-hub           ✅ Garder
  └─ SynapHubOrchestrator (implémentation)
  └─ Agents LangGraph
  └─ Services spécifiques

apps/intelligence-hub             ✅ Garder
  └─ Serveur Hono
  └─ API endpoints
  └─ Authentification OAuth2
```

---

## 📋 Plan d'Action Détaillé

### Phase 1 : Créer `@synap/hub-protocol-client`

**Objectif :** Extraire le client Hub Protocol en package réutilisable

**Fichiers à créer :**
```
packages/hub-protocol-client/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── client.ts          # HubProtocolClient (déplacé)
│   └── types.ts           # Types (HubScope, etc.)
└── README.md
```

**Actions :**
1. [ ] Créer `packages/hub-protocol-client/`
2. [ ] Copier `packages/intelligence-hub/src/clients/hub-protocol-client.ts` → `packages/hub-protocol-client/src/client.ts`
3. [ ] Extraire types vers `types.ts`
4. [ ] Créer `package.json` avec dépendances :
   - `@synap/hub-protocol`
   - `@synap/api` (pour AppRouter type)
   - `@trpc/client`
5. [ ] Mettre à jour `packages/intelligence-hub/package.json` pour utiliser `@synap/hub-protocol-client`
6. [ ] Mettre à jour imports dans `packages/intelligence-hub/`
7. [ ] Tests unitaires (copier depuis intelligence-hub)

**Dépendances :**
```json
{
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    "@synap/api": "workspace:*",
    "@trpc/client": "^11.7.1"
  }
}
```

---

### Phase 2 : Créer `@synap/hub-orchestrator-base`

**Objectif :** Créer interface/pattern d'orchestration réutilisable

**Fichiers à créer :**
```
packages/hub-orchestrator-base/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts           # Interfaces (ExpertiseRequest, ExpertiseResponse)
│   ├── base.ts            # Classe abstraite HubOrchestratorBase
│   └── errors.ts          # Erreurs spécifiques
└── README.md
```

**Actions :**
1. [ ] Créer `packages/hub-orchestrator-base/`
2. [ ] Extraire types depuis `hub-orchestrator.ts` :
   - `ExpertiseRequest`
   - `ExpertiseResponse`
   - `HubOrchestratorInterface`
3. [ ] Créer classe abstraite `HubOrchestratorBase` :
   ```typescript
   export abstract class HubOrchestratorBase {
     abstract executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse>;
   }
   ```
4. [ ] Créer `package.json` avec dépendances :
   - `@synap/hub-protocol`
   - `@synap/hub-protocol-client`
5. [ ] Mettre à jour `packages/intelligence-hub/src/services/hub-orchestrator.ts` pour étendre `HubOrchestratorBase`
6. [ ] Tests unitaires pour l'interface

**Dépendances :**
```json
{
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    "@synap/hub-protocol-client": "workspace:*"
  }
}
```

---

### Phase 3 : Mettre à Jour Intelligence Hub

**Objectif :** Utiliser les nouveaux packages réutilisables

**Actions :**
1. [ ] Mettre à jour `packages/intelligence-hub/package.json` :
   ```json
   {
     "dependencies": {
       "@synap/hub-protocol": "workspace:*",
       "@synap/hub-protocol-client": "workspace:*",
       "@synap/hub-orchestrator-base": "workspace:*"
     }
   }
   ```
2. [ ] Mettre à jour `packages/intelligence-hub/src/services/hub-orchestrator.ts` :
   ```typescript
   import { HubOrchestratorBase } from '@synap/hub-orchestrator-base';
   
   export class SynapHubOrchestrator extends HubOrchestratorBase {
     // Implémentation spécifique
   }
   ```
3. [ ] Mettre à jour imports dans `apps/intelligence-hub/`
4. [ ] Vérifier que tout compile
5. [ ] Exécuter tests

---

### Phase 4 : Documentation et Exemples

**Objectif :** Documenter l'utilisation pour Hub tiers

**Actions :**
1. [ ] Créer `packages/hub-protocol-client/README.md` avec exemples
2. [ ] Créer `packages/hub-orchestrator-base/README.md` avec exemples
3. [ ] Créer `docs/development/CREATING_CUSTOM_HUB.md` :
   - Guide pour créer un Hub tiers
   - Exemples de code
   - Architecture recommandée
4. [ ] Mettre à jour `EXTENSIBILITY_GUIDE_V1.md` avec section Hub tiers

---

## 📁 Structure Finale

### Packages Réutilisables

```
packages/
├── hub-protocol/              ✅ Existe
│   └── Schémas, types
│
├── hub-protocol-client/        ⚠️ À créer
│   └── Client tRPC
│
└── hub-orchestrator-base/      ⚠️ À créer
    └── Interface/pattern
```

### Packages Spécifiques (notre Hub)

```
packages/
└── intelligence-hub/            ✅ Garder
    ├── services/
    │   └── hub-orchestrator.ts  (étend HubOrchestratorBase)
    ├── agents/
    └── clients/                 (supprimé, utilise @synap/hub-protocol-client)

apps/
└── intelligence-hub/            ✅ Garder
    └── Serveur Hono
```

---

## 🔄 Exemple d'Utilisation (Hub Tiers)

```typescript
// packages/my-custom-hub/src/orchestrator.ts
import { HubOrchestratorBase, type ExpertiseRequest, type ExpertiseResponse } from '@synap/hub-orchestrator-base';
import { HubProtocolClient } from '@synap/hub-protocol-client';
import { HubInsightSchema } from '@synap/hub-protocol';

export class MyCustomHubOrchestrator extends HubOrchestratorBase {
  private client: HubProtocolClient;

  constructor() {
    super();
    this.client = new HubProtocolClient({
      dataPodUrl: process.env.DATA_POD_URL!,
      token: process.env.USER_SESSION_TOKEN!,
    });
  }

  async executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse> {
    // 1. Générer token
    const { token } = await this.client.generateAccessToken(
      request.requestId,
      ['preferences', 'notes'],
      300
    );

    // 2. Récupérer données
    const data = await this.client.requestData(token, ['preferences', 'notes']);

    // 3. Traiter avec notre logique spécifique
    const insight = await this.processWithMyCustomLogic(request.query, data);

    // 4. Soumettre insight
    await this.client.submitInsight(token, insight);

    return {
      requestId: request.requestId,
      status: 'completed',
      insight,
    };
  }

  private async processWithMyCustomLogic(query: string, data: any) {
    // Logique spécifique au Hub tiers
    return {
      version: '1.0',
      type: 'action_plan',
      // ...
    };
  }
}
```

---

## ✅ Checklist de Validation

### Phase 1 : Hub Protocol Client
- [ ] Package créé
- [ ] Code déplacé
- [ ] Tests passent
- [ ] Intelligence Hub utilise le nouveau package
- [ ] Documentation créée

### Phase 2 : Hub Orchestrator Base
- [ ] Package créé
- [ ] Interface définie
- [ ] Classe abstraite créée
- [ ] Intelligence Hub étend la classe
- [ ] Tests passent

### Phase 3 : Mise à Jour Intelligence Hub
- [ ] Imports mis à jour
- [ ] Code compile
- [ ] Tests passent
- [ ] E2E tests passent

### Phase 4 : Documentation
- [ ] README pour chaque package
- [ ] Guide pour Hub tiers
- [ ] Exemples de code
- [ ] Mise à jour Extensibility Guide

---

## 📊 Impact

### Avant
- ❌ Code Hub Protocol couplé à Intelligence Hub
- ❌ Difficile pour Hub tiers de réutiliser
- ❌ Pas de standardisation

### Après
- ✅ Packages réutilisables
- ✅ Facile pour Hub tiers
- ✅ Standardisation via interfaces
- ✅ Notre Intelligence Hub reste propriétaire avec ses fonctionnalités

---

## 🚀 Ordre d'Exécution

1. **Phase 1** : Créer `@synap/hub-protocol-client` (2-3h)
2. **Phase 2** : Créer `@synap/hub-orchestrator-base` (2-3h)
3. **Phase 3** : Mettre à jour Intelligence Hub (1-2h)
4. **Phase 4** : Documentation (2-3h)

**Total estimé :** 7-11h

---

**Document créé le :** 2025-01-20  
**Version :** 1.0.0  
**Statut :** ⏳ **En attente d'approbation**

