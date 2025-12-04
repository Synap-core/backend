# Architecture d'Authentification - Synap Ecosystem

**Date :** 2025-01-20  
**Version :** 1.0.0  
**Statut :** 📋 **Spécification Finale**

---

## 🎯 Question Centrale

**Où gérer l'authentification pour le marketplace de plugins/agents externes ?**

- **Option A :** Uniquement sur le Data Pod
- **Option B :** Également sur l'Intelligence Hub
- **Option C :** Hybride (recommandé)

---

## 📊 Analyse des Options

### Option A : Centralisé sur Data Pod ❌

**Architecture :**
```
┌─────────────┐
│  Data Pod   │ ← Gère TOUS les clients OAuth2
│  (Ory)      │   - Utilisateurs finaux
└─────────────┘   - Intelligence Hub
     │             - Plugins/Agents externes
     │
     ├─→ Intelligence Hub (Client Credentials)
     └─→ Plugin Externe (Authorization Code)
```

**Avantages :**
- ✅ Simple : Un seul point d'authentification
- ✅ Centralisé : Tous les clients au même endroit

**Inconvénients :**
- ❌ **Non scalable** : Le Data Pod doit connaître tous les plugins
- ❌ **Couplage fort** : Chaque nouveau plugin nécessite une modification du Data Pod
- ❌ **Performance** : Le Data Pod devient un goulot d'étranglement
- ❌ **Sécurité** : Tous les secrets de plugins dans le Data Pod
- ❌ **Isolation** : Pas de séparation entre utilisateurs et plugins

**Verdict :** ❌ **Non recommandé** pour un marketplace

---

### Option B : Décentralisé - Intelligence Hub a aussi Ory ✅

**Architecture :**
```
┌─────────────┐         ┌──────────────────┐
│  Data Pod   │ ←──────→│ Intelligence Hub │
│  (Ory #1)   │         │    (Ory #2)      │
└─────────────┘         └──────────────────┘
     │                           │
     │                           │
     ├─→ Utilisateurs finaux     ├─→ Plugins/Agents externes
     └─→ Intelligence Hub        └─→ Services marketplace
```

**Avantages :**
- ✅ **Scalable** : Le Hub peut gérer des milliers de plugins
- ✅ **Séparation des responsabilités** : Data Pod = utilisateurs, Hub = plugins
- ✅ **Performance** : Pas de goulot d'étranglement
- ✅ **Sécurité** : Isolation des secrets de plugins
- ✅ **Indépendance** : Le Hub peut évoluer indépendamment

**Inconvénients :**
- ⚠️ **Complexité** : Deux instances Ory à gérer
- ⚠️ **Coût** : Deux services Ory (mais nécessaire pour le scale)

**Verdict :** ✅ **Recommandé** pour un marketplace

---

### Option C : Hybride (Recommandé) ✅✅

**Architecture :**
```
┌─────────────────────────────────────────────────────────┐
│                    Data Pod (Ory #1)                    │
│  - Gère authentification utilisateurs finaux             │
│  - Gère authentification Intelligence Hub (M2M)         │
└─────────────────────────────────────────────────────────┘
                          │
                          │ OAuth2 Client Credentials
                          │
┌─────────────────────────────────────────────────────────┐
│              Intelligence Hub (Ory #2)                  │
│  - Gère authentification plugins/agents externes         │
│  - Gère marketplace de services                         │
│  - S'authentifie auprès du Data Pod                     │
└─────────────────────────────────────────────────────────┘
                          │
                          │ OAuth2 Authorization Code
                          │
┌─────────────────────────────────────────────────────────┐
│              Plugin/Agent Externe                       │
│  - S'authentifie auprès de l'Intelligence Hub          │
│  - Reçoit des requêtes du Hub                          │
└─────────────────────────────────────────────────────────┘
```

**Avantages :**
- ✅ **Séparation claire** : Data Pod = utilisateurs, Hub = plugins
- ✅ **Scalable** : Le Hub peut gérer des milliers de plugins
- ✅ **Sécurité** : Isolation des secrets
- ✅ **Performance** : Pas de goulot d'étranglement
- ✅ **Flexibilité** : Le Hub peut évoluer indépendamment

**Inconvénients :**
- ⚠️ **Complexité** : Deux instances Ory (mais nécessaire)

**Verdict :** ✅✅ **Recommandé** - Meilleur compromis

---

## 🏗️ Architecture Recommandée (Option C)

### 1. Data Pod (Ory Instance #1)

**Rôle :** Authentification des utilisateurs finaux et de l'Intelligence Hub

**Clients OAuth2 :**
- `synap-hub` : Intelligence Hub (Client Credentials)
- `user-{id}` : Utilisateurs finaux (Authorization Code)
- `website-{name}` : Sites web clients (Authorization Code)

**Scopes :**
- `read:preferences`, `read:notes`, `read:tasks`
- `write:insights`, `write:events`

---

### 2. Intelligence Hub (Ory Instance #2)

**Rôle :** Authentification des plugins/agents externes du marketplace

**Clients OAuth2 :**
- `plugin-{name}` : Plugins externes (Authorization Code)
- `agent-{name}` : Agents externes (Authorization Code)
- `service-{name}` : Services marketplace (Client Credentials)

**Scopes :**
- `hub:read`, `hub:write`
- `marketplace:register`, `marketplace:use`

