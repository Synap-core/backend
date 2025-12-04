# Plan d'Action : Migration Better Auth → Ory Stack (Clean Slate)

**Date :** 2025-01-20  
**Statut :** Plan d'Action Validé - Prêt à Exécuter  
**Approche :** Clean Slate (pas de backward compatibility)

---

## 🎯 Objectif

Remplacer complètement Better Auth par Ory Stack dans le package `@synap/auth`, en supprimant tout le code Better Auth et en mettant à jour toutes les connexions.

---

## 📦 Structure du Package `@synap/auth`

### Structure Finale

```
packages/auth/
├── src/
│   ├── index.ts                    # Exports principaux
│   ├── ory-kratos.ts               # Client Kratos (Identity Provider)
│   ├── ory-hydra.ts                # Client Hydra (OAuth2 Server)
│   ├── ory-middleware.ts           # Middleware Hono pour Ory
│   ├── token-exchange.ts           # Service Token Exchange (pour websites)
│   └── simple-auth.ts              # ⚠️ GARDÉ (pour SQLite single-user)
├── package.json
├── tsconfig.json
└── README.md
```

### Fichiers à SUPPRIMER

- ❌ `packages/auth/src/better-auth.ts` (remplacé par Ory)

### Fichiers à CRÉER

- ✨ `packages/auth/src/ory-kratos.ts`
- ✨ `packages/auth/src/ory-hydra.ts`
- ✨ `packages/auth/src/ory-middleware.ts`
- ✨ `packages/auth/src/token-exchange.ts`

### Fichiers à MODIFIER

- ✏️ `packages/auth/src/index.ts` (remplacer exports Better Auth par Ory)
- ✏️ `packages/auth/package.json` (remplacer dependencies)

### Fichiers à GARDER

- ✅ `packages/auth/src/simple-auth.ts` (pour SQLite single-user mode)

---

## 🔄 Fichiers à Mettre à Jour (Connexions)

### 1. `apps/api/src/index.ts`

**Changements :**
- ❌ Supprimer import Better Auth
- ✨ Importer Ory middleware
- ✨ Remplacer routes `/api/auth/*` par routes Kratos
- ✨ Ajouter route Token Exchange

### 2. `packages/api/src/context.ts`

**Changements :**
- ❌ Supprimer `getSession()` Better Auth
- ✨ Utiliser `getKratosSession()` Ory
- ✨ Adapter extraction `userId` depuis identity Kratos

### 3. `packages/core/src/config.ts`

**Changements :**
- ❌ Supprimer validation Better Auth
- ✨ Ajouter validation Ory (Kratos + Hydra)
- ✨ Ajouter variables d'environnement Ory

### 4. `.env.example`

**Changements :**
- ❌ Supprimer variables Better Auth
- ✨ Ajouter variables Ory (Kratos + Hydra)

### 5. `docker compose.yml`

**Changements :**
- ✨ Ajouter services Ory (Kratos + Hydra + PostgreSQL Ory)

---

## 🗑️ Code à Supprimer (Clean Slate)

### Dependencies à Supprimer

- ❌ `better-auth@^1.3.34`
- ❌ `@neondatabase/serverless` (si plus utilisé)
- ❌ `drizzle-orm` (si plus utilisé dans auth package)

### Code à Supprimer

- ❌ Tout le code Better Auth
- ❌ Routes Better Auth dans API server
- ❌ Validation Better Auth dans config
- ❌ Variables d'environnement Better Auth

### Tables PostgreSQL (Optionnel - à supprimer plus tard)

- ❌ Tables Better Auth (user, session, account, verification)
  - **Note :** Supprimer après validation que tout fonctionne

---

## ✅ Checklist d'Implémentation

### Phase 1 : Infrastructure Ory (Docker)

- [ ] Créer `docker compose.ory.yml`
- [ ] Créer `kratos/kratos.yml`
- [ ] Créer `kratos/identity.schema.json`
- [ ] Créer `hydra/hydra.yml`
- [ ] Tester déploiement local

### Phase 2 : Package Auth (Ory)

- [ ] Supprimer `packages/auth/src/better-auth.ts`
- [ ] Créer `packages/auth/src/ory-kratos.ts`
- [ ] Créer `packages/auth/src/ory-hydra.ts`
- [ ] Créer `packages/auth/src/ory-middleware.ts`
- [ ] Créer `packages/auth/src/token-exchange.ts`
- [ ] Modifier `packages/auth/src/index.ts`
- [ ] Modifier `packages/auth/package.json`
- [ ] Installer dependencies Ory

### Phase 3 : API Server

- [ ] Modifier `apps/api/src/index.ts`
  - [ ] Supprimer import Better Auth
  - [ ] Importer Ory middleware
  - [ ] Remplacer routes `/api/auth/*`
  - [ ] Ajouter route Token Exchange
- [ ] Modifier `packages/api/src/context.ts`
  - [ ] Remplacer `getSession()` par `getKratosSession()`
  - [ ] Adapter extraction `userId`

### Phase 4 : Configuration

- [ ] Modifier `packages/core/src/config.ts`
  - [ ] Supprimer validation Better Auth
  - [ ] Ajouter validation Ory
- [ ] Modifier `.env.example`
  - [ ] Supprimer variables Better Auth
  - [ ] Ajouter variables Ory

### Phase 5 : Docker Compose

- [ ] Modifier `docker compose.yml`
  - [ ] Ajouter services Ory

### Phase 6 : Tests & Validation

- [ ] Tester login Email/Password
- [ ] Tester OAuth Google
- [ ] Tester OAuth GitHub
- [ ] Tester sessions
- [ ] Tester Token Exchange
- [ ] Vérifier que tout compile

### Phase 7 : Cleanup

