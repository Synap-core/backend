# Ory Stack Expliqué : Kratos vs Hydra - Guide Complet

**Date :** 2025-01-20  
**Objectif :** Expliquer Ory Stack (Kratos + Hydra) et son impact sur l'écosystème Synap

---

## 1. Qu'est-ce que Ory Stack ?

**Ory Stack** est une suite d'outils open source pour la gestion d'identité et d'accès (IAM). Pour Synap, nous utilisons deux composants :

### 1.1. Ory Kratos (Identity Provider)

**Rôle :** Gestion des **identités utilisateur** (qui êtes-vous ?)

**Fonctions :**
- ✅ Créer/gérer des comptes utilisateur
- ✅ Authentification (Email/Password, OAuth Google/GitHub)
- ✅ Gestion des sessions utilisateur
- ✅ Self-service flows (registration, login, password recovery)
- ✅ Stockage des identités dans une base de données

**Analogie :** Kratos = **"Le registre des utilisateurs"**
- C'est comme un annuaire qui dit "Antoine existe, son email est X, son mot de passe est hashé Y"

### 1.2. Ory Hydra (OAuth2/OIDC Server)

**Rôle :** Gestion des **tokens d'accès** (qu'est-ce que vous pouvez faire ?)

**Fonctions :**
- ✅ Émettre des tokens OAuth2 (access_token, refresh_token)
- ✅ Gérer les clients OAuth2 (applications qui demandent des tokens)
- ✅ Gérer les scopes (permissions granulaires)
- ✅ Valider/introspecter les tokens
- ✅ Gérer les flows OAuth2 (authorization_code, client_credentials, etc.)

**Analogie :** Hydra = **"Le bureau des passeports"**
- C'est comme un système qui dit "Voici un token qui permet à l'application X d'accéder aux données Y de l'utilisateur Z"

---

## 2. Différence entre Kratos et Hydra

### 2.1. Votre Compréhension

> "Hydra est plus serveur-side, on peut être notre propre OAuth provider, et Kratos est plus client-side"

**Partiellement correct, mais voici la nuance :**

### 2.2. La Vraie Différence

| Aspect | Kratos | Hydra |
|:---|:---|:---|
| **Rôle** | Identity Provider | OAuth2 Server |
| **Question** | "Qui êtes-vous ?" | "Qu'est-ce que vous pouvez faire ?" |
| **Gère** | Utilisateurs, sessions, authentification | Tokens, scopes, clients OAuth2 |
| **Côté** | Les deux (serveur ET client) | Serveur uniquement |
| **Standard** | Pas de standard spécifique | OAuth2/OIDC (standards) |

### 2.3. Relation entre Kratos et Hydra

```
┌─────────────────────────────────────────────────────────┐
│  Kratos (Identity Provider)                             │
│  "Qui êtes-vous ?"                                       │
│                                                          │
│  - Gère les utilisateurs                                │
│  - Authentifie (login)                                   │
│  - Crée des sessions                                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ "L'utilisateur X est authentifié"
                     │
┌────────────────────▼────────────────────────────────────┐
│  Hydra (OAuth2 Server)                                   │
│  "Qu'est-ce que vous pouvez faire ?"                     │
│                                                          │
│  - Reçoit confirmation de Kratos                         │
│  - Émet des tokens OAuth2                                │
│  - Gère les permissions (scopes)                         │
└─────────────────────────────────────────────────────────┘
```

**En résumé :**
- **Kratos** = "Je confirme que vous êtes Antoine"
- **Hydra** = "Voici un token qui permet à l'app X d'accéder aux notes d'Antoine"

**Ils travaillent ensemble :**
1. Kratos authentifie l'utilisateur
2. Hydra émet un token OAuth2 basé sur cette authentification
3. L'application utilise le token pour accéder aux ressources

---

## 3. Comment ça Change pour Synap ?

### 3.1. AVANT (Better Auth)

```
User → Better Auth → Session Cookie → Data Pod API
```

**Problèmes :**
- ❌ Pas de standard OAuth2
- ❌ Pas de scopes granulaires
- ❌ Difficile pour agents tiers
- ❌ Pas de consent screen

### 3.2. APRÈS (Ory Stack)

```
User → Kratos (login) → Hydra (token) → Data Pod API
```

**Avantages :**
- ✅ Standard OAuth2 (compatible avec tout)
- ✅ Scopes granulaires (read:notes, write:tasks, etc.)
- ✅ Facile pour agents tiers
- ✅ Consent screen standard