**Flow :**
1. Plugin s'enregistre sur la marketplace
2. Hub crée un client OAuth2 dans son Ory Hydra
3. Plugin s'authentifie auprès du Hub
4. Hub route les requêtes vers le plugin
5. Plugin retourne des insights au Hub
6. Hub soumet les insights au Data Pod

---

## 🔄 Flows d'Authentification

### Flow 1 : Data Pod ↔ Intelligence Hub

```
1. Intelligence Hub → Ory Hydra (Data Pod)
   - Grant: client_credentials
   - Client: synap-hub
   - Scope: hub:read hub:write

2. Ory Hydra → Access Token

3. Intelligence Hub → Data Pod API
   - Header: Authorization: Bearer <token>
   - Data Pod valide le token avec Ory Hydra

4. Data Pod → Retourne données
```

**Où :** Data Pod Ory Instance

---

### Flow 2 : Intelligence Hub ↔ Plugin Externe

```
1. Plugin Externe → Ory Hydra (Intelligence Hub)
   - Grant: authorization_code
   - Client: plugin-{name}
   - Scope: hub:read hub:write

2. Ory Hydra → Consent Screen
   - User consent (si nécessaire)

3. Ory Hydra → Authorization Code

4. Plugin → Exchange Code for Token

5. Plugin → Intelligence Hub API
   - Header: Authorization: Bearer <token>
   - Hub valide le token avec son Ory Hydra

6. Hub → Route vers plugin
```

**Où :** Intelligence Hub Ory Instance

---

### Flow 3 : Utilisateur Final ↔ Data Pod

```
1. User → Ory Kratos (Data Pod)
   - Login (email/password ou OAuth)

2. Kratos → Session

3. User → Data Pod API
   - Cookie: session
   - Data Pod valide avec Kratos

4. Data Pod → Retourne données
```

**Où :** Data Pod Ory Instance

---

## 💡 Recommandation Finale

### ✅ **Option C : Hybride**

**Pourquoi :**

1. **Scalabilité** : Le Hub peut gérer des milliers de plugins sans impacter le Data Pod
2. **Séparation des responsabilités** : 
   - Data Pod = Souveraineté des données utilisateur
   - Hub = Marketplace et orchestration
3. **Sécurité** : Isolation des secrets de plugins
4. **Performance** : Pas de goulot d'étranglement
5. **Évolutivité** : Le Hub peut évoluer indépendamment

**Implémentation :**

1. **Data Pod** : Garde son Ory (Kratos + Hydra)
   - Gère utilisateurs finaux
   - Gère authentification Hub (M2M)

2. **Intelligence Hub** : Ajoute son propre Ory Hydra
   - Gère authentification plugins/agents
   - Gère marketplace

3. **Communication** :
   - Hub → Data Pod : OAuth2 Client Credentials (via Data Pod Ory)
   - Plugin → Hub : OAuth2 Authorization Code (via Hub Ory)

---

## 🚀 Plan d'Implémentation

### Phase 1 : Intelligence Hub Ory Instance

**Tâches :**
1. [ ] Ajouter Ory Hydra au docker compose pour Hub
2. [ ] Créer service d'authentification Hub
3. [ ] Créer API de marketplace
4. [ ] Créer endpoint d'enregistrement de plugins

**Fichiers à créer :**
- `apps/intelligence-hub/src/services/marketplace-registry.ts`
- `apps/intelligence-hub/src/services/plugin-auth.ts`
- `apps/intelligence-hub/src/routers/marketplace.ts`

---

### Phase 2 : Marketplace API

**Tâches :**
1. [ ] Endpoint `POST /api/marketplace/register`
2. [ ] Endpoint `GET /api/marketplace/plugins`
3. [ ] Endpoint `POST /api/marketplace/activate`
4. [ ] Gestion des clients OAuth2 pour plugins

---

### Phase 3 : Intégration

**Tâches :**
1. [ ] Router les requêtes vers plugins authentifiés
2. [ ] Gérer les scopes de plugins
3. [ ] Audit trail pour plugins

---

## 📊 Comparaison des Options

| Critère | Option A (Centralisé) | Option B (Décentralisé) | Option C (Hybride) |
|---------|----------------------|------------------------|-------------------|
| **Scalabilité** | ❌ Faible | ✅ Élevée | ✅✅ Élevée |
| **Séparation responsabilités** | ❌ Faible | ✅ Bonne | ✅✅ Excellente |
| **Performance** | ❌ Goulot | ✅ Bonne | ✅✅ Excellente |
| **Sécurité** | ⚠️ Moyenne | ✅ Bonne | ✅✅ Excellente |
| **Complexité** | ✅ Simple | ⚠️ Moyenne | ⚠️ Moyenne |
| **Coût** | ✅ Faible | ⚠️ Moyen | ⚠️ Moyen |
| **Recommandation** | ❌ Non | ✅ Oui | ✅✅ **OUI** |

---

## 🎯 Conclusion

**Recommandation : Option C (Hybride)**

- **Data Pod** : Gère authentification utilisateurs + Hub (Ory Instance #1)
- **Intelligence Hub** : Gère authentification plugins/agents (Ory Instance #2)

**Avantages clés :**
1. ✅ Scalable pour un marketplace
2. ✅ Séparation claire des responsabilités
3. ✅ Sécurité renforcée
4. ✅ Performance optimale

**Prochaine étape :** Implémenter Ory Hydra dans l'Intelligence Hub pour le marketplace.

---

**Document créé le :** 2025-01-20  
**Dernière mise à jour :** 2025-01-20  
**Version :** 1.0.0

