# Recommandation d'Authentification - Marketplace

**Date :** 2025-01-20  
**Question :** Où gérer l'authentification pour le marketplace de plugins/agents ?

---

## 🎯 Réponse Directe

**✅ L'Intelligence Hub DOIT avoir son propre système d'authentification (Ory Hydra)**

### Pourquoi ?

1. **Scalabilité** : Le Hub peut gérer des milliers de plugins sans que le Data Pod le sache
2. **Séparation des responsabilités** :
   - **Data Pod** = Authentification utilisateurs finaux
   - **Intelligence Hub** = Authentification plugins/agents du marketplace
3. **Performance** : Pas de goulot d'étranglement
4. **Sécurité** : Isolation des secrets de plugins

---

## 🏗️ Architecture Recommandée

```
┌─────────────────────────────────┐
│      Data Pod (Ory #1)          │
│  - Utilisateurs finaux          │
│  - Intelligence Hub (M2M)       │
└─────────────────────────────────┘
              │
              │ OAuth2 Client Credentials
              │
┌─────────────────────────────────┐
│  Intelligence Hub (Ory #2)       │
│  - Plugins/Agents externes      │
│  - Marketplace                  │
└─────────────────────────────────┘
              │
              │ OAuth2 Authorization Code
              │
┌─────────────────────────────────┐
│    Plugin/Agent Externe         │
└─────────────────────────────────┘
```

---

## 📊 Comparaison

| Aspect | Data Pod uniquement | Hub + Data Pod |
|--------|---------------------|----------------|
| Scalabilité | ❌ Faible | ✅ Élevée |
| Séparation | ❌ Faible | ✅ Excellente |
| Performance | ❌ Goulot | ✅ Optimale |
| Sécurité | ⚠️ Moyenne | ✅ Excellente |

---

## 🚀 Prochaine Étape

Implémenter Ory Hydra dans l'Intelligence Hub pour gérer l'authentification des plugins du marketplace.

**Voir :** `docs/architecture/AUTHENTICATION_ARCHITECTURE.md` pour les détails complets.

