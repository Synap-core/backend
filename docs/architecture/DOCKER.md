# Docker - Guide Complet

**Date**: 2025-01-XX  
**Version**: 1.0

---

## 📋 Vue d'Ensemble

Le `docker compose.yml` configure les services nécessaires pour le Data Pod :

1. **PostgreSQL + TimescaleDB** : Base de données principale
2. **MinIO** : Stockage objet S3-compatible
3. **Redis** : Cache et sessions
4. **Ory Kratos** : Authentification
5. **Ory Hydra** : OAuth2 Server

**Note** : Le backend API n'est **pas** inclus dans Docker Compose. Il doit être lancé séparément avec `pnpm dev` car il nécessite Node.js et les dépendances npm.

---

## 🚀 Démarrage Rapide

### 1. Démarrer tous les services

```bash
docker compose up -d
```

### 2. Vérifier que tout est démarré

```bash
docker compose ps
```

### 3. Voir les logs

```bash
docker compose logs -f
```

### 4. Arrêter les services

```bash
docker compose down
```

---

## 🔧 Configuration

### Variables d'Environnement

Créez un fichier `.env` à la racine (optionnel) :

```env
# PostgreSQL
POSTGRES_PASSWORD=your_secure_password
POSTGRES_USER=postgres
POSTGRES_DB=synap

# MinIO
MINIO_ROOT_USER=admin
MINIO_ROOT_PASSWORD=your_minio_password

# Redis
REDIS_PASSWORD=your_redis_password
```

**Note** : Si `.env` n'existe pas, les valeurs par défaut sont utilisées.

### Configuration Backend

Après avoir démarré Docker Compose, configurez le backend dans `.env` :

```env
# Database
DATABASE_URL=postgresql://postgres:synap_dev_password@localhost:5432/synap

# Storage (MinIO)
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=synap-storage
MINIO_USE_SSL=false

# Redis
REDIS_URL=redis://localhost:6379

# Ory Kratos
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434

# Ory Hydra
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445
```

---

## 📊 Services

### PostgreSQL + TimescaleDB

- **Port** : `5432`
- **URL** : `postgresql://postgres:synap_dev_password@localhost:5432/synap`
- **Extension** : TimescaleDB pour time-series

### MinIO

- **API** : `http://localhost:9000`
- **Console** : `http://localhost:9001` (login: `minioadmin` / `minioadmin`)
- **Bucket** : `synap-storage` (créé automatiquement)

### Redis

- **Port** : `6379`
- **URL** : `redis://localhost:6379`

### Ory Kratos

- **Public** : `http://localhost:4433`
- **Admin** : `http://localhost:4434`

### Ory Hydra

- **Public** : `http://localhost:4444`
- **Admin** : `http://localhost:4445`

---

## 🧪 Tests

### Vérifier la connexion PostgreSQL

```bash
docker compose exec postgres psql -U postgres -d synap -c "SELECT version();"
```

### Vérifier MinIO

```bash
curl http://localhost:9000/minio/health/live
```

### Vérifier Redis

```bash
docker compose exec redis redis-cli ping
```

### Vérifier Ory Kratos

```bash
curl http://localhost:4433/health/ready
```

### Vérifier Ory Hydra

```bash
curl http://localhost:4444/health/ready
```

---

## 🔍 Dépannage

### Services ne démarrent pas

```bash
# Voir les logs d'erreur
docker compose logs [service-name]

# Redémarrer un service
docker compose restart [service-name]

# Recréer les conteneurs
docker compose up -d --force-recreate
```

### Base de données corrompue

```bash
# Supprimer les volumes et recréer
docker compose down -v
docker compose up -d
```

### Ports déjà utilisés

Modifiez les ports dans `docker compose.yml` ou arrêtez les services qui utilisent ces ports.

---

## 📦 Production

Pour un déploiement production :

1. **Sécuriser les mots de passe** : Utilisez des secrets Docker ou un gestionnaire de secrets
2. **Ajouter SSL/TLS** : Configurez un reverse proxy (nginx, traefik)
3. **Backup automatique** : Configurez des backups pour PostgreSQL et MinIO
4. **Monitoring** : Ajoutez Prometheus/Grafana pour le monitoring
5. **Logs centralisés** : Configurez un système de logs centralisé

---

## 🎯 Prochaines Étapes

1. **Créer un Dockerfile** pour le backend API
2. **Ajouter le service API** dans `docker compose.yml`
3. **Configurer les backups** automatiques
4. **Ajouter le monitoring** (Prometheus/Grafana)

---

## 📚 Références

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [TimescaleDB Documentation](https://docs.timescale.com/)
- [MinIO Documentation](https://min.io/docs/)
- [Ory Kratos Documentation](https://www.ory.sh/docs/kratos/)
- [Ory Hydra Documentation](https://www.ory.sh/docs/hydra/)
