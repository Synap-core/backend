# Guide de Séparation des Composants Synap

**Date**: 2025-01-XX  
**Objectif**: Séparer proprement les trois composants pour déploiement indépendant

---

## 🎯 Les Trois Composants

### 1. **Data Pod (Open Source)**
- **Rôle**: Gardien des données utilisateur
- **Repository**: `synap-data-pod` (futur)
- **Packages**: `@synap/api`, `@synap/database`, `@synap/core`, `@synap/types`, `@synap/domain`, `@synap/storage`, `@synap/jobs`, `@synap/auth`, `@synap/hub-protocol`, `@synap/hub-protocol-client`, `@synap/hub-orchestrator-base`
- **App**: `apps/api`

### 2. **Intelligence Hub (Propriétaire)**
- **Rôle**: Traitement IA avancé
- **Repository**: `synap-intelligence-hub` (futur)
- **Packages**: `@synap/intelligence-hub`, `@synap/hub-protocol-client`, `@synap/hub-orchestrator-base`
- **App**: `apps/intelligence-hub`

### 3. **Backend App (Propriétaire)**
- **Rôle**: Authentification, paiement, routage
- **Repository**: `synap-backend-app` (futur)
- **Packages**: `@synap/database` (pour subscriptions), `@synap/auth`, `@synap/core`, `@synap/types`
- **App**: `apps/synap-app`

---

## 📦 Packages par Composant

### Data Pod (Open Source)

**Core Packages**:
- `@synap/core` - Configuration, logging, utilities
- `@synap/types` - Types TypeScript partagés
- `@synap/database` - ORM, schémas, repositories
- `@synap/domain` - Logique métier
- `@synap/storage` - Stockage fichiers (MinIO/S3)
- `@synap/auth` - Ory Stack (Kratos + Hydra)
- `@synap/jobs` - Workers Inngest
- `@synap/api` - Routers tRPC
- `@synap/hub-protocol` - Protocole Hub (schémas)
- `@synap/hub-protocol-client` - Client Hub Protocol
- `@synap/hub-orchestrator-base` - Base pour orchestrateurs

**App**:
- `apps/api` - Serveur Hono + tRPC

**Dépendances Externes**:
- PostgreSQL (TimescaleDB + pgvector)
- MinIO (S3-compatible)
- Redis
- Ory Kratos + Hydra
- Inngest

---

### Intelligence Hub (Propriétaire)

**Packages**:
- `@synap/intelligence-hub` - Agents LangGraph, IngestionEngine
- `@synap/hub-protocol-client` - Client pour appeler Data Pod
- `@synap/hub-orchestrator-base` - Base pour orchestrateurs
- `@synap/core` - Configuration, logging
- `@synap/types` - Types partagés
- `@synap/ai` - Intégration AI

**App**:
- `apps/intelligence-hub` - Serveur Hono

**Dépendances Externes**:
- Ory Hydra (pour authentification)
- Anthropic API (Claude)
- OpenAI API (embeddings)

---

### Backend App (Propriétaire)

**Packages**:
- `@synap/database` - Pour table `subscriptions`
- `@synap/auth` - Ory Kratos
- `@synap/core` - Configuration, logging
- `@synap/types` - Types partagés

**App**:
- `apps/synap-app` - Serveur Hono + tRPC

**Dépendances Externes**:
- PostgreSQL (pour subscriptions)
- Ory Kratos (authentification)
- Stripe (paiements - futur)

---

## 🔧 Plan de Séparation

### Étape 1 : Préparer les Repositories

1. **Créer `synap-data-pod`** (GitHub)
2. **Créer `synap-intelligence-hub`** (GitHub privé)
3. **Créer `synap-backend-app`** (GitHub privé)

### Étape 2 : Copier les Packages

#### Data Pod Repository

**Packages à copier**:
```
packages/core/
packages/types/
packages/database/
packages/domain/
packages/storage/
packages/auth/
packages/jobs/
packages/api/
packages/hub-protocol/
packages/hub-protocol-client/
packages/hub-orchestrator-base/
apps/api/
```

