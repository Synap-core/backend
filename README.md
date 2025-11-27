# Synap Data Pod - Open Source

**Event-Sourced Knowledge Backend - Open Source Data Pod**

---

## 🎯 Vue d'Ensemble

Ce repository contient le **Data Pod** (open source) de Synap, qui est le gardien des données utilisateur.

**Note**: Les autres composants (Intelligence Hub et Backend App) sont dans des repositories séparés :
- **Intelligence Hub** (Propriétaire) - Repository séparé
- **Backend App** (Propriétaire) - Repository séparé

---

## 🚀 Démarrage Rapide

### Prérequis

- Node.js >= 20
- pnpm >= 8.15.0
- Docker & Docker Compose

### Installation

```bash
# 1. Cloner le repository
git clone <repository-url>
cd synap-backend

# 2. Installer les dépendances
pnpm install

# 3. Configurer l'environnement
cp .env.example .env
# Éditer .env avec vos valeurs

# 4. Démarrer les services Docker
docker compose up -d

# 5. Appliquer les migrations
pnpm db:migrate

# 6. Créer le client OAuth2 pour Intelligence Hub
pnpm create:hub-client

# 7. Démarrer tous les services
./scripts/start-all.sh
```

### Services

- **Data Pod**: http://localhost:3000
- **Ory Kratos**: http://localhost:4433
- **Ory Hydra**: http://localhost:4444

---

## 📚 Documentation

### Guides Principaux

- **[Getting Started](./docs/GETTING_STARTED.md)** - Guide de démarrage complet
- **[Architecture Globale](./docs/architecture/GLOBAL_ARCHITECTURE.md)** - Vue d'ensemble de l'architecture
- **[Flow 2 Implementation](./docs/architecture/FLOW_2_IMPLEMENTATION_COMPLETE.md)** - Implémentation du Flow 2

### Guides Développeurs

- **[Backend App Guide](./docs/development/BACKEND_APP_GUIDE.md)** - Guide pour le Backend App
- **[Plugin System](./docs/development/PLUGIN_SYSTEM.md)** - Guide système de plugins

### Guides de Séparation

- **[Separation Guide](./docs/architecture/SEPARATION_GUIDE.md)** - Comment séparer les composants

---

## 🏗️ Architecture

```
Frontend App
    ↓
Backend App (Auth, Payment) → Intelligence Hub (AI) → Data Pod (Storage)
```

**Ce repository contient uniquement le Data Pod (open source).**

**Flow 2 (Backend First)**:
1. User → Backend App (vérifie abonnement)
2. Backend App → Intelligence Hub (traite IA)
3. Intelligence Hub → Data Pod (applique événements)

---

## 📦 Packages

### Open Source (Data Pod)

- `@synap/api` - Routers tRPC
- `@synap/database` - ORM, schémas
- `@synap/core` - Configuration, logging
- `@synap/types` - Types TypeScript
- `@synap/domain` - Logique métier
- `@synap/storage` - Stockage fichiers
- `@synap/auth` - Ory Stack
- `@synap/jobs` - Workers Inngest
- `@synap/hub-protocol` - Protocole Hub
- `@synap/hub-protocol-client` - Client Hub Protocol
- `@synap/hub-orchestrator-base` - Base orchestrateurs

### Propriétaire

- `@synap/intelligence-hub` - Agents LangGraph

---

## 🔧 Scripts

```bash
# Développement
pnpm dev                    # Démarrer tous les services en dev
pnpm build                  # Build tous les packages
pnpm test                   # Tests unitaires
pnpm test:e2e               # Tests E2E

# Database
pnpm db:migrate             # Appliquer migrations
pnpm db:studio              # Ouvrir Drizzle Studio

# Ory
pnpm create:hub-client      # Créer client OAuth2 pour Hub
```

---

## 🔐 Sécurité

- **Ory Kratos**: Authentification utilisateurs
- **Ory Hydra**: OAuth2 pour services
- **Row-Level Security**: Isolation données par utilisateur
- **API Keys**: Authentification Hub Protocol
- **Tokens temporaires**: 5 minutes max

---

## 🚀 Déploiement

Chaque composant peut être déployé indépendamment :

- **Data Pod**: Self-hosted ou cloud
- **Intelligence Hub**: Cloud (propriétaire)
- **Backend App**: Cloud (propriétaire)

Voir [Separation Guide](./docs/architecture/SEPARATION_GUIDE.md) pour plus de détails.

---

## 📊 Statut

**✅ Production Ready**

- [x] Flow 2 implémenté
- [x] Backend App créé
- [x] Intelligence Hub modifié
- [x] Data Pod avec plugins
- [x] Documentation complète
- [x] Scripts de démarrage

---

## 🤝 Contribution

Le Data Pod est open-source. Voir [CONTRIBUTING.md](./CONTRIBUTING.md) pour plus d'informations.

---

## 📄 License

- **Data Pod**: MIT License (Open Source)
- **Intelligence Hub**: Proprietary
- **Backend App**: Proprietary

---

**Dernière mise à jour**: 2025-01-XX