---

## 4. Flaws et Changements

### 4.1. Flaws (Inconvénients)

#### **Complexité Opérationnelle**

**AVANT (Better Auth) :**
- 1 service (Better Auth)
- 1 base de données (PostgreSQL)
- Configuration simple

**APRÈS (Ory Stack) :**
- 2 services (Kratos + Hydra)
- 1 base de données partagée (ou 2 séparées)
- Configuration plus complexe
- **Impact :** Plus de maintenance, plus de monitoring

#### **Migration Utilisateurs**

**AVANT :**
- Utilisateurs existants fonctionnent immédiatement

**APRÈS :**
- Tous les utilisateurs doivent se reconnecter une fois
- **Impact :** Expérience utilisateur dégradée temporairement

#### **Sessions**

**AVANT :**
- Sessions stockées dans PostgreSQL (accès direct)

**APRÈS :**
- Sessions gérées par Kratos (API calls nécessaires)
- **Impact :** Latence légèrement augmentée (mais négligeable)

#### **Courbe d'Apprentissage**

**AVANT :**
- Better Auth = simple, bien documenté

**APRÈS :**
- Ory = plus complexe, nécessite compréhension OAuth2
- **Impact :** Équipe doit apprendre Ory

### 4.2. Changements Positifs

#### **Standard OAuth2**

**AVANT :**
- Système propriétaire Better Auth

**APRÈS :**
- Standard OAuth2 (compatible avec tout)
- **Impact :** Interopérabilité maximale

#### **Scopes Granulaires**

**AVANT :**
- Tout ou rien (authentifié ou pas)

**APRÈS :**
- Permissions précises (read:notes, write:tasks, etc.)
- **Impact :** Sécurité améliorée

#### **Agents Tiers**

**AVANT :**
- Difficile d'intégrer des agents externes

**APRÈS :**
- Flow OAuth2 standard pour agents tiers
- **Impact :** Marketplace d'agents possible

---

## 5. Est-ce que ça Fonctionne pour Tous les Cas d'Usage ?

### 5.1. Data Pod ↔ Intelligence Hub

**✅ OUI, ça fonctionne parfaitement**

**Flow :**
```
1. Intelligence Hub → Hydra (Client Credentials)
   - client_id: synap-hub
   - client_secret: <secret>
   - scope: read:preferences read:notes write:insights
2. Hydra → Émet access_token
3. Intelligence Hub → Data Pod API (avec token)
4. Data Pod → Hydra (introspect token)
5. Data Pod → Vérifie scopes
6. Data Pod → Retourne données
```

**Avantages :**
- ✅ Standard OAuth2
- ✅ Scopes granulaires
- ✅ Tokens à durée limitée
- ✅ Sécurité renforcée

### 5.2. Data Pod ↔ Plugins/Agents Externes

**✅ OUI, ça fonctionne parfaitement**

**Flow :**
```
1. Agent Externe → Redirige user vers Hydra
   - /oauth2/auth?client_id=agent-xyz&scope=read:notes
2. Hydra → Redirige vers Kratos (si pas logged in)
3. Kratos → User login
4. Hydra → Affiche consent screen
   - "Agent XYZ demande accès à vos notes. Autoriser ?"
5. User → Consent
6. Hydra → Émet authorization_code
7. Agent → Exchange code for token
8. Agent → Data Pod API (avec token)
9. Data Pod → Hydra (introspect token)
10. Data Pod → Vérifie scopes
11. Data Pod → Retourne données
```

**Avantages :**
- ✅ Consent screen standard
- ✅ Scopes granulaires
- ✅ User contrôle les permissions
- ✅ Révocable à tout moment

### 5.3. Data Pod ↔ Websites Clients

**✅ OUI, mais avec FLEXIBILITÉ**

**C'est ici que votre question est importante !**

#### **Option 1 : Website utilise Ory (Recommandé)**

**Flow :**
```
1. Website → Redirige user vers Hydra
2. Hydra → Kratos (login)
3. Hydra → Émet token
4. Website → Data Pod API (avec token)
```

**Avantages :**
- ✅ Standard OAuth2
- ✅ Sécurité maximale
- ✅ Scopes granulaires

#### **Option 2 : Website utilise Better Auth (ou autre)**

**✅ OUI, c'est possible !**

**Comment ça fonctionne :**

