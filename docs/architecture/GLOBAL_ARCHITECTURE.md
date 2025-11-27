# Architecture Globale - Synap Ecosystem V1.0

**Date**: 2025-01-XX  
**Version**: 1.0.0  
**Statut**: Production Ready

---

## 🎯 Vision

L'écosystème Synap est un système distribué et fédéré qui sépare la **possession des données** (Data Pod open-source) de la **fourniture d'intelligence** (Intelligence Hub propriétaire), avec un **Backend App** qui gère l'authentification et le paiement.

---

## 🏗️ Architecture en 3 Composants

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend Application                     │
│              (Next.js, Expo, Web, etc.)                    │
└──────────────┬──────────────────────┬──────────────────────┘
               │                      │
               │                      │
    ┌──────────▼──────────┐  ┌───────▼──────────┐
    │   Backend App       │  │   Data Pod       │
    │   (Propriétaire)    │  │   (Open Source)  │
    │                     │  │                  │
    │ - Auth (Ory)        │  │ - Event Store    │
    │ - Payment           │  │ - Projections    │
    │ - Routing           │  │ - Hub Protocol   │
    └──────────┬──────────┘  │ - Plugins        │
               │             └────────┬──────────┘
               │                      │
               │  Request Expertise   │
               └──────────┬───────────┘
                          │
                ┌─────────▼──────────┐
                │ Intelligence Hub  │
                │  (Propriétaire)   │
                │                   │
                │ - IngestionEngine │
                │ - Agents          │
                │ - LangGraph       │
                └─────────┬──────────┘
                          │
                          │ Submit Insights
                          │
                ┌─────────▼──────────┐
                │   Data Pod         │
                │   (Open Source)    │
                │                     │
                │ - Apply Events     │
                │ - Update State     │
                └────────────────────┘
```

---

## 📦 Composants Détaillés

### 1. Data Pod (Open Source)

**Rôle**: Gardien souverain des données utilisateur

**Technologies**:
- Hono (serveur web)
- tRPC (API type-safe)
- Drizzle ORM (base de données)
- PostgreSQL + TimescaleDB + pgvector
- Inngest (workers)
- Ory Stack (auth)

**Capacités**:
- Event Store (TimescaleDB)
- Projections (PostgreSQL)
- Hub Protocol (communication avec Hubs)
- Plugin System (extensibilité)
- Semantic Search (pgvector)

**Packages**:
- `@synap/api` - Routers tRPC
- `@synap/database` - ORM, schémas
- `@synap/domain` - Logique métier
- `@synap/jobs` - Workers Inngest
- `@synap/hub-protocol` - Protocole Hub

**Port**: 3000

---

### 2. Intelligence Hub (Propriétaire)

**Rôle**: Traitement IA avancé à la demande

**Technologies**:
- Hono (serveur web)
- LangGraph (orchestration agents)
- Anthropic Claude (LLM)
- OpenAI (embeddings)
- Ory Hydra (OAuth2)

**Capacités**:
- IngestionEngine (analyse de pensées)
- ActionExtractor (extraction d'actions)
- KnowledgeSynthesizer (RAG)
- ProjectPlanner (planification)

**Packages**:
- `@synap/intelligence-hub` - Agents LangGraph
- `@synap/hub-protocol-client` - Client Hub Protocol

**Port**: 3002

---

### 3. Backend App (Propriétaire)

**Rôle**: Authentification, paiement, routage

**Technologies**:
- Hono (serveur web)
- tRPC (API type-safe)
- Ory Kratos (authentification)
- PostgreSQL (propre base de données)
- Drizzle ORM (pour sa propre DB)
- Stripe (paiements - futur)

**Capacités**:
- Authentification utilisateurs
- Gestion abonnements
- Routage vers Intelligence Hub
- API pour frontend

**Base de Données**:
- **Séparée** du Data Pod
- Tables: `subscriptions`, `user_config`
- Variable: `BACKEND_APP_DATABASE_URL`

**Packages**:
- `@synap/auth` - Ory Kratos
- `@synap/core` - Configuration, logging
- `@synap/types` - Types partagés
- **Pas de `@synap/database`** (utilise sa propre DB)

**Port**: 3001

---

## 🔄 Flow 2 : Backend First

### Flow Complet

```
1. User → Backend App: capture.thought
   ↓
2. Backend App:
   - Authentifie (Ory Kratos)
   - Vérifie abonnement (DB propriétaire)
   - Si non abonné → Erreur
   ↓
3. Backend App → Intelligence Hub:
   POST /api/expertise/request
   {
     query: content,
     userId,
     dataPodUrl,
     dataPodApiKey
   }
   ↓
4. Intelligence Hub:
   - Génère token via Hub Protocol
   - Récupère données utilisateur
   - Traite avec IngestionEngine
   - Génère événements
   ↓
5. Intelligence Hub → Data Pod:
   - Soumet insights (un par événement)
   ↓
6. Data Pod:
   - Transforme insights → événements
   - Applique événements (Event Store)
   - Met à jour projections
   ↓
7. Data Pod → Backend App:
   - Notifie (WebSocket/SSE)
   ↓
8. Backend App → User:
   - Affiche résultat
```

---

## 🔐 Sécurité

### Authentification

- **Ory Kratos**: Authentification utilisateurs (Backend App, Data Pod)
- **Ory Hydra**: OAuth2 pour Intelligence Hub
- **API Keys**: Authentification Hub Protocol

### Isolation

- **Row-Level Security (RLS)**: Isolation données par utilisateur
- **Scopes**: Permissions granulaires (Hub Protocol)
- **Tokens temporaires**: 5 minutes max (Hub Protocol)

---

## 📊 Base de Données

### Data Pod

- **PostgreSQL** avec TimescaleDB (time-series)
- **pgvector** (embeddings)
- **RLS** (multi-tenant)

### Backend App

- **PostgreSQL** (subscriptions uniquement)

### Intelligence Hub

- **Pas de stockage permanent** (données en mémoire uniquement)

---

## 🔌 Extensibilité

### Plugin System (Data Pod)

Les power users peuvent créer des plugins pour :
- **REST**: Appeler services externes
- **Agents**: Ajouter agents LangGraph locaux
- **API**: Ajouter endpoints tRPC
- **Tools**: Ajouter outils AI

### Hub Protocol

Standardisé pour permettre :
- Intelligence Hub Synap
- Hubs tiers
- Services marketplace

---

## 🚀 Déploiement

### Développement Local

```bash
# Démarrer services
docker compose up -d

# Migrations
pnpm db:migrate

# Démarrer apps
pnpm --filter api dev
pnpm --filter intelligence-hub dev
pnpm --filter synap-app dev
```

### Production

Chaque composant peut être déployé indépendamment :
- **Data Pod**: Self-hosted ou cloud
- **Intelligence Hub**: Cloud (propriétaire)
- **Backend App**: Cloud (propriétaire)

---

## 📚 Documentation

- [Getting Started](../GETTING_STARTED.md)
- [Flow 2 Architecture](./FLOW_2_ARCHITECTURE.md)
- [Backend App Guide](../development/BACKEND_APP_GUIDE.md)
- [Plugin System](../development/PLUGIN_SYSTEM.md)
- [Separation Guide](./SEPARATION_GUIDE.md)

---

## ✅ Statut

**✅ Production Ready**

Tous les composants sont implémentés et testés. Prêt pour la séparation et le déploiement.

---

**Dernière mise à jour**: 2025-01-XX

