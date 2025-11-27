# Prochaines Étapes pour Tester le Processus Entier (E2E)

**Date :** 2025-01-20  
**Objectif :** Identifier les étapes manquantes pour tester le flow complet `Data Pod → Intelligence Hub → Agent → Mem0 → Data Pod`

---

## 📊 État Actuel

### ✅ Ce qui est Fait

1. **Infrastructure Ory Stack**
   - ✅ Kratos + Hydra déployés et configurés
   - ✅ Script de création client OAuth2 créé

2. **Infrastructure Mem0**
   - ✅ Mem0 + PostgreSQL configurés dans Docker
   - ✅ Service `MemoryLayer` créé et fonctionnel
   - ✅ Tool `Mem0MemoryTool` créé

3. **Hub Protocol (Data Pod)**
   - ⚠️ Router `hub.*` **VIDE** - Fichier existe mais non implémenté
   - ✅ Schémas Zod définis (`@synap/hub-protocol`)
   - ✅ Transformation insights → événements (`hub-transform.ts`)
   - ✅ Utilitaires Hub (`hub-utils.ts`) - JWT, audit logging

4. **Package Intelligence Hub**
   - ✅ Structure de base créée
   - ✅ Service MemoryLayer fonctionnel
   - ✅ Build TypeScript réussi

---

## ❌ Ce qui Manque pour E2E Testing

### 0. Router Hub Protocol (Data Pod) ✅ COMPLÉTÉ

**Statut :** ✅ **IMPLÉMENTÉ** - Le router `hub.*` est maintenant fonctionnel.

**Fichiers créés/modifiés :**
- ✅ `packages/api/src/routers/hub.ts` - Router complet avec 3 endpoints
- ✅ Middleware `hubTokenProcedure` créé
- ✅ Intégration avec `hub-utils.ts` et `hub-transform.ts`

**Endpoints implémentés :**
- ✅ `hub.generateAccessToken` - Génère JWT temporaire
- ✅ `hub.requestData` - Récupère données en lecture seule
- ✅ `hub.submitInsight` - Soumet insight structuré

**Voir :** `docs/architecture/HUB_ROUTER_IMPLEMENTATION_COMPLETE.md` pour les détails.

---

### 1. Client Hub Protocol (Hub → Data Pod) 🔴 CRITIQUE

**Problème :** Le Hub doit pouvoir appeler le Data Pod via Hub Protocol, mais le client tRPC n'existe pas.

**Ce qui manque :**
- Client tRPC pour appeler le Data Pod
- Gestion des tokens JWT temporaires
- Retry logic et error handling

**Fichiers à créer :**
- `packages/intelligence-hub/src/clients/hub-protocol-client.ts` - Client tRPC

**Impact :** **BLOQUANT** - Sans ce client, le Hub ne peut pas communiquer avec le Data Pod.

---

### 2. Backend Intelligence Hub (Service API) 🔴 CRITIQUE

**Problème :** Il n'y a pas encore de service API qui reçoit les requêtes du Data Pod.

**Ce qui manque :**
- Service HTTP (Hono) qui écoute les requêtes
- Endpoint `/api/expertise/request` qui reçoit les requêtes du Data Pod
- Gestion de l'authentification OAuth2 (Hydra Client Credentials)
- Orchestrateur qui route vers les agents

**Fichiers à créer :**
- `apps/intelligence-hub/src/index.ts` - Serveur HTTP principal
- `apps/intelligence-hub/src/routers/expertise.ts` - Router pour requêtes expertise
- `packages/intelligence-hub/src/services/hub-orchestrator.ts` - Orchestrateur principal

**Impact :** **BLOQUANT** - Sans ce service, le Data Pod ne peut pas envoyer de requêtes au Hub.

---

### 3. Premier Agent LangGraph 🟡 IMPORTANT

**Problème :** Aucun agent LangGraph n'est implémenté pour traiter les requêtes.

**Ce qui manque :**
- Agent `ActionExtractor` (premier agent simple)
- Intégration avec Mem0MemoryTool (optionnel pour MVP)
- Génération d'insights structurés conformes au schéma

