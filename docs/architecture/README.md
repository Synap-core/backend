# Architecture

**Documentation technique de l'architecture Synap Backend**

---

## 📚 Documentation Disponible

### [Event-Driven Architecture](./EVENT_DRIVEN.md)
Architecture événementielle complète avec Inngest, Event Store, et CQRS.

**Contenu :**
- Vue d'ensemble du système
- Couches d'architecture (API, Event Bus, Workers, Storage)
- Patterns (CQRS, Event Sourcing)
- Flux de données
- Exemples de code

### [AI Architecture](./AI_ARCHITECTURE.md)
Architecture du système d'IA avec LangGraph et Vercel AI SDK.

**Contenu :**
- LangGraph pour l'orchestration
- Vercel AI SDK pour les appels LLM
- Flux de l'agent conversationnel
- Outils (tools) disponibles
- Configuration

### [Storage System](./STORAGE.md)
Système de stockage hybride (PostgreSQL + R2/MinIO).

**Contenu :**
- Architecture de stockage
- Adaptateurs (R2, MinIO)
- Séparation métadonnées/contenu
- Configuration
- Migration

---

## 🏗️ Vue d'Ensemble

Synap Backend suit une **architecture événementielle pure** avec :

1. **Event-Driven** : Inngest comme bus d'événements central
2. **CQRS** : Séparation Commands (écriture) / Queries (lecture)
3. **Event Sourcing** : TimescaleDB comme source de vérité immuable
4. **Hybrid Storage** : PostgreSQL pour métadonnées, R2/MinIO pour contenu
5. **Type-Safe** : TypeScript strict + validation Zod
6. **Local-First** : SQLite (single-user) ou PostgreSQL (multi-user)

---

## 📊 Schéma d'Architecture

```
┌─────────────────────────────────────────────────────────┐
│  API Layer (tRPC + Hono)                                │
│  • Commands → Events → Inngest                          │
│  • Queries → Projections (direct read)                  │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│  Event Bus (Inngest)                                    │
│  • Central orchestrator                                 │
│  • Event dispatcher                                     │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│  Workers (Event Handlers)                               │
│  • Business logic                                       │
│  • State updates                                        │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│  Storage Layer                                          │
│  • Event Store (TimescaleDB)                            │
│  • Projections (PostgreSQL/SQLite)                     │
│  • Content (R2/MinIO)                                   │
└─────────────────────────────────────────────────────────┘
```

---

## 🔗 Liens Utiles

- **[Getting Started](../getting-started/README.md)** - Installation
- **[Development](../development/README.md)** - Guides développeurs
- **[Deployment](../deployment/README.md)** - Déploiement

