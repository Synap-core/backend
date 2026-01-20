# Development

**Guides pour développeurs du Synap Backend**

---

## 📚 Documentation Disponible

### [Backend SDK Reference](./SDK_REFERENCE.md)

Référence complète du SDK backend avec tous les packages et leurs APIs.

**Contenu :**

- Packages disponibles (`@synap/core`, `@synap/database`, etc.)
- APIs de chaque package
- Exemples d'utilisation
- Patterns recommandés

### [Extensibility Guide V1](./EXTENSIBILITY_GUIDE_V1.md)

Guide complet pour étendre le Synap Core OS avec des capacités.

**Contenu :**

- Architecture d'extensibilité
- Internal Plugins vs External Services
- Ajouter une capacité (migration, worker, router, tool)
- Intégrer un service externe
- Exemples complets

### [Creating Custom Hubs](./CREATING_CUSTOM_HUB.md)

Guide pour créer des Hubs personnalisés (alternatives au Synap Intelligence Hub).

**Contenu :**

- Architecture des Hubs
- Utilisation de @synap/hub-protocol-client
- Utilisation de @synap/hub-orchestrator-base
- Exemples de code

### [SDK npm Package](./SDK_NPM.md)

Guide pour créer et publier le package npm `@synap/client`.

**Contenu :**

- Structure du package
- Implémentation du client tRPC
- Support React
- Support real-time
- Publication npm

---

## 🛠️ Outils de Développement

### Scripts Disponibles

```bash
# Développement
pnpm dev                    # Lance tous les services en watch mode

# Build
pnpm build                  # Build tous les packages

# Tests
pnpm test                   # Lance tous les tests
pnpm test:system            # Tests système complets

# Database
pnpm db:migrate             # Applique les migrations
pnpm db:studio              # Ouvre Drizzle Studio
```

### Structure du Monorepo

```
packages/
├── core/          # Configuration, logging, errors
├── types/         # Types TypeScript partagés
├── database/      # ORM, schémas, migrations
├── storage/       # Abstraction S3 (R2/MinIO)
├── api/           # tRPC routers, middleware
├── jobs/          # Inngest workers, handlers
├── ai/            # LangGraph agent, tools
└── auth/          # Authentification

apps/
├── api/           # API server (Hono + tRPC)
└── admin-ui/      # Interface d'administration
```

---

## 🎯 Workflows de Développement

### Ajouter une Nouvelle Capacité

1. **Créer la migration SQL** → `packages/database/src/schema/`
2. **Ajouter les event types** → `packages/types/src/event-types.ts`
3. **Créer l'event handler** → `packages/jobs/src/handlers/`
4. **Créer le router tRPC** → `packages/api/src/routers/`
5. **Créer l'AI tool** (optionnel) → `packages/ai/src/tools/`

Voir **[Extensibility Guide](./EXTENSIBILITY.md)** pour les détails.

### Tester Localement

```bash
# 1. Démarrer MinIO
docker compose up -d minio

# 2. Initialiser la DB
pnpm --filter database db:init

# 3. Lancer le backend
pnpm dev

# 4. Tester l'API
curl http://localhost:3000/health
```

---

## 📖 Documentation Complète

- **[Getting Started](../getting-started/README.md)** - Installation
- **[Architecture](../architecture/README.md)** - Architecture technique
- **[Deployment](../deployment/README.md)** - Déploiement
