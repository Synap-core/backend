# Getting Started - Synap Backend Ecosystem

**Guide de démarrage rapide pour l'écosystème Synap complet**

---

## 🎯 Vue d'Ensemble

Ce repository contient le **Data Pod** (Open Source) de Synap.

**Note**: Les autres composants sont dans des repositories séparés :
- **Intelligence Hub** (Propriétaire) - Repository séparé
- **Backend App** (Propriétaire) - Repository séparé

---

## 📋 Prérequis

- Node.js >= 20
- pnpm >= 8.15.0
- Docker & Docker Compose
- PostgreSQL 16 (via Docker)
- Redis (via Docker)
- MinIO (via Docker)
- Ory Kratos + Hydra (via Docker)

---

## 🚀 Démarrage Rapide

### 1. Cloner le Repository

```bash
git clone <repository-url>
cd synap-backend
```

### 2. Installer les Dépendances

```bash
pnpm install
```

### 3. Configurer l'Environnement

```bash
cp .env.example .env
# Éditer .env avec vos valeurs
```

### 4. Démarrer les Services Docker

```bash
docker compose up -d
```

Cela démarre :
- PostgreSQL (port 5432)
- PostgreSQL Ory (port 5433)
- MinIO (ports 9000, 9001)
- Redis (port 6379)
- Ory Kratos (ports 4433, 4434)
- Ory Hydra (ports 4444, 4445)

### 5. Appliquer les Migrations

```bash
pnpm db:migrate
```

### 6. Démarrer le Data Pod

```bash
pnpm --filter api dev
```

Le serveur démarre sur `http://localhost:3000`

---

## 🧪 Tester le Data Pod

### 1. Créer un Utilisateur (via Ory Kratos)

```bash
curl -X POST http://localhost:4433/self-service/registration?flow=default \
  -H "Content-Type: application/json" \
  -d '{
    "traits": {
      "email": "test@example.com",
      "name": "Test User"
    },
    "password": "testpassword123"
  }'
```

### 2. Créer un API Key (pour Hub Protocol)

```bash
# Via l'API tRPC ou l'admin UI
curl -X POST http://localhost:3000/trpc/apiKeys.create \
  -H "Cookie: <session-cookie>"
```

### 3. Capturer une Pensée

```bash
curl -X POST http://localhost:3000/trpc/capture.thought \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie>" \
  -d '{
    "content": "Create a task to call Paul tomorrow"
  }'
```

### 4. Vérifier les Événements

```bash
curl http://localhost:3000/trpc/events.list \
  -H "Cookie: <session-cookie>"
```

---

## 📊 Ports et Endpoints

### Data Pod (Port 3000)

- **API**: `http://localhost:3000/trpc`
- **Health**: `http://localhost:3000/health`
- **Ory Kratos**: `http://localhost:4433`
- **Ory Hydra**: `http://localhost:4444`

---

## 🔧 Configuration

### Variables d'Environnement Principales

```bash
# Database (Data Pod - open-source)
DATABASE_URL=postgresql://postgres:synap_dev_password@localhost:5432/synap

# Ory
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445

```

---

## 🐛 Dépannage

### Services Docker ne démarrent pas

```bash
docker compose down
docker compose up -d
docker compose logs
```

### Migrations échouent

**Data Pod**:
```bash
# Vérifier la connexion à la base
psql $DATABASE_URL

# Réappliquer les migrations
pnpm db:migrate
```


### Erreurs d'authentification

```bash
# Vérifier Ory Kratos
curl http://localhost:4433/health/ready

# Vérifier Ory Hydra
curl http://localhost:4444/health/ready
```

---

## 📚 Documentation Complémentaire

- [Architecture Globale](./architecture/GLOBAL_ARCHITECTURE.md)
- [Guide Plugins](./development/PLUGIN_SYSTEM.md)
- [Guide de Séparation](./architecture/SEPARATION_GUIDE.md)

---

## ✅ Prochaines Étapes

1. Tester le Data Pod
2. Configurer le frontend
3. Connecter à Intelligence Hub (optionnel, via Hub Protocol)

---

**Besoin d'aide ?** Consultez la documentation ou ouvrez une issue.

