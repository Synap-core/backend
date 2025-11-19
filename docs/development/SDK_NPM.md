# SDK npm Package - Guide de Création

**Version :** 1.0 | **Date :** 2025-01-20

Ce document décrit l'approche pour créer et publier le SDK npm `@synap/client` qui permet aux applications frontend de communiquer avec le Synap Core OS.

---

## 📋 Vue d'Ensemble

Le SDK `@synap/client` est un package npm TypeScript qui :
- Fournit un client tRPC type-safe pour communiquer avec l'API Synap
- Abstrait la complexité (local vs cloud, R2 vs MinIO, etc.)
- Expose des méthodes simples comme `synap.notes.create(...)`
- Gère l'authentification automatiquement
- Supporte le real-time via WebSocket

---

## 🏗️ Architecture du SDK

### Structure du Package

```
packages/client/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Export principal
│   ├── client.ts             # Client tRPC
│   ├── types.ts              # Types partagés
│   ├── auth.ts               # Gestion de l'authentification
│   ├── realtime.ts           # WebSocket client
│   └── utils/
│       ├── http-link.ts      # HTTP link pour tRPC
│       └── websocket-link.ts # WebSocket link (optionnel)
└── dist/                     # Build output
```

### Dépendances

```json
{
  "name": "@synap/client",
  "version": "1.0.0",
  "dependencies": {
    "@trpc/client": "^11.0.0",
    "@trpc/server": "^11.0.0",
    "zod": "^3.22.0"
  },
  "peerDependencies": {
    "@tanstack/react-query": "^5.0.0",  // Optionnel, pour React
    "react": "^18.0.0"                   // Optionnel, pour React hooks
  }
}
```

---

## 🔧 Implémentation

### 1. Génération des Types tRPC

Le type `AppRouter` est déjà exporté depuis `@synap/api`. Pour le SDK, nous devons :

**Option A : Importer le type directement (recommandé pour monorepo)**

```typescript
// packages/client/src/types.ts
import type { AppRouter } from '@synap/api';

export type { AppRouter };
```

**Option B : Générer les types à partir du serveur (pour publication npm)**

Créer un script qui génère les types :

```typescript
// scripts/generate-client-types.ts
import { appRouter } from '@synap/api';
import { writeFileSync } from 'fs';
import { join } from 'path';

// Export le type AppRouter dans un fichier .d.ts
const typeDefinition = `
import type { AppRouter } from '@synap/api';
export type { AppRouter };
`;

writeFileSync(
  join(__dirname, '../packages/client/src/types.ts'),
  typeDefinition
);
```

### 2. Créer le Client tRPC

```typescript
// packages/client/src/client.ts
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './types.js';
import type { CreateTRPCClientOptions } from '@trpc/client';

export interface SynapClientConfig {
  url: string;
  token?: string;  // Pour SQLite mode (single-user)
  getToken?: () => Promise<string>;  // Pour PostgreSQL mode (Better Auth)
  headers?: Record<string, string>;
}

export function createSynapClient(config: SynapClientConfig) {
  const links = [
    httpBatchLink({
      url: `${config.url}/trpc`,
      headers: async () => {
        const headers: Record<string, string> = {
          ...config.headers,
        };

        // Ajouter le token d'authentification
        if (config.token) {
          headers['Authorization'] = `Bearer ${config.token}`;
        } else if (config.getToken) {
          const token = await config.getToken();
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }
        }

        return headers;
      },
    }),
  ];

  return createTRPCProxyClient<AppRouter>({
    links,
  });
}
```

### 3. Wrapper de Haut Niveau

```typescript
// packages/client/src/index.ts
import { createSynapClient, type SynapClientConfig } from './client.js';
import type { AppRouter } from './types.js';
import type { TRPCClient } from '@trpc/client';

export class SynapClient {
  private client: TRPCClient<AppRouter>;

  constructor(config: SynapClientConfig) {
    this.client = createSynapClient(config);
  }

  // Exposer les routers de manière conviviale
  get notes() {
    return this.client.notes;
  }

  get chat() {
    return this.client.chat;
  }

  get events() {
    return this.client.events;
  }

  get system() {
    return this.client.system;
  }

  // Méthodes utilitaires
  async health(): Promise<{ status: string }> {
    const response = await fetch(`${this.config.url}/health`);
    return response.json();
  }
}

// Export par défaut
export default SynapClient;

// Export du type
export type { AppRouter } from './types.js';
export type { SynapClientConfig } from './client.js';
```

### 4. Support React (Optionnel)

```typescript
// packages/client/src/react.ts
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from './types.js';

export const trpc = createTRPCReact<AppRouter>();

// Hook personnalisé
export function useSynapClient(config: SynapClientConfig) {
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: `${config.url}/trpc`,
        headers: async () => {
          // ... gestion auth
        },
      }),
    ],
  });

  return { client, trpc };
}
```

### 5. Support Real-Time (WebSocket)

