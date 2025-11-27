# Backend App Database Architecture

**Date**: 2025-01-XX  
**Objectif**: Documenter la base de données du Backend App (propriétaire)

---

## 🎯 Principe

Le **Backend App** utilise sa **propre base de données**, **séparée** de celle du Data Pod (open-source).

**Pourquoi ?**
- Le Backend App est **propriétaire** (subscriptions, paiements)
- Le Data Pod est **open-source** (données utilisateur)
- **Séparation claire** des responsabilités
- **Isolation** des données propriétaires

---

## 📊 Structure

### Base de Données

Le Backend App utilise une **base PostgreSQL séparée** :
- **Variable d'environnement**: `BACKEND_APP_DATABASE_URL`
- **Fallback**: `DATABASE_URL` (si `BACKEND_APP_DATABASE_URL` n'est pas défini)

### Tables

#### 1. `subscriptions`

Stoque les abonnements utilisateurs.

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'inactive',
  plan VARCHAR(50) NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**Champs**:
- `id`: ID unique (CUID2)
- `user_id`: ID utilisateur (Ory Kratos identity ID)
- `status`: 'active', 'inactive', 'cancelled', 'expired'
- `plan`: 'free', 'pro', 'business'
- `stripe_customer_id`: ID client Stripe
- `stripe_subscription_id`: ID abonnement Stripe
- `current_period_start`: Début période actuelle
- `current_period_end`: Fin période actuelle
- `cancel_at_period_end`: Annulation à la fin de la période

#### 2. `user_config`

Stoque la configuration utilisateur (Data Pod URL, API keys).

```sql
CREATE TABLE user_config (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  data_pod_url TEXT,
  data_pod_api_key TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**Champs**:
- `id`: ID unique (CUID2)
- `user_id`: ID utilisateur (Ory Kratos identity ID)
- `data_pod_url`: URL du Data Pod de l'utilisateur
- `data_pod_api_key`: API key pour Hub Protocol

---

## 🔧 Implémentation

### Schéma (Drizzle ORM)

**Fichier**: `apps/synap-app/src/database/schema.ts`

```typescript
import { pgTable, text, timestamp, boolean, varchar } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().unique(),
  status: varchar('status', { length: 20 }).notNull().default('inactive'),
  plan: varchar('plan', { length: 50 }).notNull().default('free'),
  // ...
});

export const userConfig = pgTable('user_config', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().unique(),
  dataPodUrl: text('data_pod_url'),
  dataPodApiKey: text('data_pod_api_key'),
  // ...
});
```

### Client Database

**Fichier**: `apps/synap-app/src/database/client.ts`

```typescript
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema.js';

const databaseUrl = process.env.BACKEND_APP_DATABASE_URL || process.env.DATABASE_URL;
const sql = neon(databaseUrl);
export const db = drizzle(sql, { schema });
```

### Migrations

**Fichier**: `apps/synap-app/src/database/migrations/001_create_subscriptions.sql`

Les migrations sont appliquées via :
```bash
pnpm --filter synap-app db:migrate
```

---

## 🚀 Utilisation

### Dans le Code

```typescript
import { db, subscriptions, userConfig } from './database/client.js';
import { eq } from 'drizzle-orm';

// Vérifier abonnement
const subscription = await db
  .select()
  .from(subscriptions)
  .where(eq(subscriptions.userId, userId))
  .limit(1);

// Récupérer config utilisateur
const config = await db
  .select()
  .from(userConfig)
  .where(eq(userConfig.userId, userId))
  .limit(1);
```

---

## 🔐 Sécurité

- **Isolation**: Base de données séparée du Data Pod
- **Pas de RLS**: Pas nécessaire (une seule application)
- **Backup**: À configurer séparément

---

## 📝 Migration depuis l'Ancien Système

Si vous aviez la table `subscriptions` dans le Data Pod :

1. **Exporter les données** :
   ```sql
   COPY subscriptions TO '/tmp/subscriptions.csv' CSV HEADER;
   ```

2. **Créer la nouvelle base** :
   ```bash
   createdb synap_backend_app
   ```

3. **Appliquer les migrations** :
   ```bash
   BACKEND_APP_DATABASE_URL=postgresql://... pnpm --filter synap-app db:migrate
   ```

4. **Importer les données** :
   ```sql
   COPY subscriptions FROM '/tmp/subscriptions.csv' CSV HEADER;
   ```

---

## ✅ Avantages

1. **Séparation claire** : Données propriétaires isolées
2. **Indépendance** : Backend App peut évoluer indépendamment
3. **Sécurité** : Pas d'accès aux données utilisateur
4. **Scalabilité** : Base de données dédiée

---

**Dernière mise à jour**: 2025-01-XX