- [ ] Supprimer code mort
- [ ] Supprimer dependencies inutilisées
- [ ] Mettre à jour documentation

---

## 📝 Structure Détaillée des Nouveaux Fichiers

### `packages/auth/src/ory-kratos.ts`

```typescript
/**
 * Ory Kratos Client - Identity Provider
 */

import { Configuration, FrontendApi, IdentityApi } from '@ory/kratos-client';

const kratosPublicUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';
const kratosAdminUrl = process.env.KRATOS_ADMIN_URL || 'http://localhost:4434';

export const kratosPublic = new FrontendApi(
  new Configuration({ basePath: kratosPublicUrl })
);

export const kratosAdmin = new IdentityApi(
  new Configuration({ basePath: kratosAdminUrl })
);

export async function getKratosSession(cookie: string): Promise<any | null> {
  try {
    const { data: session } = await kratosPublic.toSession({ cookie });
    return session;
  } catch {
    return null;
  }
}

export async function getIdentityById(identityId: string): Promise<any | null> {
  try {
    const { data: identity } = await kratosAdmin.getIdentity({ id: identityId });
    return identity;
  } catch {
    return null;
  }
}
```

### `packages/auth/src/ory-hydra.ts`

```typescript
/**
 * Ory Hydra Client - OAuth2 Server
 */

import { Configuration, AdminApi, PublicApi } from '@ory/hydra-client';

const hydraPublicUrl = process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444';
const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

export const hydraPublic = new PublicApi(
  new Configuration({ basePath: hydraPublicUrl })
);

export const hydraAdmin = new AdminApi(
  new Configuration({ basePath: hydraAdminUrl })
);

export async function introspectToken(token: string): Promise<any | null> {
  try {
    const { data } = await hydraPublic.introspectOAuth2Token({ token });
    return data.active ? data : null;
  } catch {
    return null;
  }
}

export async function createOAuth2Client(client: {
  client_id: string;
  client_secret: string;
  grant_types: string[];
  response_types: string[];
  scope: string;
  redirect_uris: string[];
}) {
  const { data } = await hydraAdmin.createOAuth2Client({ oAuth2Client: client });
  return data;
}
```

### `packages/auth/src/ory-middleware.ts`

```typescript
/**
 * Ory Auth Middleware for Hono
 */

import type { MiddlewareHandler } from 'hono';
import { introspectToken } from './ory-hydra.js';
import { getIdentityById } from './ory-kratos.js';

export const oryAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenInfo = await introspectToken(token);
  
  if (!tokenInfo || !tokenInfo.active) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  const identity = await getIdentityById(tokenInfo.sub);
  
  if (!identity) {
    return c.json({ error: 'Identity not found' }, 401);
  }

  c.set('user', {
    id: identity.id,
    email: identity.traits.email,
    name: identity.traits.name,
  });
  c.set('userId', identity.id);
  c.set('scopes', tokenInfo.scope?.split(' ') || []);
  c.set('authenticated', true);

  return next();
};
```

### `packages/auth/src/token-exchange.ts`

```typescript
/**
 * Token Exchange Service
 * 
 * Permet d'échanger un token d'un provider externe contre un token Hydra
 */

import { hydraAdmin } from './ory-hydra.js';

export async function exchangeToken(
  subjectToken: string,
  subjectTokenType: string,
  clientId: string,
  requestedScopes: string[]
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  // TODO: Implémenter validation token externe
  // TODO: Implémenter exchange avec Hydra
  
  // Placeholder
  throw new Error('Token Exchange not yet implemented');
}
```

### `packages/auth/src/index.ts` (Nouveau)

```typescript
/**
 * Authentication Package
 * 
 * Ory Stack (Kratos + Hydra) for PostgreSQL
 * Simple Auth for SQLite
 */

// Re-export simple auth (for SQLite)
export { authMiddleware as simpleAuthMiddleware, generateToken } from './simple-auth.js';

// Re-export Ory Kratos
export { kratosPublic, kratosAdmin, getKratosSession, getIdentityById } from './ory-kratos.js';

// Re-export Ory Hydra
export { hydraPublic, hydraAdmin, introspectToken, createOAuth2Client } from './ory-hydra.js';

// Re-export Ory middleware
export { oryAuthMiddleware } from './ory-middleware.js';

// Re-export Token Exchange
export { exchangeToken } from './token-exchange.js';

// Default exports (for PostgreSQL)
export { oryAuthMiddleware as authMiddleware } from './ory-middleware.js';
export { getKratosSession as getSession } from './ory-kratos.js';
```

---

## 🚀 Ordre d'Exécution

1. **Créer infrastructure Ory** (Docker)
2. **Créer nouveaux fichiers Ory** dans `packages/auth`
3. **Supprimer Better Auth** de `packages/auth`
4. **Mettre à jour `packages/auth/src/index.ts`**
5. **Mettre à jour `packages/auth/package.json`**
6. **Mettre à jour `apps/api/src/index.ts`**
7. **Mettre à jour `packages/api/src/context.ts`**
8. **Mettre à jour `packages/core/src/config.ts`**
9. **Mettre à jour `.env.example`**
10. **Mettre à jour `docker compose.yml`**
11. **Tests & Validation**
12. **Cleanup final**

---

## ✅ Confirmation

**Structure validée :**
- ✅ Package séparé : `packages/auth/`
- ✅ Clean slate : Suppression complète Better Auth
- ✅ Toutes les connexions mises à jour
- ✅ Simple Auth gardé pour SQLite

**Prêt à procéder ?**

Si oui, je commence par :
1. Créer l'infrastructure Ory (Docker)
2. Créer les nouveaux fichiers Ory
3. Supprimer Better Auth
4. Mettre à jour toutes les connexions