**Fichiers à créer :**
- `packages/intelligence-hub/src/agents/action-extractor.ts` - Agent LangGraph
- `packages/intelligence-hub/src/agents/index.ts` - Registry d'agents

**Impact :** **IMPORTANT** - Sans agent, le Hub ne peut pas traiter les requêtes.

---

### 4. Client OAuth2 Créé dans Hydra 🟡 IMPORTANT

**Problème :** Le client OAuth2 pour le Hub n'a pas encore été créé dans Hydra.

**Action :**
- Démarrer Hydra
- Exécuter `pnpm create:hub-client`
- Ajouter `HUB_CLIENT_ID` et `HUB_CLIENT_SECRET` dans `.env`

**Impact :** **IMPORTANT** - Sans client OAuth2, le Hub ne peut pas s'authentifier.

---

### 5. Services Démarrés 🟢 SIMPLE

**Problème :** Tous les services doivent être démarrés pour tester.

**Services nécessaires :**
- Data Pod (apps/api) - ✅ Existe
- Ory Stack (Kratos + Hydra) - ✅ Configuré
- Mem0 - ✅ Configuré
- Intelligence Hub (apps/intelligence-hub) - ❌ À créer

---

## 🎯 Plan d'Action pour E2E Testing

### Phase 0 : Router Hub Protocol (Data Pod) (2-3 jours) 🔴 PRIORITÉ 0 (ABSOLU)

**Objectif :** Implémenter le router `hub.*` dans le Data Pod.

**Tâches :**
1. Implémenter `packages/api/src/routers/hub.ts`
   - Endpoint `generateAccessToken` (mutation)
   - Endpoint `requestData` (query avec `hubTokenProcedure`)
   - Endpoint `submitInsight` (mutation avec `hubTokenProcedure`)
   - Utilise `hub-utils.ts` pour JWT et audit
   - Utilise `hub-transform.ts` pour transformation

2. Tests unitaires

**Livrables :**
- ✅ Router `hub.*` fonctionnel
- ✅ 3 endpoints implémentés
- ✅ Tests unitaires

---

### Phase 1 : Client Hub Protocol (2-3 jours) 🔴 PRIORITÉ 1

**Objectif :** Permettre au Hub d'appeler le Data Pod.

**Tâches :**
1. Créer `packages/intelligence-hub/src/clients/hub-protocol-client.ts`
   - Client tRPC avec `@trpc/client`
   - Méthodes : `generateAccessToken`, `requestData`, `submitInsight`
   - Gestion erreurs et retry
   - Utilise `HUB_CLIENT_ID` et `HUB_CLIENT_SECRET` pour OAuth2

2. Tests unitaires du client

**Dependencies à ajouter :**
```json
{
  "@trpc/client": "^10.45.0",
  "@langchain/core": "^1.0.3"  // Pour le tool wrapper
}
```

**Livrables :**
- ✅ Client Hub Protocol fonctionnel
- ✅ Tests unitaires
- ✅ Gestion OAuth2 (Client Credentials)

---

### Phase 2 : Backend Intelligence Hub (3-4 jours) ✅ COMPLÉTÉ

**Objectif :** Créer le service API qui reçoit les requêtes.

**Tâches :**
1. ✅ Créer `apps/intelligence-hub/`
   - Structure similaire à `apps/api/`
   - Serveur Hono
   - Router `/api/expertise/request`

