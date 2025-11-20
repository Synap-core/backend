# Guide d'Extensibilité V1.0 - The Architech vs Marketplace

**Version :** 1.0  
**Statut :** Spécification Finale  
**Date :** 2025-01-20

---

## 1. Vue d'Ensemble

L'écosystème Synap offre **deux mécanismes d'extensibilité complémentaires** pour répondre à différents besoins :

1. **The Architech (Plugins Internes)** : Extensions qui modifient directement le Core OS
2. **Marketplace Hub (Services Externes)** : Services hébergés séparément et connectés via API

Ce guide vous aide à choisir le bon mécanisme pour votre cas d'usage.

---

## 2. Tableau de Décision

### 2.1. Quand Utiliser The Architech (Plugins Internes) ?

Utilisez **The Architech** si votre extension nécessite :

| Critère | Description | Exemple |
|---------|-------------|---------|
| **Accès Direct à la Base de Données** | Vous devez créer de nouvelles tables ou modifier le schéma | Système de facturation avec table `invoices` |
| **Logique Métier Complexe** | Vous avez besoin d'une intégration profonde avec le Core OS | Gestionnaire de projets avec workflows personnalisés |
| **Performances Critiques** | Vous ne pouvez pas tolérer la latence réseau | Traitement de fichiers volumineux en local |
| **Spécificité Utilisateur/Organisation** | L'extension est pour un usage privé ou interne | Plugin CRM pour une entreprise spécifique |
| **Modification du Code Source** | Vous devez modifier le comportement du Core OS | Ajout d'un nouveau type d'entité dans le noyau |

### 2.2. Quand Utiliser Marketplace Hub (Services Externes) ?

Utilisez **Marketplace Hub** si votre extension :

| Critère | Description | Exemple |
|---------|-------------|---------|
| **Service d'IA Externe** | Vous fournissez une intelligence spécialisée | Agent expert en analyse financière |
| **Ressources Cloud Nécessaires** | Vous avez besoin de GPU, APIs tierces, etc. | Service de génération d'images avec DALL-E |
| **Partage entre Utilisateurs** | L'extension doit être accessible à plusieurs utilisateurs | Service de synchronisation Google Calendar |
| **Mise à Jour Indépendante** | Vous voulez mettre à jour sans toucher au Core OS | Service d'analyse de sentiment |
| **Pas d'Accès Base de Données** | Vous n'avez pas besoin de modifier le schéma | Service de traduction de texte |

---

## 3. Spécification Technique : The Architech (Plugins Internes)

### 3.1. Architecture

Les plugins The Architech sont des **modules de capacité** qui modifient directement le code source et la base de données du Core OS.

```
Core OS/
├── src/
│   ├── routers/
│   │   └── my-plugin.ts      # Nouveau router tRPC
│   └── handlers/
│       └── my-plugin-handler.ts  # Nouveau handler d'événements
├── database/
│   └── migrations/
│       └── 001_add_my_plugin_tables.sql  # Nouvelles tables
└── package.json              # Dépendances du plugin
```

### 3.2. Format du Manifest

**Fichier :** `manifest.json` (à la racine du plugin)

```json
{
  "name": "@synap/plugin-invoicing",
  "version": "1.0.0",
  "description": "Système de facturation complet pour Synap",
  "author": "Votre Nom",
  "license": "MIT",
  
  "synap": {
    "version": ">=1.0.0",
    "type": "plugin",
    "category": "business",
    
    "capabilities": {
      "routers": ["invoicing"],
      "handlers": [
        "invoice.created",
        "invoice.paid",
        "invoice.overdue"
      ],
      "entities": ["invoice", "client"],
      "migrations": ["001_add_invoices.sql", "002_add_clients.sql"]
    },
    
    "dependencies": {
      "core": ">=1.0.0",
      "database": ">=1.0.0"
    },
    
    "permissions": {
      "database": {
        "create_tables": true,
        "modify_schema": true
      },
      "api": {
        "register_routers": true,
        "register_handlers": true
      }
    }
  },
  
  "scripts": {
    "install": "npx @thearchitech/cli install",
    "uninstall": "npx @thearchitech/cli uninstall"
  }
}
```