Le Data Pod accepte **n'importe quel token OAuth2 valide**, pas seulement ceux émis par Hydra.

**Flow :**
```
1. Website → Better Auth (ou autre provider)
2. Better Auth → Émet token OAuth2
3. Website → Data Pod API (avec token)
4. Data Pod → Valide token (n'importe quel provider OAuth2)
```

**Mais attention :** Il faut que le Data Pod puisse valider le token.

**Solutions :**

##### **Solution A : Token Exchange (Recommandé)**

```
1. Website → Better Auth (login)
2. Website → Hydra (exchange token)
   - POST /oauth2/token
   - grant_type: urn:ietf:params:oauth:grant-type:token-exchange
   - subject_token: <token from Better Auth>
3. Hydra → Valide token Better Auth
4. Hydra → Émet nouveau token (compatible Synap)
5. Website → Data Pod API (avec token Hydra)
```

**Avantages :**
- ✅ Website peut utiliser n'importe quel provider
- ✅ Data Pod utilise toujours Hydra (cohérence)
- ✅ Standard OAuth2 Token Exchange

##### **Solution B : Multi-Provider Support**

Le Data Pod accepte des tokens de plusieurs providers :

```typescript
// Data Pod valide token
async function validateToken(token: string) {
  // Essayer Hydra d'abord
  const hydraToken = await hydra.introspectToken(token);
  if (hydraToken) return hydraToken;
  
  // Essayer Better Auth
  const betterAuthToken = await betterAuth.validateToken(token);
  if (betterAuthToken) return betterAuthToken;
  
  // Essayer autre provider
  // ...
}
```

**Avantages :**
- ✅ Flexibilité maximale
- ✅ Pas de changement pour websites existants

**Inconvénients :**
- ⚠️ Plus complexe à maintenir
- ⚠️ Sécurité à valider pour chaque provider

---

## 6. Recommandation pour les Websites Clients

### 6.1. Stratégie Recommandée

**Approche hybride :**

1. **Par défaut** : Websites utilisent Ory (Hydra + Kratos)
   - Standard OAuth2
   - Sécurité maximale
   - Scopes granulaires

2. **Optionnel** : Websites peuvent utiliser leur propre provider
   - Via Token Exchange (Solution A)
   - Ou Multi-Provider Support (Solution B)

### 6.2. Architecture Proposée

```
┌─────────────────────────────────────────────────────────┐
│  Website Client (Créé par développeur tiers)            │
│                                                          │
│  Option 1: Utilise Ory (Recommandé)                      │
│    → Hydra (OAuth2)                                     │
│    → Kratos (Login)                                     │
│                                                          │
│  Option 2: Utilise Better Auth (ou autre)              │
│    → Better Auth (Login)                                │
│    → Hydra (Token Exchange) ← NOUVEAU                   │
│                                                          │
│  Option 3: Utilise autre provider OAuth2                │
│    → Provider (Login)                                    │
│    → Hydra (Token Exchange) ← NOUVEAU                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Token OAuth2 (émis par Hydra)
                     │
┌────────────────────▼────────────────────────────────────┐
│  Data Pod (Resource Server)                             │
│                                                          │
│  - Valide token avec Hydra                              │
│  - Vérifie scopes                                       │
│  - Retourne données                                     │
└─────────────────────────────────────────────────────────┘
```

### 6.3. Token Exchange Flow (Détaillé)

**Pour permettre aux websites d'utiliser leur propre provider :**

```typescript
// Dans Hydra, configurer Token Exchange
// hydra/hydra.yml
oauth2:
  grant_types:
    - authorization_code
    - client_credentials
    - refresh_token
    - urn:ietf:params:oauth:grant-type:token-exchange  # ← NOUVEAU

// Website flow
1. Website → Better Auth (login)
2. Better Auth → Émet token
3. Website → Hydra Token Exchange
   POST /oauth2/token
   {
     grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
     client_id: "website-client-id",
     client_secret: "website-secret",
     subject_token: "<token from Better Auth>",
     subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
     requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
     scope: "read:notes write:tasks"
   }
4. Hydra → Valide token Better Auth
5. Hydra → Émet nouveau token (compatible Synap)
6. Website → Data Pod API (avec token Hydra)
```

**Avantages :**
- ✅ Websites peuvent utiliser n'importe quel provider
- ✅ Data Pod utilise toujours Hydra (cohérence)
- ✅ Standard OAuth2 (RFC 8693)

---