```typescript
// packages/client/src/realtime.ts
import type { NotificationMessage } from '@synap/realtime';

export interface RealtimeConfig {
  url: string;
  userId: string;
  onMessage?: (message: NotificationMessage) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class SynapRealtimeClient {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(config: RealtimeConfig) {
    this.config = config;
  }

  connect(): void {
    const wsUrl = `${this.config.url}/rooms/user_${this.config.userId}/subscribe`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.config.onConnect?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const message: NotificationMessage = JSON.parse(event.data);
        this.config.onMessage?.(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    this.ws.onerror = (error) => {
      this.config.onError?.(new Error('WebSocket error'));
    };

    this.ws.onclose = () => {
      this.config.onDisconnect?.();
      this.attemptReconnect();
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect();
      }, 1000 * this.reconnectAttempts);
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

---

## 📦 Package.json

```json
{
  "name": "@synap/client",
  "version": "1.0.0",
  "description": "Type-safe client SDK for Synap Core OS",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./react": {
      "import": "./dist/react.mjs",
      "require": "./dist/react.js",
      "types": "./dist/react.d.ts"
    }
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "tsup src/index.ts src/react.ts --format cjs,esm --dts",
    "dev": "tsup src/index.ts --watch",
    "prepublishOnly": "pnpm build"
  },
  "dependencies": {
    "@trpc/client": "^11.0.0",
    "zod": "^3.22.0"
  },
  "peerDependencies": {
    "@tanstack/react-query": "^5.0.0",
    "react": "^18.0.0"
  },
  "devDependencies": {
    "@synap/api": "workspace:*",
    "@trpc/server": "^11.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.3.3"
  }
}
```

---

## 🚀 Utilisation

### Usage Basique (Vanilla JS/TS)

```typescript
import SynapClient from '@synap/client';

const synap = new SynapClient({
  url: 'http://localhost:3000',
  token: 'your-api-token',  // Pour SQLite mode
});

// Créer une note
const result = await synap.notes.create.mutate({
  content: '# My Note\n\nContent here',
  title: 'My Note',
});

// Lister les notes
const notes = await synap.notes.list.query();

// Envoyer un message
const response = await synap.chat.sendMessage.mutate({
  content: 'Hello, create a note about AI',
  threadId: 'thread-123',
});
```

### Usage avec React

```typescript
import { useSynapClient } from '@synap/client/react';

function MyComponent() {
  const { trpc } = useSynapClient({
    url: 'http://localhost:3000',
    getToken: async () => {
      // Récupérer le token depuis Better Auth
      return await getSessionToken();
    },
  });

  const { data: notes } = trpc.notes.list.useQuery();
  const createNote = trpc.notes.create.useMutation();

  return (
    <div>
      {notes?.map(note => (
        <div key={note.id}>{note.title}</div>
      ))}
    </div>
  );
}
```

### Usage avec Real-Time

```typescript
import { SynapRealtimeClient } from '@synap/client/realtime';

const realtime = new SynapRealtimeClient({
  url: 'wss://realtime.synap.app',
  userId: 'user-123',
  onMessage: (message) => {
    console.log('Received:', message);
    if (message.type === 'note.creation.completed') {
      // Rafraîchir la liste des notes
    }
  },
});

realtime.connect();
```

---

## 📝 Checklist pour Publication npm

- [ ] Créer le package `packages/client/`
- [ ] Implémenter le client tRPC de base
- [ ] Ajouter le support React (optionnel)
- [ ] Ajouter le support real-time (optionnel)
- [ ] Configurer le build avec `tsup` ou `tsc`
- [ ] Ajouter les tests
- [ ] Créer un README avec exemples
- [ ] Configurer `.npmignore`
- [ ] Ajouter les scripts de publication dans `package.json`
- [ ] Tester la publication locale avec `npm pack`
- [ ] Publier sur npm avec `npm publish --access public`

---

## 🔄 Workflow de Développement

### 1. Développement Local (Monorepo)

```bash
# Dans packages/client/
pnpm dev  # Watch mode pour développement

# Dans l'app frontend
import SynapClient from '@synap/client';  # Utilise workspace:*
```

### 2. Build pour Publication

```bash
# Build le package
cd packages/client
pnpm build

# Tester localement
npm pack
# Installe dans un projet test
npm install ../client/synap-client-1.0.0.tgz
```

### 3. Publication sur npm

```bash
# Version bump
npm version patch|minor|major

# Publish
npm publish --access public
```

---

## 🎯 Prochaines Étapes

1. **Créer le package `packages/client/`**
   - Structure de base
   - Client tRPC minimal
   - Tests unitaires

2. **Intégrer avec le monorepo**
   - Workspace dependency
   - Build pipeline
   - Type generation

3. **Ajouter les fonctionnalités avancées**
   - Support React
   - Real-time WebSocket
   - Retry logic
   - Error handling

4. **Documentation**
   - README complet
   - Exemples de code
   - Guide de migration

5. **Publication**
   - Configuration npm
   - CI/CD pour auto-publish
   - Versioning strategy

---

**Note :** Ce SDK sera utilisé par toutes les applications frontend (notre app SaaS, et celles de la communauté) pour communiquer avec le Synap Core OS.