### 3.3. Structure d'un Plugin

```
my-plugin/
├── manifest.json              # Manifest (voir ci-dessus)
├── package.json              # Dépendances npm
├── src/
│   ├── router.ts             # Router tRPC
│   ├── handlers.ts           # Event handlers
│   └── schema.ts             # Schémas Drizzle (si nouvelles tables)
├── migrations/
│   └── 001_add_tables.sql    # Migrations SQL
└── README.md                  # Documentation
```

### 3.4. Exemple de Plugin : Système de Facturation

**Fichier :** `src/router.ts`

```typescript
import { router, protectedProcedure } from '@synap/api';
import { z } from 'zod';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';

export const invoicingRouter = router({
  /**
   * Créer une facture
   */
  create: protectedProcedure
    .input(z.object({
      clientId: z.string().uuid(),
      amount: z.number().positive(),
      dueDate: z.string().datetime(),
      description: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const eventRepo = getEventRepository();
      
      const event = createSynapEvent({
        type: 'invoice.created' as EventType, // Nouveau type d'événement
        data: {
          clientId: input.clientId,
          amount: input.amount,
          dueDate: input.dueDate,
          description: input.description,
        },
        userId: ctx.userId!,
        source: 'api',
      });
      
      await eventRepo.append(event);
      
      return {
        success: true,
        invoiceId: event.aggregateId,
        requestId: event.requestId,
      };
    }),
  
  /**
   * Lister les factures
   */
  list: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().nonnegative().default(0),
      status: z.enum(['draft', 'sent', 'paid', 'overdue']).optional(),
    }))
    .query(async ({ ctx, input }) => {
      // Lecture depuis la projection (table invoices)
      const db = getDatabase();
      const invoices = await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.userId, ctx.userId!))
        .limit(input.limit)
        .offset(input.offset);
      
      return { invoices, total: invoices.length };
    }),
});
```

**Fichier :** `src/handlers.ts`

```typescript
import { IEventHandler } from '@synap/jobs';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { getDatabase } from '@synap/database';

export const invoiceCreatedHandler: IEventHandler = {
  eventType: 'invoice.created',
  
  async handle(event) {
    const { clientId, amount, dueDate } = event.data;
    
    // Créer la projection (table invoices)
    const db = getDatabase();
    await db.insert(invoicesTable).values({
      id: event.aggregateId!,
      userId: event.userId,
      clientId,
      amount,
      dueDate: new Date(dueDate),
      status: 'draft',
      createdAt: event.timestamp,
    });
    
    // Émettre un événement de complétion
    const eventRepo = getEventRepository();
    const completionEvent = createSynapEvent({
      type: 'invoice.creation.completed' as EventType,
      data: {
        invoiceId: event.aggregateId!,
      },
      userId: event.userId,
      source: 'automation',
      causationId: event.id,
      correlationId: event.correlationId,
    });
    
    await eventRepo.append(completionEvent);
  },
};
```

**Fichier :** `migrations/001_add_invoices.sql`

```sql
-- Table des factures
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  due_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT invoices_user_id_check CHECK (user_id IS NOT NULL)
);

-- Index pour les requêtes fréquentes
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
```

### 3.5. Installation d'un Plugin

```bash
# Dans le répertoire du Core OS
npx @thearchitech/cli install @synap/plugin-invoicing

# Le CLI :
# 1. Télécharge le plugin depuis npm
# 2. Lit le manifest.json
# 3. Exécute les migrations SQL
# 4. Enregistre les routers et handlers
# 5. Met à jour package.json avec les dépendances
```

### 3.6. Avantages et Inconvénients

**Avantages :**
- ✅ Accès complet au Core OS
- ✅ Performances optimales (pas de latence réseau)
- ✅ Intégration profonde avec la logique métier
- ✅ Contrôle total sur les données

**Inconvénients :**
- ❌ Modifie le code source (peut casser lors des mises à jour)
- ❌ Non portable entre instances
- ❌ Nécessite des migrations de base de données
- ❌ Plus complexe à maintenir

