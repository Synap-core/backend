# Intelligence Hub OAuth2 Client Setup

**Date :** 2025-01-20  
**Objectif :** Créer et configurer le client OAuth2 pour l'Intelligence Hub

---

## 📋 Vue d'Ensemble

L'Intelligence Hub utilise OAuth2 **Client Credentials** pour s'authentifier auprès du Data Pod. Ce flow est adapté pour les communications Machine-to-Machine (M2M) où il n'y a pas d'utilisateur final à authentifier.

---

## 🔐 Spécifications du Client

| Propriété | Valeur |
|:---|:---|
| **Client ID** | `synap-hub` |
| **Client Name** | `Intelligence Hub` |
| **Grant Types** | `client_credentials` |
| **Response Types** | `token` |
| **Scopes** | `hub:read hub:write` |
| **Token Endpoint Auth Method** | `client_secret_post` |
| **Access Token Strategy** | `opaque` |

---

## 🚀 Création du Client

### Prérequis

1. **Ory Hydra démarré** :
   ```bash
   docker compose up -d hydra postgres-ory
   ```

2. **Variables d'environnement** :
   ```bash
   HYDRA_ADMIN_URL=http://localhost:4445
   ```

### Exécution du Script

```bash
# Depuis la racine du projet
pnpm create:hub-client
```

Le script va :
1. ✅ Vérifier si le client existe déjà
2. ✅ Créer ou mettre à jour le client dans Hydra
3. ✅ Générer un `client_secret` sécurisé
4. ✅ Afficher les valeurs à ajouter dans `.env`

### Sortie Attendue

```
🔐 Creating OAuth2 client for Intelligence Hub...
   Client ID: synap-hub
   Admin URL: http://localhost:4445

✅ Client created successfully!

📋 Client Configuration:
   Client ID: synap-hub
   Client Secret: <generated-secret>
   Grant Types: client_credentials
   Scopes: hub:read hub:write
   Auth Method: client_secret_post

📝 Add these to your .env file:
   HUB_CLIENT_ID=synap-hub
   HUB_CLIENT_SECRET=<generated-secret>

✨ Done!
```

---

## 📝 Configuration

### Variables d'Environnement

Ajouter les valeurs générées dans votre fichier `.env` :

```env
# OAuth2 Clients - Intelligence Hub
HUB_CLIENT_ID=synap-hub
HUB_CLIENT_SECRET=<generated-secret>
```

### Fichiers Mis à Jour

- ✅ `env.example` - Variables documentées
- ✅ `env.production.example` - Variables documentées

---

## 🔄 Utilisation par l'Intelligence Hub

### Obtenir un Token OAuth2

```typescript
// Exemple d'utilisation dans l'Intelligence Hub
const response = await fetch('http://localhost:4444/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.HUB_CLIENT_ID!,
    client_secret: process.env.HUB_CLIENT_SECRET!,
    scope: 'hub:read hub:write',
  }),
});

const { access_token } = await response.json();
```

### Utiliser le Token

```typescript
// Appeler le Data Pod avec le token
const dataPodResponse = await fetch('http://localhost:3000/trpc/hub.requestData', {
  headers: {
    'Authorization': `Bearer ${access_token}`,
  },
});
```

---

## 🔍 Vérification

### Vérifier le Client dans Hydra

```bash
# Via API Admin
curl http://localhost:4445/admin/clients/synap-hub \
  -H "Content-Type: application/json"
```

### Tester l'Obtainment d'un Token

```bash
curl -X POST http://localhost:4444/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=synap-hub" \
  -d "client_secret=<your-secret>" \
  -d "scope=hub:read hub:write"
```

Réponse attendue :
```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "hub:read hub:write"
}
```

---

## 🔐 Sécurité

### Stockage du Secret

- ✅ **Ne jamais commiter** le `HUB_CLIENT_SECRET` dans Git
- ✅ Utiliser des variables d'environnement
- ✅ Utiliser un gestionnaire de secrets en production (Vault, AWS Secrets Manager, etc.)

### Rotation du Secret

Pour régénérer le secret :

```bash
# Le script met à jour automatiquement le client existant
pnpm create:hub-client
```

Puis mettre à jour `HUB_CLIENT_SECRET` dans tous les environnements.

---

## 📚 Références

- **OAuth2 Client Credentials Flow** : [RFC 6749 Section 4.4](https://tools.ietf.org/html/rfc6749#section-4.4)
- **Ory Hydra Admin API** : [Documentation](https://www.ory.sh/docs/hydra/reference/api)
- **Hub Protocol V1** : `docs/architecture/PRDs/HUB_PROTOCOL_V1.md`

---

## ✅ Checklist

- [x] Script de création créé
- [x] Variables d'environnement documentées
- [x] Documentation créée
- [ ] Client créé dans Hydra (à faire après démarrage)
- [ ] Token testé (à faire après création)

---

**Prochaine étape :** Démarrer Hydra et exécuter le script pour créer le client.