## 7. Réponse à Vos Questions

### 7.1. "Est-ce que Hydra est serveur-side et Kratos client-side ?"

**Réponse :** Partiellement correct, mais :
- **Kratos** = Les deux (gère les utilisateurs ET les sessions côté client)
- **Hydra** = Serveur uniquement (émet des tokens)

**Meilleure compréhension :**
- **Kratos** = "Qui êtes-vous ?" (Identity Provider)
- **Hydra** = "Qu'est-ce que vous pouvez faire ?" (OAuth2 Server)

### 7.2. "Est-ce que ça fonctionne pour Data Pod ↔ Intelligence Hub ?"

**✅ OUI** - Via OAuth2 Client Credentials (M2M)

### 7.3. "Est-ce que ça fonctionne pour Data Pod ↔ Agents Externes ?"

**✅ OUI** - Via OAuth2 Authorization Code (avec consent screen)

### 7.4. "Est-ce que ça fonctionne pour Data Pod ↔ Websites Clients ?"

**✅ OUI** - Avec flexibilité :
- **Option 1** : Website utilise Ory (recommandé)
- **Option 2** : Website utilise Better Auth → Token Exchange
- **Option 3** : Website utilise autre provider → Token Exchange

### 7.5. "Est-ce que les websites peuvent utiliser Better Auth ?"

**✅ OUI** - Via Token Exchange (Solution A) ou Multi-Provider Support (Solution B)

**Recommandation :** Token Exchange (Solution A)
- Standard OAuth2
- Flexibilité maximale
- Cohérence (Data Pod utilise toujours Hydra)

---

## 8. Architecture Finale Recommandée

```
┌─────────────────────────────────────────────────────────┐
│  Écosystème Synap                                        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Ory Kratos (Identity Provider)                   │  │
│  │  - Gère utilisateurs                              │  │
│  │  - Authentification                                │  │
│  │  - Sessions                                        │  │
│  └──────────────────┬───────────────────────────────┘  │
│                     │                                    │
│  ┌──────────────────▼───────────────────────────────┐  │
│  │  Ory Hydra (OAuth2 Server)                         │  │
│  │  - Émet tokens OAuth2                              │  │
│  │  - Gère scopes                                     │  │
│  │  - Token Exchange (pour websites)                 │  │
│  └──────────────────┬───────────────────────────────┘  │
│                     │                                    │
│  ┌──────────────────▼───────────────────────────────┐  │
│  │  Data Pod (Resource Server)                        │  │
│  │  - Valide tokens Hydra                             │  │
│  │  - Vérifie scopes                                  │  │
│  │  - Retourne données                                │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  Clients :                                               │
│  - Intelligence Hub (Client Credentials)                │
│  - Agents Externes (Authorization Code)                 │
│  - Websites (Authorization Code OU Token Exchange)      │
└─────────────────────────────────────────────────────────┘
```

---

## 9. Conclusion

### 9.1. Résumé

- **Kratos** = Gestion des identités (qui êtes-vous ?)
- **Hydra** = Gestion des tokens (qu'est-ce que vous pouvez faire ?)
- **Ils travaillent ensemble** pour fournir un système d'authentification complet

### 9.2. Avantages

- ✅ Standard OAuth2 (compatible avec tout)
- ✅ Scopes granulaires
- ✅ Flexibilité pour websites (Token Exchange)
- ✅ Marketplace d'agents possible

### 9.3. Inconvénients

- ⚠️ Complexité opérationnelle (2 services)
- ⚠️ Migration utilisateurs (re-login nécessaire)
- ⚠️ Courbe d'apprentissage

### 9.4. Réponse à Votre Préoccupation

> "Je ne veux pas bloquer les créateurs de websites sur cette technologie spécifique"

**✅ Vous ne les bloquez PAS !**

**Solutions :**
1. **Token Exchange** : Websites peuvent utiliser n'importe quel provider OAuth2
2. **Multi-Provider Support** : Data Pod peut valider plusieurs providers
3. **Standard OAuth2** : Compatible avec tous les providers standards

**Les websites peuvent utiliser :**
- ✅ Ory (recommandé)
- ✅ Better Auth (via Token Exchange)
- ✅ Auth0 (via Token Exchange)
- ✅ Firebase Auth (via Token Exchange)
- ✅ N'importe quel provider OAuth2 standard

---

**Prochaine étape :** Valider cette architecture et commencer l'implémentation avec Token Exchange support.

