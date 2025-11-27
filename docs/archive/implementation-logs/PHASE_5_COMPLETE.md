# Phase 5 Complétion - Setup et Tests

**Date :** 2025-01-20  
**Statut :** ✅ **Phase 5 Complétée**

---

## 📋 Résumé

Les scripts de setup et de test manuel ont été créés pour faciliter le démarrage et les tests E2E de l'Intelligence Hub.

---

## ✅ Fichiers Créés

### Scripts de Setup

1. **`scripts/setup-intelligence-hub.sh`** (120 lignes)
   - Script de setup automatisé
   - Démarre tous les services Docker
   - Initialise les extensions PostgreSQL
   - Crée le client OAuth2 Hub
   - Vérifie les variables d'environnement

2. **`scripts/test-e2e-manual.sh`** (90 lignes)
   - Script de test manuel
   - Vérifie que tous les services sont en cours d'exécution
   - Obtient un token OAuth2 automatiquement
   - Fournit des exemples de commandes curl

---

## ✅ Fonctionnalités

### 1. Script de Setup ✅

**Fichier :** `scripts/setup-intelligence-hub.sh`

**Étapes :**
1. ✅ Démarre les services Docker (PostgreSQL, MinIO, Redis, Ory, Mem0)
2. ✅ Initialise les extensions PostgreSQL
3. ✅ Initialise les extensions Mem0
4. ✅ Exécute les migrations de base de données
5. ✅ Crée le client OAuth2 Hub dans Hydra
6. ✅ Vérifie les variables d'environnement requises
7. ✅ Build les packages

**Utilisation :**
```bash
./scripts/setup-intelligence-hub.sh
```

---

### 2. Script de Test Manuel ✅

**Fichier :** `scripts/test-e2e-manual.sh`

**Fonctionnalités :**
1. ✅ Vérifie que tous les services sont en cours d'exécution
2. ✅ Obtient automatiquement un token OAuth2 (si configuré)
3. ✅ Fournit des exemples de commandes curl
4. ✅ Affiche des messages d'erreur clairs si des services sont manquants

**Utilisation :**
```bash
./scripts/test-e2e-manual.sh
```

---

## 🚀 Guide de Démarrage Rapide

### 1. Setup Initial

```bash
# 1. Copier le fichier .env
cp env.example .env

# 2. Configurer les variables d'environnement
# (ANTHROPIC_API_KEY, HYDRA_PUBLIC_URL, etc.)

# 3. Exécuter le script de setup
./scripts/setup-intelligence-hub.sh
```

### 2. Démarrer les Services

```bash
# Terminal 1: Data Pod
pnpm --filter api dev

# Terminal 2: Intelligence Hub
pnpm --filter intelligence-hub dev
```

### 3. Tester Manuellement

```bash
# Vérifier les services et obtenir un token
./scripts/test-e2e-manual.sh

# Ou tester directement avec curl
curl -X POST http://localhost:3001/api/expertise/request \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "x-datapod-url: http://localhost:3000" \
  -d '{
    "query": "Rappelle-moi d'\''appeler Paul demain"
  }'
```

### 4. Tests Automatisés

```bash
# Tests E2E
pnpm --filter @synap/intelligence-hub test:e2e

# Tous les tests
pnpm --filter @synap/intelligence-hub test
```

---

## 📋 Checklist de Validation

### Services Docker
- [ ] PostgreSQL (port 5432)
- [ ] MinIO (port 9000)
- [ ] Redis (port 6379)
- [ ] PostgreSQL Ory (port 5433)
- [ ] Kratos (port 4433)
- [ ] Hydra (port 4444/4445)
- [ ] PostgreSQL Mem0 (port 5434)
- [ ] Mem0 (port 8765)

### Services Application
- [ ] Data Pod API (port 3000)
- [ ] Intelligence Hub (port 3001)

### Configuration
- [ ] Variables d'environnement configurées
- [ ] Client OAuth2 Hub créé dans Hydra
- [ ] Extensions PostgreSQL initialisées
- [ ] Migrations de base de données exécutées

### Tests
- [ ] Health check Data Pod : `curl http://localhost:3000/health`
- [ ] Health check Hub : `curl http://localhost:3001/health`
- [ ] Test E2E automatisé : `pnpm --filter @synap/intelligence-hub test:e2e`
- [ ] Test manuel avec curl

---

## 🎯 Prochaines Étapes

Une fois le setup complet, vous pouvez :

1. **Tester le flow complet** :
   - Créer un utilisateur dans Kratos
   - Créer une note dans le Data Pod
   - Appeler le Hub depuis le Data Pod
   - Vérifier l'insight retourné

2. **Développer de nouveaux agents** :
   - Créer de nouveaux agents dans `packages/intelligence-hub/src/agents/`
   - Les intégrer dans le Hub Orchestrator
   - Ajouter des tests

3. **Optimiser les performances** :
   - Analyser les métriques de performance
   - Optimiser les appels LLM
   - Améliorer la mise en cache

---

## ✅ Checklist

- [x] Script de setup créé
- [x] Script de test manuel créé
- [x] Documentation de setup
- [ ] Services démarrés et validés
- [ ] Tests E2E exécutés avec succès
- [ ] Test manuel réussi

---

## 📝 Notes

Les scripts sont conçus pour être idempotents - vous pouvez les exécuter plusieurs fois sans problème. Ils vérifient l'état des services avant d'effectuer des actions.

**Prochaine action :** Exécuter les scripts et valider le système complet.

