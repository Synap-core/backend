# Getting Started

**Guides pour démarrer avec Synap Backend**

---

## 📚 Guides Disponibles

### [Quick Start Guide](./QUICKSTART.md)
Guide rapide en 3 étapes pour lancer le backend en développement local.

**Temps estimé :** 5-10 minutes

**Inclut :**
- Installation des dépendances
- Configuration de l'environnement
- Démarrage des services (Docker)
- Lancement du backend
- Test de l'API

### [Setup Guide](./SETUP.md)
Guide complet de configuration pour développement local et production.

**Temps estimé :** 15-30 minutes

**Inclut :**
- Configuration locale (SQLite + MinIO)
- Configuration production (PostgreSQL + R2)
- Variables d'environnement
- Tests
- Troubleshooting

---

## 🎯 Par Où Commencer ?

### Nouveau sur Synap ?
1. Commencez par le **[Quick Start Guide](./QUICKSTART.md)**
2. Si vous avez besoin de plus de détails, consultez le **[Setup Guide](./SETUP.md)**

### Développeur Expérimenté ?
- Allez directement au **[Quick Start Guide](./QUICKSTART.md)** pour un démarrage rapide

---

## 📋 Prérequis

Avant de commencer, assurez-vous d'avoir :

- ✅ **Node.js 20+** et **pnpm 8+**
- ✅ **Docker Desktop** installé et démarré
- ✅ **Clés API** :
  - Anthropic API key (pour l'IA)
  - OpenAI API key (pour les embeddings)

---

## 🚀 Démarrage Rapide (Résumé)

```bash
# 1. Cloner et installer
git clone <repo>
cd synap-backend
pnpm install

# 2. Configurer l'environnement
cp env.local.example .env
# Éditer .env et ajouter vos clés API

# 3. Démarrer MinIO
docker compose up -d minio

# 4. Initialiser la base de données
pnpm --filter database db:init

# 5. Lancer le backend
pnpm dev
```

Pour plus de détails, voir le **[Quick Start Guide](./QUICKSTART.md)**.

---

## 📖 Documentation Complète

- **[Architecture](../architecture/README.md)** - Comprendre l'architecture
- **[Development](../development/README.md)** - Guides pour développeurs
- **[Deployment](../deployment/README.md)** - Guides de déploiement

