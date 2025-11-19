# Docker Compose - Déploiement en Une Commande

**Version :** 1.0 | **Date :** 2025-01-20

Ce document valide et documente le `docker-compose.yml` pour permettre un déploiement self-hosted du Synap Core OS en une seule commande.

---

## 📋 Vue d'Ensemble

Le `docker-compose.yml` actuel configure :

1. **PostgreSQL + TimescaleDB** : Base de données principale
2. **MinIO** : Stockage objet S3-compatible (pour développement local)
3. **MinIO Client** : Initialisation automatique du bucket

**Note :** Le backend API n'est **pas** inclus dans Docker Compose. Il doit être lancé séparément avec `pnpm dev` car il nécessite Node.js et les dépendances npm.

---

## ✅ Validation du docker-compose.yml Actuel

### Services Configurés

#### 1. PostgreSQL + TimescaleDB

```yaml
postgres:
  image: timescale/timescaledb:latest-pg16
  container_name: synap-postgres
  environment:
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-synap_dev_password}
    POSTGRES_DB: synap
  ports:
    - "5432:5432"
  volumes:
    - ./data/postgres:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U postgres"]
    interval: 10s
    timeout: 5s
    retries: 5
  restart: unless-stopped
```

**✅ Validation :**
- ✅ Image TimescaleDB (extension PostgreSQL pour time-series)
- ✅ Variables d'environnement configurables
- ✅ Volume persistant pour les données
- ✅ Healthcheck pour vérifier que la DB est prête
- ✅ Port exposé (5432)

#### 2. MinIO (Stockage Objet)

```yaml
minio:
  image: minio/minio:latest
  container_name: synap-minio
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
    MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
  ports:
    - "9000:9000"  # S3 API endpoint
    - "9001:9001"  # Web console
  volumes:
    - ./data/notes:/data
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
    interval: 30s
    timeout: 20s
    retries: 3
  restart: unless-stopped
```

**✅ Validation :**
- ✅ Image MinIO (S3-compatible)
- ✅ Console web sur port 9001
- ✅ API S3 sur port 9000
- ✅ Volume persistant
- ✅ Healthcheck
- ✅ Credentials configurables

#### 3. MinIO Client (Initialisation)

```yaml
minio-client:
  image: minio/mc:latest
  container_name: synap-minio-client
  depends_on:
    - minio
  entrypoint: >
    /bin/sh -c "
    sleep 5;
    /usr/bin/mc alias set local http://minio:9000 minioadmin minioadmin;
    /usr/bin/mc mb local/synap-storage --ignore-existing;
    /usr/bin/mc anonymous set download local/synap-storage;
    exit 0;
    "
  restart: "no"
```

**✅ Validation :**
- ✅ Crée automatiquement le bucket `synap-storage`
- ✅ Configure les permissions (download public)
- ✅ S'exécute une seule fois (`restart: "no"`)

---

## 🚀 Utilisation

### Démarrage Rapide

```bash
# 1. Démarrer tous les services
docker compose up -d

# 2. Vérifier que tout est démarré
docker compose ps

# 3. Voir les logs
docker compose logs -f

# 4. Arrêter les services
docker compose down
```

### Variables d'Environnement

Créez un fichier `.env` à la racine (optionnel) :

```env
POSTGRES_PASSWORD=your_secure_password
MINIO_ROOT_USER=admin
MINIO_ROOT_PASSWORD=your_minio_password
```

**Note :** Si `.env` n'existe pas, les valeurs par défaut sont utilisées.

### Accès aux Services

- **PostgreSQL** : `postgresql://postgres:synap_dev_password@localhost:5432/synap`
- **MinIO API** : `http://localhost:9000`
- **MinIO Console** : `http://localhost:9001` (login: `minioadmin` / `minioadmin`)

---

## 🔧 Configuration Backend

Après avoir démarré Docker Compose, configurez le backend :

### Fichier `.env` du Backend

```env
# Database
DB_DIALECT=postgres
DATABASE_URL=postgresql://postgres:synap_dev_password@localhost:5432/synap

# Storage (MinIO)
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=synap-storage
MINIO_USE_SSL=false
```

### Lancer le Backend

```bash
# Initialiser la base de données
pnpm --filter database db:push

# Lancer le backend
pnpm dev
```

---

## 📦 Améliorations Recommandées

### 1. Ajouter un Service Backend (Optionnel)

Si vous voulez tout lancer en Docker, ajoutez :

```yaml
api:
  build:
    context: .
    dockerfile: Dockerfile
  container_name: synap-api
  depends_on:
    postgres:
      condition: service_healthy
    minio:
      condition: service_healthy
  environment:
    DATABASE_URL: postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/synap
    STORAGE_PROVIDER: minio
    MINIO_ENDPOINT: http://minio:9000
    # ... autres variables
  ports:
    - "3000:3000"
  restart: unless-stopped
```

**Note :** Cela nécessite un `Dockerfile` pour le backend.

### 2. Ajouter un Service Inngest (Optionnel)

Pour un déploiement complet, ajoutez Inngest :

```yaml
inngest:
  image: inngest/inngest:latest
  container_name: synap-inngest
  environment:
    INNGEST_EVENT_KEY: ${INNGEST_EVENT_KEY}
    INNGEST_SIGNING_KEY: ${INNGEST_SIGNING_KEY}
  ports:
    - "8288:8288"
  restart: unless-stopped
```

**Note :** Inngest peut aussi être utilisé en mode cloud (recommandé pour production).

### 3. Ajouter un Service Redis (Optionnel)

Pour le cache et les sessions :

```yaml
redis:
  image: redis:7-alpine
  container_name: synap-redis
  ports:
    - "6379:6379"
  volumes:
    - ./data/redis:/data
  restart: unless-stopped
```

---

## ✅ Checklist de Validation

- [x] PostgreSQL + TimescaleDB configuré
- [x] MinIO configuré avec console web
- [x] Volumes persistants pour les données
- [x] Healthchecks pour tous les services
- [x] Variables d'environnement configurables
- [x] Initialisation automatique du bucket MinIO
- [ ] Service backend (optionnel, nécessite Dockerfile)
- [ ] Service Inngest (optionnel)
- [ ] Service Redis (optionnel)

---

## 🎯 Conclusion

Le `docker-compose.yml` actuel est **valide** pour un déploiement self-hosted de base. Il configure :
- ✅ Base de données PostgreSQL + TimescaleDB
- ✅ Stockage objet MinIO
- ✅ Initialisation automatique

**Pour un déploiement complet en une commande**, il faudrait :
1. Créer un `Dockerfile` pour le backend
2. Ajouter le service `api` dans `docker-compose.yml`
3. (Optionnel) Ajouter Inngest et Redis

**Recommandation :** Pour l'instant, le backend reste à lancer avec `pnpm dev` car il nécessite Node.js et les dépendances npm. Pour un déploiement production, créer un `Dockerfile` multi-stage serait idéal.

---

**Prochaine étape :** Créer un `Dockerfile` et ajouter le service `api` au `docker-compose.yml` pour un déploiement complet en une commande.

