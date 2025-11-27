# Refactoring : Migration Better Auth → Ory Stack (Kratos + Hydra)

**Version :** 1.0  
**Date :** 2025-01-20  
**Statut :** Plan de Refactoring - En Attente de Validation  
**Objectif :** Remplacer complètement Better Auth par Ory Stack (Kratos pour Identity, Hydra pour OAuth2)

---

## 📋 Table des Matières

1. [Vue d'Ensemble](#vue-densemble)
2. [Analyse du Système Actuel](#analyse-du-système-actuel)
3. [Architecture Ory Target](#architecture-ory-target)
4. [Fichiers à Modifier/Supprimer/Ajouter](#fichiers-à-modifiersupprimerajouter)
5. [Changements de Flow](#changements-de-flow)
6. [Migration des Données](#migration-des-données)
7. [Roadmap d'Implémentation](#roadmap-dimplémentation)
8. [Risques et Mitigations](#risques-et-mitigations)

---

## 1. Vue d'Ensemble

### 1.1. Objectif

Remplacer **Better Auth** par **Ory Stack** :
- **Ory Kratos** : Identity Provider (remplace Better Auth pour la gestion des utilisateurs)
- **Ory Hydra** : OAuth2/OIDC Server (pour les agents tiers et le Hub Protocol)

### 1.2. Justification

- ✅ **Standard OAuth2** : Nécessaire pour marketplace d'agents tiers
- ✅ **Multi-tenant** : Chaque Data Pod = tenant isolé
- ✅ **Granular Scopes** : Permissions précises pour agents externes
- ✅ **Lightweight** : Go-based, performant
- ✅ **Open Source** : Contrôle total

### 1.3. Scope

**Inclus :**
- Migration complète de Better Auth vers Kratos
- Configuration Hydra pour OAuth2
- Migration des utilisateurs existants
- Mise à jour de tous les flows d'authentification
- Hub Protocol utilisant Hydra

**Exclus (pour l'instant) :**
- Migration des API Keys (reste tel quel)
- Simple Auth pour SQLite (reste tel quel)

---

## 2. Analyse du Système Actuel

### 2.1. Fichiers Utilisant Better Auth

#### **Packages**

1. **`packages/auth/src/better-auth.ts`**
   - Configuration Better Auth
   - Session management
   - OAuth providers (Google, GitHub)
   - Email/Password auth
   - Middleware Hono

2. **`packages/auth/src/index.ts`**
   - Exports conditionnels
   - Types exports

3. **`packages/auth/package.json`**
   - Dependency: `better-auth@^1.3.34`

#### **API Server**

4. **`apps/api/src/index.ts`**
   - Import dynamique de Better Auth
   - Routes `/api/auth/*`
   - Middleware auth pour tRPC

5. **`packages/api/src/context.ts`**
   - `createContext()` utilise `getSession()`
   - Extraction `userId` depuis session

#### **Configuration**

6. **`packages/core/src/config.ts`**
   - Validation config Better Auth
   - Variables d'environnement

### 2.2. Features Actuelles de Better Auth

| Feature | Status | Remplacement Ory |
|:---|:---|:---|
| Email/Password | ✅ | Kratos (Identity Schema) |
| Google OAuth | ✅ | Kratos (OIDC Provider) |
| GitHub OAuth | ✅ | Kratos (OIDC Provider) |
| Session Management | ✅ | Kratos (Sessions) |
| Cookie-based Auth | ✅ | Kratos (Cookies) |
| User Management | ✅ | Kratos (Identity API) |
| Password Hashing | ✅ | Kratos (bcrypt/argon2) |

### 2.3. Tables PostgreSQL Actuelles (Better Auth)

Better Auth crée automatiquement :
- `user` - Utilisateurs
- `session` - Sessions actives
- `account` - Comptes OAuth liés
- `verification` - Vérifications email

**Schéma actuel (inféré) :**
```sql
-- Better Auth tables (créées automatiquement)
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  email_verified BOOLEAN,
  name TEXT,
  image TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES user(id),
  expires_at TIMESTAMPTZ,
  token TEXT,
  ip_address TEXT,
  user_agent TEXT
);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES user(id),
  provider TEXT, -- 'google', 'github'
  provider_account_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ
);
```

---

## 3. Architecture Ory Target

### 3.1. Architecture Globale

```
┌─────────────────────────────────────────────────────────┐
│  Data Pod (Resource Server)                              │
│  - Expose API protégée par OAuth2                       │
│  - Valide tokens Hydra                                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ OAuth2 Tokens
                     │
┌────────────────────▼────────────────────────────────────┐
│  Ory Hydra (OAuth2/OIDC Server)                          │
│  - Gère tokens OAuth2                                    │
│  - Scopes granulaires                                    │
│  - Client: synap-hub (Intelligence Hub)                  │
│  - Client: agent-* (Agents tiers futurs)                │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Identity Verification
                     │
┌────────────────────▼────────────────────────────────────┐
│  Ory Kratos (Identity Provider)                          │
│  - Gère utilisateurs                                     │
│  - Email/Password                                        │
│  - OAuth (Google, GitHub)                                │
│  - Sessions                                              │
└─────────────────────────────────────────────────────────┘
```

### 3.2. Services Ory

#### **Ory Kratos (Identity Provider)**

**Rôle :** Gestion des identités utilisateur

**Features :**
- Email/Password authentication
- OAuth providers (Google, GitHub)
- Session management
- Identity management API
- Self-service flows (registration, login, recovery)

**Endpoints :**
- Public API: `http://kratos:4433` (pour les flows utilisateur)
- Admin API: `http://kratos:4434` (pour la gestion)

#### **Ory Hydra (OAuth2 Server)**

**Rôle :** Gestion OAuth2/OIDC

**Features :**
- OAuth2 flows (authorization_code, client_credentials)
- Token management
- Scope management
- Client management
- Consent management

**Endpoints :**
- Public API: `http://hydra:4444` (pour les flows OAuth2)
- Admin API: `http://hydra:4445` (pour la gestion)

### 3.3. Clients OAuth2

#### **1. Intelligence Hub (Client de Confiance)**

```yaml
client_id: synap-hub
client_secret: <generated>
grant_types:
  - client_credentials  # Pour M2M (Hub → Data Pod)
  - authorization_code   # Pour user flows (futur)
scopes:
  - read:preferences
  - read:notes
  - read:tasks
  - read:knowledge_facts
  - write:insights
```

#### **2. Agents Tiers (Clients Externes)**

```yaml
client_id: agent-{name}
client_secret: <generated>
grant_types:
  - authorization_code
  - refresh_token
scopes:
  - read:notes
  - write:tasks
  # Scopes spécifiques selon l'agent
```

#### **3. Websites Clients (Flexibilité)**

**Option A : Utilise Ory directement (Recommandé)**
```yaml
client_id: website-{name}
client_secret: <generated>
grant_types:
  - authorization_code
  - refresh_token
scopes:
  - read:notes
  - write:tasks
```

**Option B : Utilise autre provider (Token Exchange)**
```yaml
client_id: website-{name}
client_secret: <generated>
grant_types:
  - urn:ietf:params:oauth:grant-type:token-exchange  # Token Exchange
scopes:
  - read:notes
  - write:tasks
```

#### **4. Data Pod (Resource Server)**

Le Data Pod n'est pas un client OAuth2, mais un **Resource Server** qui :
- Valide les tokens OAuth2 émis par Hydra
- Vérifie les scopes
- Expose les ressources protégées
- **Support Token Exchange** : Accepte tokens d'autres providers via exchange

---

## 4. Fichiers à Modifier/Supprimer/Ajouter

### 4.1. Fichiers à SUPPRIMER

#### **Packages**

1. **`packages/auth/src/better-auth.ts`** ❌
   - Remplacé par `packages/auth/src/ory-kratos.ts` et `packages/auth/src/ory-hydra.ts`

2. **`packages/auth/src/simple-auth.ts`** ⚠️
   - **DÉCISION** : Garder pour SQLite (single-user mode)
   - Ne pas supprimer

#### **Dependencies**

3. **`packages/auth/package.json`**
   - Supprimer: `"better-auth": "^1.3.34"`
   - Supprimer: `"@neondatabase/serverless": "^0.9.0"` (si plus utilisé)

### 4.2. Fichiers à CRÉER

#### **Infrastructure Ory**

1. **`docker-compose.ory.yml`** ✨ NOUVEAU
   ```yaml
   # Configuration Docker Compose pour Ory Stack
   services:
     postgres-ory:
       image: postgres:15
       environment:
         POSTGRES_DB: ory
         POSTGRES_USER: ory
         POSTGRES_PASSWORD: ${ORY_DB_PASSWORD}
       volumes:
         - ory_db_data:/var/lib/postgresql/data
   
     kratos:
       image: oryd/kratos:latest
       ports:
         - "4433:4433" # Public API
         - "4434:4434" # Admin API
       environment:
         DSN: postgres://ory:${ORY_DB_PASSWORD}@postgres-ory:5432/ory?sslmode=disable
       volumes:
         - ./kratos:/etc/config/kratos
       command: serve -c /etc/config/kratos/kratos.yml
   
     hydra:
       image: oryd/hydra:latest
       ports:
         - "4444:4444" # Public API
         - "4445:4445" # Admin API
       environment:
         DSN: postgres://ory:${ORY_DB_PASSWORD}@postgres-ory:5432/ory?sslmode=disable
         URLS_SELF_ISSUER: https://auth.synap.io
         URLS_CONSENT: https://auth.synap.io/consent
       volumes:
         - ./hydra:/etc/config/hydra
       command: serve all -c /etc/config/hydra/hydra.yml
   ```

2. **`kratos/kratos.yml`** ✨ NOUVEAU
   ```yaml
   version: v1.0.0
   
   identity:
     default_schema_id: default
     schemas:
       default:
         url: file:///etc/config/kratos/identity.schema.json
   
   selfservice:
     methods:
       password:
         enabled: true
       oidc:
         enabled: true
         config:
           providers:
             - id: google
               provider: google
               client_id: ${GOOGLE_CLIENT_ID}
               client_secret: ${GOOGLE_CLIENT_SECRET}
             - id: github
               provider: github
               client_id: ${GITHUB_CLIENT_ID}
               client_secret: ${GITHUB_CLIENT_SECRET}
   
   serve:
     public:
       base_url: https://auth.synap.io
     admin:
       base_url: http://kratos:4434
   ```

3. **`kratos/identity.schema.json`** ✨ NOUVEAU
   ```json
   {
     "$id": "https://schemas.ory.sh/presets/kratos/quickstart/email-password/identity.schema.json",
     "$schema": "http://json-schema.org/draft-07/schema#",
     "title": "Person",
     "type": "object",
     "properties": {
       "traits": {
         "type": "object",
         "properties": {
           "email": {
             "type": "string",
             "format": "email",
             "title": "E-Mail",
             "minLength": 3,
             "ory.sh/kratos": {
               "credentials": {
                 "password": {
                   "identifier": true
                 }
               },
               "verification": {
                 "via": "email"
               },
               "recovery": {
                 "via": "email"
               }
             }
           },
           "name": {
             "type": "string",
             "title": "Name"
           }
         },
         "required": ["email"],
         "additionalProperties": false
       }
     }
   }
   ```

4. **`hydra/hydra.yml`** ✨ NOUVEAU
   ```yaml
   version: v1.0.0
   
   serve:
     public:
       port: 4444
       host: 0.0.0.0
     admin:
       port: 4445
       host: 0.0.0.0
   
   urls:
     self:
       issuer: https://auth.synap.io
     consent: https://auth.synap.io/consent
     login: https://auth.synap.io/login
   
   strategies:
     access_token: jwt
     scope: exact
   
   oauth2:
     expose_internal_errors: false
     hashers:
       algorithm: bcrypt
       bcrypt:
         cost: 12
     grant_types:
       - authorization_code
       - client_credentials
       - refresh_token
       - urn:ietf:params:oauth:grant-type:token-exchange  # Pour websites avec autre provider
   ```

#### **Packages Auth**

5. **`packages/auth/src/ory-kratos.ts`** ✨ NOUVEAU
   ```typescript
   /**
    * Ory Kratos Client - Identity Provider
    * 
    * Handles:
    * - User registration/login
    * - OAuth flows (Google, GitHub)
    * - Session management
    * - Identity management
    */
   
   import { Configuration, FrontendApi, IdentityApi } from '@ory/kratos-client';
   
   const kratosPublicUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';
   const kratosAdminUrl = process.env.KRATOS_ADMIN_URL || 'http://localhost:4434';
   
   // Public API (for user flows)
   export const kratosPublic = new FrontendApi(
     new Configuration({
       basePath: kratosPublicUrl,
     })
   );
   
   // Admin API (for management)
   export const kratosAdmin = new IdentityApi(
     new Configuration({
       basePath: kratosAdminUrl,
     })
   );
   
   /**
    * Get session from Kratos
    */
   export async function getKratosSession(cookie: string): Promise<any | null> {
     try {
       const { data: session } = await kratosPublic.toSession({
         cookie,
       });
       return session;
     } catch (error) {
       return null;
     }
   }
   
   /**
    * Get identity by ID
    */
   export async function getIdentityById(identityId: string): Promise<any | null> {
     try {
       const { data: identity } = await kratosAdmin.getIdentity({ id: identityId });
       return identity;
     } catch (error) {
       return null;
     }
   }
   ```

6. **`packages/auth/src/ory-hydra.ts`** ✨ NOUVEAU
   ```typescript
   /**
    * Ory Hydra Client - OAuth2 Server
    * 
    * Handles:
    * - OAuth2 token management
    * - Client management
    * - Scope validation
    */
   
   import { Configuration, AdminApi, PublicApi } from '@ory/hydra-client';
   
   const hydraPublicUrl = process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444';
   const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';
   
   // Public API (for OAuth2 flows)
   export const hydraPublic = new PublicApi(
     new Configuration({
       basePath: hydraPublicUrl,
     })
   );
   
   // Admin API (for management)
   export const hydraAdmin = new AdminApi(
     new Configuration({
       basePath: hydraAdminUrl,
     })
   );
   
   /**
    * Introspect OAuth2 token
    */
   export async function introspectToken(token: string): Promise<any | null> {
     try {
       const { data } = await hydraPublic.introspectOAuth2Token({
         token,
       });
       return data.active ? data : null;
     } catch (error) {
       return null;
     }
   }
   
   /**
    * Create OAuth2 client
    */
   export async function createOAuth2Client(client: {
     client_id: string;
     client_secret: string;
     grant_types: string[];
     response_types: string[];
     scope: string;
     redirect_uris: string[];
   }) {
     const { data } = await hydraAdmin.createOAuth2Client({
       oAuth2Client: client,
     });
     return data;
   }
   ```

7. **`packages/auth/src/ory-middleware.ts`** ✨ NOUVEAU
   ```typescript
   /**
    * Ory Auth Middleware for Hono
    * 
    * Validates OAuth2 tokens from Hydra and extracts user identity
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
     
     // Introspect token with Hydra
     const tokenInfo = await introspectToken(token);
     
     if (!tokenInfo || !tokenInfo.active) {
       return c.json({ error: 'Invalid or expired token' }, 401);
     }
   
     // Get identity from Kratos
     const identity = await getIdentityById(tokenInfo.sub);
     
     if (!identity) {
       return c.json({ error: 'Identity not found' }, 401);
     }
   
     // Add to context
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

8. **`packages/auth/src/index.ts`** ✏️ MODIFIER
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
   
   // Default export (for PostgreSQL)
   export { oryAuthMiddleware as authMiddleware } from './ory-middleware.js';
   export { getKratosSession as getSession } from './ory-kratos.js';
   ```

9. **`packages/auth/package.json`** ✏️ MODIFIER
   ```json
   {
     "name": "@synap/auth",
     "version": "2.0.0",
     "main": "./src/index.ts",
     "types": "./src/index.ts",
     "dependencies": {
       "@ory/kratos-client": "^1.0.0",
       "@ory/hydra-client": "^2.0.0",
       "hono": "^4.0.0"
     },
     "devDependencies": {
       "typescript": "^5.3.3"
     }
   }
   ```

#### **API Server**

10. **`apps/api/src/index.ts`** ✏️ MODIFIER
    - Remplacer import Better Auth par Ory
    - Remplacer routes `/api/auth/*` par routes Kratos
    - Mettre à jour middleware

11. **`packages/api/src/context.ts`** ✏️ MODIFIER
    - Remplacer `getSession()` par `getKratosSession()`
    - Adapter extraction `userId`

#### **Configuration**

12. **`packages/core/src/config.ts`** ✏️ MODIFIER
    - Remplacer validation Better Auth par validation Ory
    - Ajouter variables d'environnement Ory

13. **`.env.example`** ✏️ MODIFIER
    ```env
    # Ory Kratos
    KRATOS_PUBLIC_URL=http://localhost:4433
    KRATOS_ADMIN_URL=http://localhost:4434
    KRATOS_DSN=postgres://ory:password@localhost:5432/ory?sslmode=disable
   
    # Ory Hydra
    HYDRA_PUBLIC_URL=http://localhost:4444
    HYDRA_ADMIN_URL=http://localhost:4445
    HYDRA_DSN=postgres://ory:password@localhost:5432/ory?sslmode=disable
    HYDRA_SECRETS_SYSTEM=<generate-random-32-char-string>
   
    # OAuth2 Clients
    SYNAP_HUB_CLIENT_ID=synap-hub
    SYNAP_HUB_CLIENT_SECRET=<generate-secret>
   
    # OAuth Providers (unchanged)
    GOOGLE_CLIENT_ID=...
    GOOGLE_CLIENT_SECRET=...
    GITHUB_CLIENT_ID=...
    GITHUB_CLIENT_SECRET=...
    ```

#### **Migrations**

14. **`packages/database/migrations-custom/0013_migrate_to_ory.sql`** ✨ NOUVEAU
    ```sql
    -- Migration script pour migrer les utilisateurs Better Auth vers Kratos
    -- À exécuter après déploiement de Kratos
    
    -- Note: Kratos crée ses propres tables automatiquement
    -- Ce script migre les données depuis Better Auth vers Kratos
    
    -- 1. Créer table temporaire pour mapping
    CREATE TABLE IF NOT EXISTS _migration_user_mapping (
      better_auth_user_id TEXT PRIMARY KEY,
      kratos_identity_id TEXT UNIQUE NOT NULL
    );
    
    -- 2. Migrer utilisateurs (via Kratos Admin API, pas SQL direct)
    -- Voir script Node.js: scripts/migrate-users-to-kratos.ts
    ```

15. **`scripts/migrate-users-to-kratos.ts`** ✨ NOUVEAU
    ```typescript
    /**
     * Migration script: Better Auth → Kratos
     * 
     * Migre les utilisateurs existants de Better Auth vers Kratos
     */
    
    import { IdentityApi, Configuration } from '@ory/kratos-client';
    import { db } from '@synap/database';
    import { user, account, session } from '@synap/database/schema/better-auth';
    
    const kratosAdmin = new IdentityApi(
      new Configuration({
         basePath: process.env.KRATOS_ADMIN_URL!,
       })
     );
    
    async function migrateUsers() {
       // 1. Récupérer tous les utilisateurs Better Auth
       const betterAuthUsers = await db.select().from(user);
    
       for (const user of betterAuthUsers) {
         // 2. Créer identity dans Kratos
         const { data: identity } = await kratosAdmin.createIdentity({
           createIdentityBody: {
             schema_id: 'default',
             traits: {
               email: user.email,
               name: user.name || '',
             },
             credentials: user.password_hash ? {
               password: {
                 hashed_password: user.password_hash, // Si compatible
               },
             } : undefined,
           },
         });
    
         // 3. Migrer OAuth accounts
         const accounts = await db.select()
           .from(account)
           .where(eq(account.user_id, user.id));
    
         for (const account of accounts) {
           // Créer OAuth link dans Kratos
           // (via Kratos Admin API)
         }
    
         console.log(`Migrated user: ${user.email} → ${identity.id}`);
       }
     }
    
     migrateUsers();
    ```

#### **Documentation**

16. **`docs/architecture/ORY_SETUP.md`** ✨ NOUVEAU
    - Guide de setup Ory
    - Configuration
    - Troubleshooting

17. **`docs/architecture/ORY_MIGRATION_GUIDE.md`** ✨ NOUVEAU
    - Guide de migration utilisateurs
    - Checklist
    - Rollback plan

---

## 5. Changements de Flow

### 5.1. Flow d'Authentification Utilisateur

#### **AVANT (Better Auth)**

```
1. User → POST /api/auth/sign-in
2. Better Auth → Vérifie credentials
3. Better Auth → Crée session dans PostgreSQL
4. Better Auth → Retourne cookie de session
5. User → Utilise cookie pour requêtes suivantes
6. API → Extrait userId depuis session cookie
```

#### **APRÈS (Ory Kratos)**

```
1. User → GET /self-service/login/browser (Kratos UI)
2. Kratos → Affiche page de login
3. User → Soumet credentials
4. Kratos → Vérifie credentials
5. Kratos → Crée session
6. Kratos → Redirige avec cookie de session
7. User → Utilise cookie pour requêtes
8. API → Appelle Kratos /sessions/whoami pour valider
9. API → Extrait userId depuis identity
```

**Changements :**
- ✅ Kratos gère l'UI de login (ou custom UI)
- ✅ Sessions gérées par Kratos
- ✅ Validation via API Kratos au lieu de DB directe

### 5.2. Flow OAuth (Google/GitHub)

#### **AVANT (Better Auth)**

```
1. User → GET /api/auth/google
2. Better Auth → Redirige vers Google
3. Google → Callback avec code
4. Better Auth → Exchange code for token
5. Better Auth → Crée/lie compte
6. Better Auth → Crée session
7. Better Auth → Retourne cookie
```

#### **APRÈS (Ory Kratos)**

```
1. User → GET /self-service/methods/oidc?provider=google (Kratos)
2. Kratos → Redirige vers Google
3. Google → Callback vers Kratos
4. Kratos → Exchange code for token
5. Kratos → Crée/lie identity
6. Kratos → Crée session
7. Kratos → Redirige avec cookie
```

**Changements :**
- ✅ Kratos gère le flow OAuth
- ✅ UI Kratos (ou custom)
- ✅ Sessions gérées par Kratos

### 5.3. Flow Hub Protocol (Intelligence Hub → Data Pod)

#### **AVANT (API Keys + JWT)**

```
1. Hub → POST /trpc/hub.generateAccessToken (avec API Key)
2. Data Pod → Valide API Key
3. Data Pod → Génère JWT (5 min TTL)
4. Hub → Utilise JWT pour requêtes
5. Data Pod → Valide JWT
```

#### **APRÈS (OAuth2 Client Credentials)**

```
1. Hub → POST /oauth2/token (Hydra)
   - grant_type: client_credentials
   - client_id: synap-hub
   - client_secret: <secret>
   - scope: read:preferences read:notes ...
2. Hydra → Valide client credentials
3. Hydra → Génère access_token (JWT)
4. Hub → Utilise access_token pour requêtes Data Pod
5. Data Pod → Introspect token avec Hydra
6. Data Pod → Vérifie scopes
7. Data Pod → Retourne données
```

**Changements :**
- ✅ Hub obtient token depuis Hydra (pas Data Pod)
- ✅ Data Pod valide token avec Hydra (pas localement)
- ✅ Scopes gérés par Hydra
- ✅ Standard OAuth2

### 5.4. Flow Agents Tiers (Futur)

#### **APRÈS (OAuth2 Authorization Code)**

```
1. Agent Tiers → Redirige user vers Hydra
   - /oauth2/auth?client_id=agent-xyz&scope=read:notes
2. Hydra → Redirige vers Kratos (si pas logged in)
3. Kratos → User login
4. Hydra → Affiche consent screen
5. User → Consent aux scopes
6. Hydra → Génère authorization_code
7. Agent Tiers → Exchange code for token
8. Agent Tiers → Utilise token pour accéder Data Pod
```

**Nouveau :**
- ✅ Flow OAuth2 standard
- ✅ Consent screen
- ✅ Scopes granulaires

---

## 6. Migration des Données

### 6.1. Stratégie de Migration

**Approche :** Migration progressive lors de l'authentification (Graceful)

1. **Phase 1** : Déployer Ory en parallèle de Better Auth
2. **Phase 2** : Migrer utilisateurs au login
3. **Phase 3** : Désactiver Better Auth

### 6.2. Migration des Utilisateurs

#### **Mapping des Champs**

| Better Auth | Kratos | Notes |
|:---|:---|:---|
| `user.id` | `identity.id` | UUID différent |
| `user.email` | `identity.traits.email` | Identique |
| `user.name` | `identity.traits.name` | Identique |
| `user.password_hash` | `identity.credentials.password` | Format différent |
| `account.provider` | `identity.verifiable_addresses` | Structure différente |

#### **Script de Migration**

Voir `scripts/migrate-users-to-kratos.ts` (section 4.2, fichier #15)

### 6.3. Migration des Sessions

**Approche :** Invalider toutes les sessions Better Auth, forcer re-login

**Raison :** Les sessions Kratos sont incompatibles avec Better Auth

**Impact :** Tous les utilisateurs devront se reconnecter une fois

### 6.4. Migration des OAuth Accounts

**Approche :** Re-lier les comptes OAuth au premier login

**Flow :**
1. User se connecte avec email/password
2. Kratos détecte compte OAuth existant (même email)
3. Kratos propose de lier le compte
4. User accepte → Compte lié

---

## 7. Roadmap d'Implémentation

### Phase 1 : Infrastructure Ory (Semaine 1)

**Objectif :** Déployer Ory Stack (Kratos + Hydra)

#### **Jour 1-2 : Setup Docker**

- [ ] Créer `docker-compose.ory.yml`
- [ ] Créer `kratos/kratos.yml`
- [ ] Créer `kratos/identity.schema.json`
- [ ] Créer `hydra/hydra.yml`
- [ ] Tester déploiement local

#### **Jour 3-4 : Configuration**

- [ ] Configurer Kratos (Email/Password, OAuth)
- [ ] Configurer Hydra (OAuth2 server)
  - [ ] Activer Token Exchange grant type
- [ ] Créer client OAuth2 `synap-hub`
- [ ] Tester flows de base
- [ ] Tester Token Exchange flow

#### **Jour 5 : Documentation**

- [ ] Créer `docs/architecture/ORY_SETUP.md`
- [ ] Documenter configuration
- [ ] Documenter variables d'environnement

**Livrables :**
- ✅ Ory Stack déployé et fonctionnel
- ✅ Client OAuth2 `synap-hub` créé
- ✅ Documentation complète

---

### Phase 2 : Migration Code (Semaine 2)

**Objectif :** Remplacer Better Auth par Ory dans le code

#### **Jour 1-2 : Packages Auth**

- [ ] Créer `packages/auth/src/ory-kratos.ts`
- [ ] Créer `packages/auth/src/ory-hydra.ts`
- [ ] Créer `packages/auth/src/ory-middleware.ts`
- [ ] Modifier `packages/auth/src/index.ts`
- [ ] Modifier `packages/auth/package.json`
- [ ] Tests unitaires

#### **Jour 3-4 : API Server**

- [ ] Modifier `apps/api/src/index.ts`
  - Remplacer routes Better Auth par routes Kratos
  - Adapter middleware
- [ ] Modifier `packages/api/src/context.ts`
  - Remplacer `getSession()` par `getKratosSession()`
- [ ] Tests d'intégration

#### **Jour 5 : Configuration**

- [ ] Modifier `packages/core/src/config.ts`
- [ ] Modifier `.env.example`
- [ ] Mettre à jour documentation

**Livrables :**
- ✅ Code migré vers Ory
- ✅ Tests passent
- ✅ Documentation à jour

---

### Phase 3 : Migration Données (Semaine 3)

**Objectif :** Migrer les utilisateurs existants

#### **Jour 1-2 : Script de Migration**

- [ ] Créer `scripts/migrate-users-to-kratos.ts`
- [ ] Tester sur données de dev
- [ ] Valider mapping des champs

#### **Jour 3-4 : Migration Production**

- [ ] Backup base de données
- [ ] Exécuter migration (staging)
- [ ] Valider résultats
- [ ] Exécuter migration (production)

#### **Jour 5 : Validation**

- [ ] Tester login utilisateurs migrés
- [ ] Tester OAuth flows
- [ ] Vérifier sessions

**Livrables :**
- ✅ Utilisateurs migrés
- ✅ Validation complète
- ✅ Rollback plan prêt

---

### Phase 4 : Hub Protocol avec Hydra (Semaine 4)

**Objectif :** Adapter Hub Protocol pour utiliser Hydra

#### **Jour 1-2 : Hub Protocol Client**

- [ ] Modifier `packages/intelligence-hub/src/clients/hub-protocol-client.ts`
  - Utiliser OAuth2 Client Credentials
  - Obtenir token depuis Hydra
- [ ] Tests

#### **Jour 3-4 : Data Pod Resource Server**

- [ ] Modifier `packages/api/src/routers/hub.ts`
  - Introspect token avec Hydra
  - Vérifier scopes
- [ ] Tests end-to-end

#### **Jour 5 : Documentation**

- [ ] Mettre à jour `docs/architecture/PRDs/HUB_PROTOCOL_V1.md`
- [ ] Documenter flow OAuth2

**Livrables :**
- ✅ Hub Protocol utilise Hydra
- ✅ Tests end-to-end passent
- ✅ Documentation à jour

---

### Phase 5 : Cleanup (Semaine 4 - Fin)

**Objectif :** Nettoyer Better Auth

#### **Jour 1-2 : Suppression**

- [ ] Supprimer `packages/auth/src/better-auth.ts`
- [ ] Supprimer tables Better Auth (après validation)
- [ ] Nettoyer dependencies

#### **Jour 3-4 : Tests Finaux**

- [ ] Tests complets du système
- [ ] Tests de charge
- [ ] Validation sécurité

#### **Jour 5 : Documentation Finale**

- [ ] Mettre à jour tous les docs
- [ ] Créer guide de rollback
- [ ] Documenter changements breaking

**Livrables :**
- ✅ Better Auth complètement supprimé
- ✅ Système validé
- ✅ Documentation complète

---

## 8. Risques et Mitigations

### 8.1. Risques Identifiés

| Risque | Impact | Probabilité | Mitigation |
|:---|:---|:---|:---|
| **Migration utilisateurs échoue** | 🔴 Élevé | Moyenne | Script de migration testé, rollback plan |
| **Sessions invalides** | 🟡 Moyen | Élevée | Communication utilisateurs, re-login forcé |
| **OAuth flows cassés** | 🟡 Moyen | Moyenne | Tests complets, migration progressive |
| **Performance dégradée** | 🟡 Moyen | Faible | Monitoring, optimisation |
| **Hub Protocol cassé** | 🔴 Élevé | Moyenne | Tests end-to-end, migration séparée |

### 8.2. Plan de Rollback

**Si migration échoue :**

1. **Rollback immédiat** : Restaurer Better Auth
2. **Restaurer DB** : Restaurer backup pré-migration
3. **Communication** : Informer utilisateurs
4. **Analyse** : Identifier cause de l'échec
5. **Correction** : Corriger et réessayer

**Checklist Rollback :**
- [ ] Backup DB restauré
- [ ] Better Auth réactivé
- [ ] Routes restaurées
- [ ] Tests de validation
- [ ] Communication utilisateurs

### 8.3. Tests de Validation

**Tests à effectuer avant production :**

- [ ] Login Email/Password
- [ ] Login Google OAuth
- [ ] Login GitHub OAuth
- [ ] Session persistence
- [ ] Logout
- [ ] Hub Protocol (OAuth2)
- [ ] Scopes validation
- [ ] Token expiration
- [ ] Migration utilisateurs
- [ ] Performance (latency)

---

## 9. Checklist Finale

### Avant de Commencer

- [ ] Valider ce plan avec l'équipe
- [ ] Backup base de données
- [ ] Environnement de staging prêt
- [ ] Documentation Ory lue
- [ ] Plan de rollback validé

### Pendant la Migration

- [ ] Tests à chaque étape
- [ ] Monitoring activé
- [ ] Communication utilisateurs
- [ ] Documentation mise à jour

### Après la Migration

- [ ] Tous les tests passent
- [ ] Performance validée
- [ ] Utilisateurs peuvent se connecter
- [ ] Hub Protocol fonctionne
- [ ] Better Auth supprimé
- [ ] Documentation finale

---

## 10. Questions pour Validation

1. **Migration utilisateurs** : Acceptez-vous que tous les utilisateurs doivent se reconnecter une fois ?
2. **UI Login** : Voulez-vous utiliser l'UI Kratos par défaut ou créer une UI custom ?
3. **Timeline** : La timeline de 4 semaines est-elle acceptable ?
4. **Rollback** : Le plan de rollback est-il suffisant ?
5. **Token Exchange** : Acceptez-vous d'implémenter Token Exchange pour permettre aux websites d'utiliser leur propre provider ?

---

## 11. Support Token Exchange (Nouveau)

### 11.1. Pourquoi Token Exchange ?

**Objectif :** Permettre aux websites clients d'utiliser n'importe quel provider OAuth2 (Better Auth, Auth0, Firebase, etc.) tout en gardant la cohérence du Data Pod qui utilise Hydra.

### 11.2. Implémentation

#### **Dans Hydra**

Activer le grant type Token Exchange dans `hydra/hydra.yml` :
```yaml
oauth2:
  grant_types:
    - authorization_code
    - client_credentials
    - refresh_token
    - urn:ietf:params:oauth:grant-type:token-exchange  # ← NOUVEAU
```

#### **Service Token Exchange**

Créer `packages/auth/src/token-exchange.ts` :
```typescript
/**
 * Token Exchange Service
 * 
 * Permet d'échanger un token d'un provider externe (Better Auth, etc.)
 * contre un token Hydra compatible Synap
 */

import { hydraAdmin } from './ory-hydra.js';

export async function exchangeToken(
  subjectToken: string,
  subjectTokenType: string,
  clientId: string,
  requestedScopes: string[]
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  // 1. Valider le token externe (Better Auth, etc.)
  const subjectTokenInfo = await validateExternalToken(subjectToken, subjectTokenType);
  
  if (!subjectTokenInfo) {
    throw new Error('Invalid subject token');
  }
  
  // 2. Demander token exchange à Hydra
  const { data } = await hydraAdmin.introspectOAuth2Token({ token: subjectToken });
  
  // 3. Créer nouveau token avec Hydra
  const { data: newToken } = await hydraAdmin.createOAuth2Token({
     clientId,
     grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
     scope: requestedScopes.join(' '),
     subjectToken,
     subjectTokenType,
  });
  
  return {
    access_token: newToken.access_token!,
    token_type: 'Bearer',
    expires_in: newToken.expires_in || 3600,
  };
}

async function validateExternalToken(token: string, tokenType: string): Promise<any> {
  // Valider selon le type de token
  if (tokenType.includes('better-auth')) {
    // Valider avec Better Auth
    // ...
  }
  // Autres providers...
}
```

#### **Endpoint Token Exchange**

Créer route dans `apps/api/src/index.ts` :
```typescript
// Token Exchange endpoint (pour websites avec autre provider)
app.post('/api/auth/token-exchange', async (c) => {
  const body = await c.req.json();
  
  const { access_token } = await exchangeToken(
    body.subject_token,
    body.subject_token_type,
    body.client_id,
    body.scope?.split(' ') || []
  );
  
  return c.json({
    access_token,
    token_type: 'Bearer',
    expires_in: 3600,
  });
});
```

### 11.3. Documentation pour Websites

Créer `docs/development/WEBSITE_AUTH.md` :
- Guide pour websites utilisant Ory
- Guide pour websites utilisant autre provider (Token Exchange)
- Exemples de code

---

**Prochaine étape** : Valider ce plan (incluant Token Exchange), puis commencer Phase 1 (Infrastructure Ory).