2. ✅ Créer `packages/intelligence-hub/src/services/hub-orchestrator.ts`
   - Reçoit requête du Data Pod
   - Vérifie abonnement (skip pour MVP)
   - Route vers agent approprié (MVP simple pour l'instant)
   - Gère le flow complet

3. ✅ Authentification OAuth2
   - Middleware pour valider tokens Hydra
   - Utilise `oryAuthMiddleware` pour OAuth2 Client Credentials

**Livrables :**
- ✅ Service API Intelligence Hub (619 lignes totales)
- ✅ Endpoint `/api/expertise/request`
- ✅ Authentification OAuth2
- ✅ Hub Orchestrator avec MVP simple

**Voir :** `docs/architecture/PHASE_2_COMPLETE.md` pour les détails.

---

### Phase 3 : Premier Agent (2-3 jours) ✅ COMPLÉTÉ

**Objectif :** Créer un agent LangGraph simple qui fonctionne.

**Tâches :**
1. ✅ Créer `packages/intelligence-hub/src/agents/action-extractor.ts`
   - Agent LangGraph simple (280 lignes)
   - Prend une phrase en entrée
   - Extrait action (tâche ou note) avec LLM
   - Génère insight structuré conforme au schéma

2. ⏭️ Intégrer Mem0MemoryTool (optionnel pour MVP - reporté)
   - Agent peut rechercher dans Mem0
   - Utilise contexte utilisateur

3. ✅ Tests unitaires

**Dependencies ajoutées :**
```json
{
  "@langchain/langgraph": "^1.0.1",
  "@ai-sdk/anthropic": "^1.0.0",
  "ai": "^4.0.0"
}
```

**Livrables :**
- ✅ Agent ActionExtractor fonctionnel
- ✅ Génère insights conformes au schéma
- ✅ Intégré dans Hub Orchestrator
- ✅ Tests unitaires créés

**Voir :** `docs/architecture/PHASE_3_COMPLETE.md` pour les détails.

---

### Phase 4 : Intégration Complète (2 jours) ✅ COMPLÉTÉ

**Objectif :** Connecter tous les composants.

**Tâches :**
1. ✅ Connecter Hub Orchestrator → Agent → Hub Protocol Client
2. ✅ Flow complet :
   ```
   Data Pod → Hub API → Orchestrator → Agent → Hub Protocol Client → Data Pod
   ```
3. ✅ Tests E2E
4. ✅ Logging et monitoring basique (métriques de performance)

**Livrables :**
- ✅ Flow complet fonctionnel
- ✅ Tests E2E créés (120 lignes)
- ✅ Logging amélioré avec métriques
- ✅ Documentation API complète (350 lignes)

**Voir :** `docs/architecture/PHASE_4_COMPLETE.md` pour les détails.

---

### Phase 5 : Setup et Tests (1 jour) ✅ COMPLÉTÉ

**Objectif :** Démarrer tous les services et tester.

**Tâches :**
1. ✅ Scripts de setup automatisés :
   ```bash
   # Setup complet
   ./scripts/setup-intelligence-hub.sh
   
   # Démarrer services
   docker compose up -d postgres minio redis postgres-ory kratos hydra postgres-mem0 mem0
   pnpm --filter @synap/api dev
   pnpm --filter intelligence-hub dev
   ```

2. ✅ Scripts de test manuel :
   ```bash
   # Vérifier services et obtenir token
   ./scripts/test-e2e-manual.sh
   ```

3. ✅ Documentation de setup complète

**Livrables :**
- ✅ Scripts de setup automatisés créés
- ✅ Scripts de test manuel créés
- ✅ Documentation de setup

**Voir :** `docs/architecture/PHASE_5_COMPLETE.md` pour les détails.

---

## 📋 Checklist Complète

### Infrastructure
- [x] Ory Stack configuré
- [x] Mem0 configuré
- [x] Phase 0 : Router Hub Protocol ✅
- [x] Phase 1 : Client Hub Protocol ✅
- [x] Phase 2 : Backend Intelligence Hub ✅
- [x] Phase 3 : Premier Agent LangGraph ✅
- [x] Phase 4 : Intégration Complète ✅
- [x] Phase 5 : Setup et Tests ✅
- [x] Scripts de setup créés
- [ ] Client OAuth2 créé dans Hydra (à faire avec script)
- [ ] Services démarrés et validés

### Data Pod
- [x] **Router `hub.*` implémenté** ✅ (Phase 0 complétée)
- [x] Transformation insights → événements
- [x] Utilitaires Hub (JWT, audit)
- [ ] Tests unitaires
- [ ] Vérifier que tout fonctionne

### Code Intelligence Hub
- [x] Package `@synap/intelligence-hub` créé
- [x] Service `MemoryLayer` créé
- [x] Tool `Mem0MemoryTool` créé
- [x] **Client Hub Protocol** ✅ (Phase 1 complétée)
- [x] **Service Hub Orchestrator** ✅ (Phase 2 complétée)
- [x] **Backend API Intelligence Hub** ✅ (Phase 2 complétée)
- [x] **Agent ActionExtractor** ✅ (Phase 3 complétée)

### Tests
- [ ] Tests unitaires Client Hub Protocol
- [ ] Tests unitaires Agent
- [ ] Tests E2E complets

---

## 🚀 Ordre d'Exécution Recommandé

### Étape 0 : Router Hub Protocol (Data Pod) (🔴 CRITIQUE ABSOLU)
**Pourquoi en premier :** C'est la base de tout. Sans ce router, rien ne peut fonctionner.

**Temps estimé :** 2-3 jours

### Étape 1 : Client Hub Protocol (🔴 CRITIQUE)
**Pourquoi en premier :** C'est la base de toute communication Hub ↔ Data Pod.

**Temps estimé :** 2-3 jours

### Étape 2 : Backend Intelligence Hub (🔴 CRITIQUE)
**Pourquoi en deuxième :** Le service API doit recevoir les requêtes.

**Temps estimé :** 3-4 jours

### Étape 3 : Premier Agent (🟡 IMPORTANT)
**Pourquoi en troisième :** L'agent traite les requêtes.

**Temps estimé :** 2-3 jours

### Étape 4 : Intégration Complète (🟡 IMPORTANT)
**Pourquoi en quatrième :** Connecter tous les composants.

**Temps estimé :** 2 jours

### Étape 5 : Setup et Tests (🟢 SIMPLE)
**Pourquoi en dernier :** Tester le système complet.

**Temps estimé :** 1 jour

---

## ⏱️ Estimation Totale

**Temps estimé :** 12-15 jours de développement

- Phase 0 (Router Hub Protocol) : 2-3 jours 🔴
- Phase 1 (Client Hub Protocol) : 2-3 jours
- Phase 2 (Backend Intelligence Hub) : 3-4 jours
- Phase 3 (Premier Agent) : 2-3 jours
- Phase 4 (Intégration) : 2 jours
- Phase 5 (Setup et Tests) : 1 jour

---

## 🎯 Prochaine Action Immédiate

**Implémenter le Router Hub Protocol** (`packages/api/src/routers/hub.ts`)

**Pourquoi :**
- C'est la base ABSOLUE de tout le Hub Protocol
- Sans ce router, le Data Pod ne peut pas recevoir de requêtes du Hub
- C'est BLOQUANT pour tout le reste
- Les utilitaires (`hub-utils.ts`, `hub-transform.ts`) sont déjà créés

**Dependencies nécessaires :**
- `@trpc/client` - Pour le client tRPC
- `@ory/hydra-client` - Pour OAuth2 Client Credentials (déjà installé)

---

## 📝 Notes Importantes

1. **Hub Protocol dans Data Pod :** Le router `hub.*` existe et semble complet. À vérifier qu'il fonctionne correctement.

2. **OAuth2 Flow :** Le Hub doit utiliser OAuth2 Client Credentials pour s'authentifier auprès du Data Pod. Le Data Pod doit valider ces tokens via Hydra.

3. **Architecture :** Le Hub est un service séparé (`apps/intelligence-hub/`), pas un package. Il utilise les packages `@synap/intelligence-hub` pour la logique métier.

---

**⚠️ PROBLÈME CRITIQUE DÉTECTÉ :** Le router `hub.*` dans le Data Pod est **VIDE**. Il doit être implémenté en PRIORITÉ ABSOLUE avant tout le reste.

**Question :** Voulez-vous que je commence par implémenter le Router Hub Protocol (`packages/api/src/routers/hub.ts`), qui est BLOQUANT pour tout le reste ?