---

## 4. Spécification Technique : Marketplace Hub (Services Externes)

### 4.1. Architecture

Les services Marketplace sont des **services hébergés séparément** qui communiquent avec le Data Pod via le Hub Protocol.

```
Service Externe/
├── src/
│   ├── agent.ts              # Agent LangGraph
│   ├── tools.ts              # Tools disponibles
│   └── api.ts                # API REST pour enregistrement
├── package.json
└── README.md
```

### 4.2. Processus d'Enregistrement

#### Étape 1 : Développer le Service

```typescript
// src/agent.ts
import { StateGraph } from '@langchain/langgraph';
import type { HubInsight } from '@synap/hub-protocol';

export class FinancialAnalysisAgent {
  async analyze(data: {
    transactions: Transaction[];
    preferences: UserPreferences;
  }): Promise<HubInsight> {
    // Logique d'analyse...
    
    return {
      version: '1.0',
      type: 'analysis',
      correlationId: data.requestId,
      analysis: {
        title: 'Analyse Financière Mensuelle',
        content: 'Vos dépenses ont augmenté de 15%...',
        keyPoints: [
          'Dépenses principales : Restaurants (30%)',
          'Économies potentielles : 200€/mois',
        ],
        recommendations: [
          'Réduire les dépenses restaurants de 20%',
          'Créer un budget mensuel',
        ],
      },
      confidence: 0.92,
      reasoning: 'Basé sur l\'analyse des 3 derniers mois',
    };
  }
}
```

#### Étape 2 : Enregistrer sur la Marketplace

**API du Hub :** `POST /api/marketplace/register`

```typescript
// Enregistrement du service
const response = await fetch('https://hub.synap.app/api/marketplace/register', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${developerApiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'Financial Analysis Agent',
    version: '1.0.0',
    description: 'Agent expert en analyse financière',
    category: 'finance',
    endpoint: 'https://my-service.com/api/hub',
    capabilities: {
      inputScopes: ['preferences', 'entities'],
      outputTypes: ['analysis', 'suggestion'],
      supportedEventTypes: [
        'task.creation.requested',
        'project.creation.requested',
      ],
    },
    pricing: {
      model: 'per_request',
      price: 0.10, // $0.10 par requête
    },
  }),
});
```

#### Étape 3 : Le Hub Expose le Service

Une fois enregistré, le service apparaît dans la marketplace et peut être utilisé par les Data Pods.

### 4.3. Format d'Appel du Service

**Flux :** Data Pod → Hub → Service Externe → Hub → Data Pod