**Fichiers racine**:
- `package.json` (monorepo)
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `turbo.json`
- `docker compose.yml` (adapté)
- `.env.example`
- `README.md`

#### Intelligence Hub Repository

**Packages à copier**:
```
packages/intelligence-hub/
packages/hub-protocol-client/ (ou npm package)
packages/hub-orchestrator-base/ (ou npm package)
apps/intelligence-hub/
```

**Fichiers racine**:
- `package.json`
- `tsconfig.json`
- `.env.example`
- `README.md`
- `Dockerfile` (optionnel)

#### Backend App Repository

**Packages à copier**:
```
apps/synap-app/
  - src/database/ (propre base de données)
  - src/services/
  - src/routers/
  - src/trpc/
packages/auth/ (ou npm package)
packages/core/ (ou npm package)
packages/types/ (ou npm package)
```

**Note**: Le Backend App a sa **propre base de données** dans `src/database/`, **séparée** du package `@synap/database` (open-source).

**Fichiers racine**:
- `package.json`
- `tsconfig.json`
- `.env.example`
- `README.md`
- `Dockerfile` (optionnel)

### Étape 3 : Gérer les Dépendances

#### Option A : Packages npm

Publier les packages partagés sur npm :
- `@synap/core`
- `@synap/types`
- `@synap/hub-protocol`
- `@synap/hub-protocol-client`
- `@synap/hub-orchestrator-base`
- `@synap/auth`

#### Option B : Git Submodules

Utiliser git submodules pour partager les packages.

#### Option C : Monorepo Multi-Repository

Garder un monorepo mais avec des repositories séparés pour chaque composant.

---

## 📝 Fichiers à Créer pour Chaque Composant

### Data Pod

1. **`README.md`** - Documentation open-source
2. **`.env.example`** - Variables d'environnement
3. **`docker compose.yml`** - Services locaux
4. **`CONTRIBUTING.md`** - Guide contributeurs
5. **`LICENSE`** - MIT License

### Intelligence Hub

1. **`README.md`** - Documentation interne
2. **`.env.example`** - Variables d'environnement
3. **`Dockerfile`** - Image Docker
4. **`docker compose.yml`** - Services locaux

### Backend App

1. **`README.md`** - Documentation interne
2. **`.env.example`** - Variables d'environnement
3. **`Dockerfile`** - Image Docker
4. **`docker compose.yml`** - Services locaux

---

## 🚀 Scripts de Démarrage

### Data Pod

```bash
# Installer dépendances
pnpm install

# Démarrer services (PostgreSQL, MinIO, Redis, Ory)
docker compose up -d

# Appliquer migrations
pnpm db:migrate

# Démarrer serveur
pnpm --filter api dev
```

### Intelligence Hub

```bash
# Installer dépendances
pnpm install

# Démarrer serveur
pnpm --filter intelligence-hub dev
```

### Backend App

```bash
# Installer dépendances
pnpm install

# Démarrer services (PostgreSQL, Ory)
docker compose up -d

# Appliquer migrations
pnpm db:migrate

# Démarrer serveur
pnpm --filter synap-app dev
```

---

## 🔐 Variables d'Environnement

Voir les fichiers `.env.example` dans chaque composant.

---

## 📚 Documentation

Chaque composant aura sa propre documentation :
- **Data Pod**: Documentation open-source complète
- **Intelligence Hub**: Documentation interne
- **Backend App**: Documentation interne

---

## ✅ Checklist de Séparation

- [ ] Créer repositories GitHub
- [ ] Copier packages appropriés
- [ ] Créer README pour chaque composant
- [ ] Créer .env.example pour chaque composant
- [ ] Créer docker compose.yml pour chaque composant
- [ ] Publier packages npm partagés (ou utiliser git submodules)
- [ ] Tester chaque composant indépendamment
- [ ] Tester le flow complet (Backend App → Intelligence Hub → Data Pod)
- [ ] Documenter l'architecture globale

---

**Prochaine étape**: Créer les fichiers de démarrage et documentation pour chaque composant.

