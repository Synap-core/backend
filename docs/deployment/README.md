# Deployment

**Guides de déploiement pour Synap Backend**

---

## 📚 Documentation Disponible

### [Docker Deployment](./DOCKER.md)
Guide pour déployer avec Docker Compose (self-hosted complet).

**Contenu :**
- Configuration docker compose.yml
- Services inclus (PostgreSQL, MinIO, API)
- Variables d'environnement
- Démarrage en une commande

### [Docker Validation](./DOCKER_VALIDATION.md)
Validation complète du déploiement Docker.

**Contenu :**
- Checklist de validation
- Tests de chaque service
- Troubleshooting
- Configuration automatique

### [Production Setup](./PRODUCTION.md)
Guide de configuration pour la production.

**Contenu :**
- Configuration PostgreSQL + R2
- Variables d'environnement production
- Sécurité
- Monitoring
- Backup

---

## 🚀 Déploiement Rapide

### Docker Compose (Self-Hosted)

```bash
# 1. Créer .env
cp env.example .env
# Ajouter vos clés API

# 2. Démarrer tous les services
docker compose up -d

# 3. Vérifier
docker compose ps
curl http://localhost:3000/health
```

Voir **[Docker Deployment](./DOCKER.md)** pour plus de détails.

### Production (Cloud)

1. **Configurer PostgreSQL** (TimescaleDB)
2. **Configurer R2** (Cloudflare)
3. **Déployer l'API** (Vercel, Railway, etc.)
4. **Configurer Inngest** (cloud ou self-hosted)

Voir **[Production Setup](./PRODUCTION.md)** pour plus de détails.

---

## 📋 Checklist de Déploiement

### Prérequis
- [ ] PostgreSQL avec TimescaleDB
- [ ] Cloudflare R2 (ou MinIO pour dev)
- [ ] Clés API (Anthropic, OpenAI)
- [ ] Inngest (cloud ou self-hosted)

### Configuration
- [ ] Variables d'environnement configurées
- [ ] Base de données initialisée
- [ ] Migrations appliquées
- [ ] Storage configuré

### Sécurité
- [ ] Secrets sécurisés (pas dans le code)
- [ ] CORS configuré
- [ ] Rate limiting activé
- [ ] Auth configurée

### Monitoring
- [ ] Health checks configurés
- [ ] Logs centralisés
- [ ] Alertes configurées

---

## 🔗 Liens Utiles

- **[Getting Started](../getting-started/README.md)** - Installation
- **[Architecture](../architecture/README.md)** - Architecture
- **[Development](../development/README.md)** - Développement

