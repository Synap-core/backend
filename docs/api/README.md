# API Reference

**Référence de l'API tRPC Synap Backend**

---

## 🎯 Vue d'Ensemble

L'API Synap utilise **tRPC** pour une API type-safe end-to-end.

**Base URL :** `http://localhost:3000/trpc`

**Format :** HTTP POST avec JSON

---

## 📚 Routers Disponibles

### Notes Router
Gestion des notes.

**Endpoints :**
- `notes.create` - Créer une note
- `notes.list` - Lister les notes
- `notes.get` - Récupérer une note
- `notes.update` - Mettre à jour une note
- `notes.delete` - Supprimer une note

### Chat Router
Interface conversationnelle.

**Endpoints :**
- `chat.sendMessage` - Envoyer un message
- `chat.getThread` - Récupérer un thread
- `chat.listThreads` - Lister les threads

### Events Router
Logging d'événements.

**Endpoints :**
- `events.log` - Logger un événement
- `events.list` - Lister les événements

### System Router
Informations système.

**Endpoints :**
- `system.health` - Health check
- `system.info` - Informations système
- `system.handlers` - Liste des handlers
- `system.tools` - Liste des tools

---

## 🔧 Utilisation

### Avec le SDK (Recommandé)

```typescript
import SynapClient from '@synap/client';

const synap = new SynapClient({
  url: 'http://localhost:3000',
  token: 'your-token',
});

// Créer une note
const result = await synap.notes.create.mutate({
  content: '# My Note\n\nContent here',
  title: 'My Note',
});
```

### Directement avec tRPC Client

```typescript
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@synap/api';

const client = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: 'http://localhost:3000/trpc',
      headers: {
        'Authorization': 'Bearer your-token',
      },
    }),
  ],
});

const result = await client.notes.create.mutate({
  content: '# My Note',
});
```

---

## 📖 Documentation Complète

- **[SDK npm Package](../development/SDK_NPM.md)** - Créer le client SDK
- **[Backend SDK Reference](../development/SDK_REFERENCE.md)** - Référence complète
- **[Getting Started](../getting-started/README.md)** - Installation

---

**Note :** Pour une référence complète des types, voir le code source dans `packages/api/src/routers/`.

