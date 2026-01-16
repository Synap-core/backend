# API Keys - Guide d'Utilisation

**Version :** 1.0  
**Date :** 2025-01-20  
**Auteur :** CTO & Architecte Solutions

---

## Table des Matières

1. [Introduction](#introduction)
2. [Types de Clés](#types-de-clés)
3. [Création de Clés](#création-de-clés)
4. [Utilisation des Clés](#utilisation-des-clés)
5. [Gestion des Clés](#gestion-des-clés)
6. [Scopes (Permissions)](#scopes-permissions)
7. [Rate Limiting](#rate-limiting)
8. [Sécurité & Meilleures Pratiques](#sécurité--meilleures-pratiques)
9. [Troubleshooting](#troubleshooting)
10. [Exemples Complets](#exemples-complets)

---

## Introduction

Le système de clés API de Synap permet une authentification sécurisée pour les services externes (notamment le Synap Intelligence Hub) via une approche hybride :

1. **API Keys** : Clés longue durée, hashées avec bcrypt, utilisées pour l'authentification initiale
2. **JWT Tokens** : Tokens temporaires (60-300 secondes) générés via les API keys pour les requêtes de données

**Pourquoi cette approche ?**

- ✅ **Sécurité élevée** : Les API keys ne circulent que pour générer des tokens temporaires
- ✅ **Performance** : Pas de DB lookup pour chaque requête (JWT validation)
- ✅ **Révocation facile** : Révoquer l'API key invalide tous les JWT futurs
- ✅ **Simplicité** : Pas besoin de serveur OAuth

---

## Types de Clés

### 1. Hub Keys (Clés Hub)

**Format :** `synap_hub_live_xxx` ou `synap_hub_test_xxx`

**Usage :** Authentification du Synap Intelligence Hub vers le Data Pod

**Caractéristiques :**

- Créées avec un `hubId` (identifiant du Hub)
- Préfixe automatique selon l'environnement (live/test)
- Permissions granulaires (scopes)
- Utilisées pour `hub.generateAccessToken`

### 2. User Keys (Clés Utilisateur)

**Format :** `synap_user_xxx`

**Usage :** Authentification d'applications tierces pour accès direct aux données

**Caractéristiques :**

- Créées sans `hubId`
- Permissions granulaires (scopes)
- Utilisées pour accès direct aux APIs (futur)

---

## Création de Clés

### Via tRPC (TypeScript)

```typescript
import { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@synap/api";

const client = createTRPCClient<AppRouter>({
  // ... config
});

// Créer une clé Hub
const { key, keyId } = await client.apiKeys.create.mutate({
  keyName: "Production Hub Key",
  scope: ["preferences", "notes", "tasks", "calendar"],
  hubId: "synap-hub-prod",
  expiresInDays: 90, // Optionnel
});

console.log("⚠️ Save this key securely:");
console.log(key); // synap_hub_live_abc123def456...

// ⚠️ La clé n'est affichée QU'UNE SEULE FOIS
// Stockez-la dans un gestionnaire de secrets (Vault, AWS Secrets Manager, etc.)
```

### Via REST API (curl)

```bash
curl -X POST https://your-datapod.com/trpc/apiKeys.create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -d '{
    "keyName": "Production Hub Key",
    "scope": ["preferences", "notes", "tasks"],
    "hubId": "synap-hub-prod",
    "expiresInDays": 90
  }'
```

**Réponse :**

```json
{
  "success": true,
  "key": "synap_hub_live_abc123def456ghi789...",
  "keyId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "⚠️ Save this key securely. It will not be displayed again."
}
```

---

## Utilisation des Clés

### 1. Génération d'un JWT Token

Les API keys sont utilisées pour générer des tokens JWT temporaires.

**TypeScript :**

```typescript
const { token, expiresAt, requestId } =
  await client.hub.generateAccessToken.mutate({
    apiKey: "synap_hub_live_abc123def456...",
    requestId: crypto.randomUUID(),
    scope: ["preferences", "notes"],
    expiresIn: 300, // 5 minutes (max)
  });

console.log("Token JWT:", token);
console.log("Expire à:", new Date(expiresAt));
```

**curl :**

```bash
curl -X POST https://your-datapod.com/trpc/hub.generateAccessToken \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer synap_hub_live_abc123def456..." \
  -d '{
    "requestId": "550e8400-e29b-41d4-a716-446655440001",
    "scope": ["preferences", "notes"],
    "expiresIn": 300
  }'
```

### 2. Utilisation du JWT Token

Le token JWT est ensuite utilisé pour les requêtes de données.

**TypeScript :**

```typescript
const { data } = await client.hub.requestData.query({
  token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  scope: ["preferences", "notes"],
});

console.log("Préférences:", data.preferences);
console.log("Notes:", data.notes);
```

**curl :**

```bash
curl -X GET 'https://your-datapod.com/trpc/hub.requestData?token=eyJhbGci...&scope=preferences,notes'
```

---

## Gestion des Clés

### Lister les Clés

```typescript
const keys = await client.apiKeys.list.query();

keys.forEach((key) => {
  console.log(`${key.keyName} (${key.keyPrefix})`);
  console.log(`  Active: ${key.isActive}`);
  console.log(`  Last used: ${key.lastUsedAt}`);
  console.log(`  Usage count: ${key.usageCount}`);
  console.log(`  Expires: ${key.expiresAt || "Never"}`);
});
```

### Révoquer une Clé

```typescript
await client.apiKeys.revoke.mutate({
  keyId: "550e8400-e29b-41d4-a716-446655440000",
  reason: "Compromised key",
});

console.log("Clé révoquée avec succès");
```

**Impact :** La clé est immédiatement désactivée. Tous les JWT générés avec cette clé **restent valides** jusqu'à leur expiration, mais aucun nouveau JWT ne peut être généré.

### Rotation d'une Clé

```typescript
const { newKey, newKeyId } = await client.apiKeys.rotate.mutate({
  keyId: "550e8400-e29b-41d4-a716-446655440000",
});

console.log("Nouvelle clé:", newKey);
console.log("⚠️ Sauvegardez cette nouvelle clé !");

// L'ancienne clé est automatiquement révoquée
```

**Best Practice :** Effectuez une rotation tous les 90 jours (recommandé dans le champ `rotationScheduledAt`).

---

## Scopes (Permissions)

Les scopes définissent quelles données peuvent être accédées par la clé API.

| Scope             | Description             | Données accessibles                           |
| ----------------- | ----------------------- | --------------------------------------------- |
| `preferences`     | Préférences utilisateur | Paramètres, préférences                       |
| `calendar`        | Événements calendrier   | Événements, rendez-vous                       |
| `notes`           | Notes (résumé)          | Titre, date création (pas le contenu complet) |
| `tasks`           | Tâches (résumé)         | Titre, statut, date création                  |
| `projects`        | Projets (résumé)        | Titre, statut, date création                  |
| `conversations`   | Conversations (résumé)  | ID, titre, dernier message                    |
| `entities`        | Entités (résumé)        | ID, type, nom, date création                  |
| `relations`       | Relations               | Relations entre entités                       |
| `knowledge_facts` | Faits de connaissance   | Faits, confiance                              |

**Exemple de scopes :**

```typescript
// Hub avec accès complet
scope: [
  "preferences",
  "calendar",
  "notes",
  "tasks",
  "projects",
  "conversations",
  "entities",
  "knowledge_facts",
];

// Hub spécialisé (uniquement notes et tâches)
scope: ["notes", "tasks"];

// Service tiers (uniquement calendrier)
scope: ["calendar"];
```

**Principe du moindre privilège :** Ne donnez que les scopes nécessaires.

---

## Rate Limiting

Le rate limiting est appliqué par clé API pour protéger contre les abus.

### Limites par Action

| Action                                          | Limite       | Fenêtre  |
| ----------------------------------------------- | ------------ | -------- |
| Génération de token (`hub.generateAccessToken`) | 10 requêtes  | 1 minute |
| Requête de données (`hub.requestData`)          | 100 requêtes | 1 minute |
| Soumission d'insight (`hub.submitInsight`)      | 50 requêtes  | 1 minute |

### Gestion du Rate Limiting

**Erreur reçue :**

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Rate limit exceeded for API key"
  }
}
```

**Solution :**

1. Attendez 1 minute avant de réessayer
2. Implémentez un backoff exponentiel
3. Vérifiez votre logique d'appel (évitez les boucles infinies)
4. Si nécessaire, créez plusieurs clés API et distribuez la charge

**Exemple de backoff exponentiel :**

```typescript
async function generateTokenWithRetry(
  apiKey: string,
  requestId: string,
  maxRetries = 3
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.hub.generateAccessToken.mutate({
        apiKey,
        requestId,
        scope: ["preferences"],
      });
    } catch (error) {
      if (error.code === "TOO_MANY_REQUESTS" && i < maxRetries - 1) {
        // Attendre avec backoff exponentiel
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}
```

---

## Sécurité & Meilleures Pratiques

### ✅ Stockage Sécurisé

**Ne JAMAIS :**

- ❌ Stocker les clés en plain text dans votre code
- ❌ Committer les clés dans Git
- ❌ Logger les clés complètes
- ❌ Envoyer les clés par email

**Toujours :**

- ✅ Utiliser un gestionnaire de secrets (Vault, AWS Secrets Manager, .env sécurisé)
- ✅ Utiliser des variables d'environnement
- ✅ Chiffrer les clés au repos
- ✅ Ne logger que le préfixe (ex: `synap_hub_live_***`)

**Exemple (.env) :**

```bash
# .env (GITIGNORE CE FICHIER !)
SYNAP_HUB_API_KEY=synap_hub_live_abc123def456ghi789...
```

### ✅ Rotation Régulière

**Recommandation :** Rotation tous les 90 jours

**Processus :**

1. Générer nouvelle clé via `apiKeys.rotate`
2. Mettre à jour vos secrets (Vault, etc.)
3. Redéployer vos services avec la nouvelle clé
4. Vérifier que tout fonctionne
5. L'ancienne clé est automatiquement révoquée

### ✅ Expiration

**Recommandation :** Définir une expiration pour les clés de test/développement

```typescript
// Clé de développement (expire dans 30 jours)
await client.apiKeys.create.mutate({
  keyName: "Dev Key",
  scope: ["preferences"],
  expiresInDays: 30,
});
```

### ✅ Monitoring

**Vérifiez régulièrement :**

- `last_used_at` : Identifiez les clés inutilisées
- `usage_count` : Détectez une utilisation anormale
- `rotationScheduledAt` : Planifiez les rotations

```typescript
const keys = await client.apiKeys.list.query();

keys.forEach((key) => {
  // Alerte si clé non utilisée depuis 30 jours
  if (
    key.lastUsedAt &&
    Date.now() - key.lastUsedAt.getTime() > 30 * 24 * 60 * 60 * 1000
  ) {
    console.warn(`Clé "${key.keyName}" non utilisée depuis 30 jours`);
  }

  // Alerte si rotation due
  if (key.rotationScheduledAt && key.rotationScheduledAt < new Date()) {
    console.warn(`Clé "${key.keyName}" nécessite une rotation`);
  }
});
```

### ✅ Audit Trail

Toutes les utilisations de clés sont loggées dans l'Event Store :

```typescript
// Événements générés
-hub.access.logged(token.generated) -
  hub.access.logged(data.requested) -
  hub.access.logged(insight.submitted);
```

---

## Troubleshooting

### Erreur : "Hub API key required"

**Cause :** Aucune clé API fournie

**Solution :**

1. Vérifiez que vous passez `apiKey` dans l'input OU
2. Vérifiez le header `Authorization: Bearer synap_hub_xxx`

```typescript
// Option 1: Input
await client.hub.generateAccessToken.mutate({
  apiKey: "synap_hub_live_xxx",
  // ...
});

// Option 2: Header
const client = createTRPCClient({
  headers: {
    Authorization: `Bearer synap_hub_live_xxx`,
  },
});
```

### Erreur : "Invalid or revoked Hub API key"

**Causes possibles :**

1. Clé incorrecte (typo, copier-coller incomplet)
2. Clé révoquée
3. Clé expirée

**Solution :**

1. Vérifiez la clé dans votre gestionnaire de secrets
2. Listez vos clés : `apiKeys.list` et vérifiez `isActive`
3. Si révoquée/expirée, créez une nouvelle clé

### Erreur : "This endpoint requires a Hub API key (not a user key)"

**Cause :** Vous utilisez une clé User (`synap_user_xxx`) au lieu d'une clé Hub

**Solution :** Créez une clé Hub avec `hubId` :

```typescript
await client.apiKeys.create.mutate({
  keyName: "Hub Key",
  scope: ["preferences"],
  hubId: "synap-hub-prod", // ⚠️ Obligatoire pour Hub key
});
```

### Erreur : "Rate limit exceeded for API key"

**Cause :** Trop de requêtes en peu de temps

**Solution :**

1. Attendez 1 minute
2. Implémentez un rate limiting côté client
3. Utilisez un backoff exponentiel (voir exemple ci-dessus)

### Erreur : "Invalid or expired Hub token"

**Cause :** Le JWT token a expiré (max 5 minutes)

**Solution :**

1. Générez un nouveau token via `hub.generateAccessToken`
2. Les tokens expirent automatiquement après 60-300 secondes

---

## Exemples Complets

### Exemple 1 : Flow Complet Hub → Data Pod

```typescript
import { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@synap/api";

// Client Data Pod
const dataPodClient = createTRPCClient<AppRouter>({
  url: "https://user-datapod.com/trpc",
});

// 1. Récupérer l'API key depuis votre gestionnaire de secrets
const hubApiKey = process.env.SYNAP_HUB_API_KEY!;

// 2. Générer un requestId unique
const requestId = crypto.randomUUID();

// 3. Générer un JWT token temporaire
const { token, expiresAt } = await dataPodClient.hub.generateAccessToken.mutate(
  {
    apiKey: hubApiKey,
    requestId,
    scope: ["preferences", "notes", "tasks"],
    expiresIn: 300,
  }
);

console.log("Token généré, expire à:", new Date(expiresAt));

// 4. Requête de données avec le token
const { data } = await dataPodClient.hub.requestData.query({
  token,
  scope: ["preferences", "notes", "tasks"],
});

console.log("Préférences:", data.preferences);
console.log("Notes:", data.notes);
console.log("Tâches:", data.tasks);

// 5. Analyser les données et générer un insight
const insight = {
  version: "1.0",
  type: "action_plan",
  correlationId: requestId,
  actions: [
    {
      eventType: "task.create",
      data: {
        name: "Nouvelle tâche suggérée",
        description: "Basée sur vos notes",
      },
      requiresConfirmation: true,
    },
  ],
  confidence: 0.85,
  reasoning: "Analyse des notes récentes",
};

// 6. Soumettre l'insight au Data Pod
const result = await dataPodClient.hub.submitInsight.mutate({
  token,
  requestId,
  insight,
});

console.log("Insight soumis:", result.eventsCreated, "événements créés");
```

### Exemple 2 : Rotation de Clés en Production

```typescript
// Script de rotation à exécuter tous les 90 jours
async function rotateHubApiKey() {
  // 1. Lister les clés et trouver celle à renouveler
  const keys = await client.apiKeys.list.query();

  const keyToRotate = keys.find(
    (k) => k.rotationScheduledAt && k.rotationScheduledAt < new Date()
  );

  if (!keyToRotate) {
    console.log("Aucune clé à renouveler");
    return;
  }

  console.log(`Rotation de la clé "${keyToRotate.keyName}"`);

  // 2. Rotation
  const { newKey, newKeyId } = await client.apiKeys.rotate.mutate({
    keyId: keyToRotate.id,
  });

  console.log("Nouvelle clé générée:", newKeyId);

  // 3. Mettre à jour dans votre gestionnaire de secrets
  // (exemple avec AWS Secrets Manager)
  const {
    SecretsManagerClient,
    PutSecretValueCommand,
  } = require("@aws-sdk/client-secrets-manager");

  const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

  await secretsClient.send(
    new PutSecretValueCommand({
      SecretId: "synap-hub-api-key",
      SecretString: newKey,
    })
  );

  console.log("✅ Clé mise à jour dans AWS Secrets Manager");
  console.log("⚠️ Redéployez vos services pour utiliser la nouvelle clé");
}

// Exécuter la rotation
rotateHubApiKey().catch(console.error);
```

### Exemple 3 : Monitoring des Clés

```typescript
// Script de monitoring à exécuter quotidiennement
async function monitorApiKeys() {
  const keys = await client.apiKeys.list.query();

  console.log(`=== Monitoring de ${keys.length} clés API ===\n`);

  for (const key of keys) {
    console.log(`Clé: ${key.keyName} (${key.id})`);
    console.log(`  Préfixe: ${key.keyPrefix}`);
    console.log(`  Active: ${key.isActive ? "✅" : "❌"}`);

    // Usage
    if (key.lastUsedAt) {
      const daysSinceUse =
        (Date.now() - key.lastUsedAt.getTime()) / (24 * 60 * 60 * 1000);
      console.log(`  Dernière utilisation: ${daysSinceUse.toFixed(1)} jours`);

      if (daysSinceUse > 30) {
        console.warn(
          `  ⚠️ ALERTE: Clé non utilisée depuis ${daysSinceUse.toFixed(0)} jours`
        );
      }
    } else {
      console.warn(`  ⚠️ ALERTE: Clé jamais utilisée`);
    }

    console.log(`  Utilisation: ${key.usageCount} requêtes`);

    // Expiration
    if (key.expiresAt) {
      const daysUntilExpiration =
        (key.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      console.log(`  Expire dans: ${daysUntilExpiration.toFixed(1)} jours`);

      if (daysUntilExpiration < 7) {
        console.warn(
          `  ⚠️ ALERTE: Clé expire dans ${daysUntilExpiration.toFixed(0)} jours`
        );
      }
    }

    // Rotation
    if (key.rotationScheduledAt) {
      const daysUntilRotation =
        (key.rotationScheduledAt.getTime() - Date.now()) /
        (24 * 60 * 60 * 1000);

      if (daysUntilRotation < 0) {
        console.warn(
          `  ⚠️ ALERTE: Rotation en retard de ${Math.abs(daysUntilRotation).toFixed(0)} jours`
        );
      } else {
        console.log(
          `  Rotation recommandée dans: ${daysUntilRotation.toFixed(1)} jours`
        );
      }
    }

    console.log("");
  }
}

// Exécuter le monitoring
monitorApiKeys().catch(console.error);
```

---

## Support

Pour toute question ou problème :

1. **Documentation :** Consultez ce guide
2. **Issues :** [GitHub Issues](https://github.com/your-repo/issues)
3. **Discord :** [Synap Community](https://discord.gg/synap)

---

**Dernière mise à jour :** 2025-01-20  
**Version :** 1.0