```typescript
// Dans le Hub, routage vers le service externe
async function routeToExternalService(
  serviceId: string,
  request: {
    userId: string;
    requestId: string;
    data: Record<string, unknown>;
    scope: string[];
  }
): Promise<HubInsight> {
  // 1. Récupérer les infos du service depuis la marketplace
  const service = await marketplace.getService(serviceId);
  
  // 2. Appeler le service externe
  const response = await fetch(service.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${service.apiKey}`,
      'Content-Type': 'application/json',
      'X-Synap-Request-Id': request.requestId,
      'X-Synap-User-Id': request.userId,
    },
    body: JSON.stringify({
      data: request.data,
      scope: request.scope,
      requestId: request.requestId,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Service error: ${response.statusText}`);
  }
  
  // 3. Valider et retourner l'insight
  const insight = await response.json();
  return HubInsightSchema.parse(insight);
}
```

### 4.4. Format de Réponse du Service

Le service externe doit retourner un `HubInsight` conforme au schéma :

```typescript
// Réponse du service externe
{
  "version": "1.0",
  "type": "action_plan",
  "correlationId": "req-123",
  "actions": [
    {
      "eventType": "task.creation.requested",
      "data": {
        "title": "Créer un budget mensuel",
        "dueDate": "2025-02-01",
      },
      "requiresConfirmation": true,
    }
  ],
  "confidence": 0.95,
  "reasoning": "Basé sur l'analyse des dépenses",
}
```

### 4.5. Avantages et Inconvénients

**Avantages :**
- ✅ Portable entre instances
- ✅ Mise à jour indépendante du Core OS
- ✅ Partageable entre utilisateurs
- ✅ Pas de modification du code source
- ✅ Scalabilité (hébergement cloud)

**Inconvénients :**
- ❌ Latence réseau
- ❌ Dépendance à la disponibilité du service
- ❌ Pas d'accès direct à la base de données
- ❌ Nécessite une infrastructure séparée

---

## 5. Cas d'Usage Comparatifs

### 5.1. Cas d'Usage #1 : Système CRM

**Choix :** The Architech (Plugin Interne)

**Raisonnement :**
- Nécessite de nouvelles tables (`clients`, `deals`, `contacts`)
- Logique métier complexe (workflows de vente)
- Performances critiques (recherche rapide)
- Spécifique à l'organisation

**Implémentation :**
```bash
npx @thearchitech/cli install @synap/plugin-crm
```

### 5.2. Cas d'Usage #2 : Agent d'Analyse Financière

**Choix :** Marketplace Hub (Service Externe)

**Raisonnement :**
- Service d'IA spécialisé
- Nécessite des ressources cloud (GPU pour ML)
- Partageable entre utilisateurs
- Mise à jour fréquente des modèles

**Implémentation :**
1. Développer le service
2. Enregistrer sur la marketplace
3. Les utilisateurs l'activent depuis leur Data Pod

### 5.3. Cas d'Usage #3 : Intégration Google Calendar

**Choix :** Marketplace Hub (Service Externe)

**Raisonnement :**
- API externe (Google)
- Pas besoin de modifier le schéma
- Partageable entre utilisateurs
- Mise à jour indépendante

### 5.4. Cas d'Usage #4 : Système de Facturation Interne

**Choix :** The Architech (Plugin Interne)

**Raisonnement :**
- Nouvelles tables (`invoices`, `clients`)
- Logique métier complexe
- Performances critiques
- Spécifique à l'organisation

---

## 6. Migration entre Mécanismes

### 6.1. De Plugin Interne vers Service Externe

Si vous voulez transformer un plugin interne en service externe :

1. **Extraire la logique métier** dans un service séparé
2. **Créer une API REST** qui expose les fonctionnalités
3. **Enregistrer sur la marketplace**
4. **Désinstaller le plugin** du Core OS
5. **Migrer les données** si nécessaire

### 6.2. De Service Externe vers Plugin Interne

Si vous voulez transformer un service externe en plugin interne :

1. **Créer un plugin The Architech**
2. **Implémenter la logique** dans le Core OS
3. **Créer les migrations** pour les tables nécessaires
4. **Migrer les données** depuis le service externe
5. **Désactiver le service** sur la marketplace

---

## 7. Bonnes Pratiques

### 7.1. Pour les Plugins Internes

- ✅ **Versioning strict** : Utilisez le semantic versioning
- ✅ **Tests complets** : Testez les migrations et les handlers
- ✅ **Documentation** : Documentez toutes les tables et APIs
- ✅ **Isolation** : Utilisez des préfixes pour vos tables (`plugin_invoicing_*`)

### 7.2. Pour les Services Externes

- ✅ **Validation** : Validez toujours les insights avec `HubInsightSchema`
- ✅ **Gestion d'erreurs** : Retournez des erreurs structurées
- ✅ **Logging** : Loggez toutes les requêtes pour le debugging
- ✅ **Rate limiting** : Implémentez un rate limiting pour éviter les abus

---

## 8. Conclusion

Les deux mécanismes d'extensibilité sont **complémentaires** et répondent à des besoins différents :

- **The Architech** : Pour les extensions profondes qui nécessitent un accès direct au Core OS
- **Marketplace Hub** : Pour les services d'IA et intégrations tierces

**Règle d'or :** Si vous hésitez, choisissez **Marketplace Hub** car c'est plus flexible et moins risqué. Passez à **The Architech** seulement si vous avez un besoin spécifique qui ne peut pas être résolu autrement.

---

**Prochaine étape :** Implémenter The Architech CLI et la Marketplace Hub API.

