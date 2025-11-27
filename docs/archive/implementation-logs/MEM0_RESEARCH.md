# Mem0 - Recherche Approfondie et Plan d'Intégration

**Date :** 2025-01-20  
**Objectif :** Comprendre Mem0 et créer un plan d'intégration détaillé pour Synap

---

## 1. Qu'est-ce que Mem0 ?

### 1.1. Vue d'Ensemble

**Mem0** est une couche de mémoire universelle open source (Apache 2.0) conçue pour améliorer les applications d'IA en fournissant une mémoire persistante et contextuelle. Elle permet aux agents IA de se souvenir des préférences utilisateur, de s'adapter aux besoins individuels et de s'améliorer continuellement.

### 1.2. Caractéristiques Principales

| Caractéristique | Description | Impact pour Synap |
|:---|:---|:---|
| **Temporal Knowledge Graph** | Graphe de faits avec versioning temporel | Permet queries comme "Qu'est-ce que je pensais en mai ?" |
| **Hybrid Retrieval** | Vector search + graph traversal | Meilleure précision que RAG simple |
| **Memory Compression** | Compresse l'historique en représentations optimisées | Réduit token usage jusqu'à 80% |
| **Self-Hosted** | Déploiement Docker possible | Souveraineté des données |
| **Performance** | +11% supérieur à Graphiti | Avantage compétitif validé |

### 1.3. Architecture Technique

**Composants :**
- **API Server** : Service REST Python (FastAPI)
- **Database** : PostgreSQL (pour stockage persistant)
- **Vector Store** : pgvector ou Qdrant (pour embeddings)
- **Graph Database** : Néo4j ou PostgreSQL avec relations (pour graphe temporel)

**Flux de Données :**
```
1. Agent IA → Mem0 API (add memory)
2. Mem0 → Extrait faits structurés
3. Mem0 → Stocke dans PostgreSQL + Vector Store
4. Mem0 → Construit graphe temporel
5. Agent IA → Mem0 API (search)
6. Mem0 → Recherche hybride (vector + graph)
7. Mem0 → Retourne faits pertinents
```

---

## 2. Options de Déploiement

### 2.1. Plateforme Hébergée (Mem0 Cloud)

**Avantages :**
- ✅ Setup rapide (quelques minutes)
- ✅ Infrastructure gérée
- ✅ Scaling automatique
- ✅ SOC 2 / HIPAA compliant

**Inconvénients :**
- ❌ Données hébergées chez Mem0
- ❌ Coût par usage
- ❌ Moins de contrôle

**Prix :** Pay-as-you-go (non spécifié publiquement)

### 2.2. Self-Hosted (Open Source)

**Avantages :**
- ✅ Contrôle total des données
- ✅ Pas de coût par usage
- ✅ Personnalisation possible
- ✅ Conforme à notre vision de souveraineté

**Inconvénients :**
- ⚠️ Maintenance opérationnelle
- ⚠️ Setup plus complexe
- ⚠️ Scaling manuel

**Recommandation pour Synap :** **Self-Hosted** (aligné avec notre vision de souveraineté)

---

## 3. Installation et Configuration

### 3.1. Méthode 1 : Docker Compose (Recommandé)

**Repository GitHub :** `https://github.com/mem0ai/mem0`

**Structure Docker :**
```yaml
services:
  mem0:
    image: mem0ai/mem0:latest  # Ou build depuis source
    ports:
      - "8765:8765"  # API Server
    environment:
      - MEM0_DATABASE_URL=postgresql://user:pass@postgres:5432/mem0
      - MEM0_API_KEY=${MEM0_API_KEY}  # Généré ou configuré
      - OPENAI_API_KEY=${OPENAI_API_KEY}  # Pour embeddings
    depends_on:
      - postgres-mem0
    volumes:
      - mem0_data:/data

  postgres-mem0:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: mem0
      POSTGRES_USER: mem0
      POSTGRES_PASSWORD: ${MEM0_DB_PASSWORD}
    volumes:
      - mem0_db_data:/var/lib/postgresql/data
```

**Prérequis :**
- PostgreSQL 15+
- pgvector extension (pour vector search)
- OpenAI API key (pour embeddings) OU modèle local

### 3.2. Méthode 2 : Build depuis Source

```bash
git clone https://github.com/mem0ai/mem0.git
cd mem0
make build
make up
```

**Avantages :**
- Contrôle total sur la version
- Personnalisation possible
- Debugging facilité

**Inconvénients :**
- Plus complexe
- Maintenance du build

### 3.3. Configuration Requise

**Variables d'Environnement :**
```env
# Mem0 Server
MEM0_API_URL=http://localhost:8765
MEM0_API_KEY=your-api-key-here  # Généré ou configuré

# Database
MEM0_DATABASE_URL=postgresql://mem0:password@postgres:5432/mem0

# Embeddings Provider
OPENAI_API_KEY=sk-...  # Pour OpenAI embeddings
# OU
ANTHROPIC_API_KEY=sk-ant-...  # Pour Anthropic embeddings
# OU
LOCAL_EMBEDDINGS_MODEL=all-MiniLM-L6-v2  # Pour modèle local
```

---

## 4. API et Client SDK

### 4.1. API REST

**Base URL :** `http://localhost:8765`

**Endpoints Principaux :**

| Endpoint | Méthode | Description |
|:---|:---|:---|
| `/api/v1/memories` | POST | Ajouter une mémoire |
| `/api/v1/memories/search` | POST | Rechercher des mémoires |
| `/api/v1/memories/{memory_id}` | GET | Obtenir une mémoire |
| `/api/v1/memories/{memory_id}` | DELETE | Supprimer une mémoire |
| `/api/v1/facts` | POST | Ajouter un fait structuré |
| `/api/v1/facts/search` | POST | Rechercher des faits |

**Authentification :**
- Header : `Authorization: Bearer {MEM0_API_KEY}`

### 4.2. SDK Python

```python
from mem0 import Memory

# Initialisation
m = Memory(
    api_url="http://localhost:8765",
    api_key="your-api-key"
)

# Ajouter une mémoire
messages = [
    {"role": "user", "content": "Je travaille sur le projet Synap."},
    {"role": "assistant", "content": "Je me souviendrai de ça."}
]
m.add(messages, user_id="user-123")

# Rechercher
results = m.search(
    "Quels sont mes projets en cours ?",
    filters={"user_id": "user-123"}
)
```

### 4.3. SDK JavaScript/TypeScript

**Note :** Mem0 a un SDK JavaScript, mais moins mature que Python.

**Alternative :** Utiliser directement l'API REST avec `fetch` ou un client HTTP.

```typescript
// Client REST custom
const response = await fetch('http://localhost:8765/api/v1/memories', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${MEM0_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    messages: [...],
    user_id: 'user-123',
  }),
});
```

---

## 5. Intégration dans Synap

### 5.1. Architecture Proposée

```
┌─────────────────────────────────────────────────────────┐
│  Intelligence Hub (Propriétaire)                        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  LangGraph Agents                                │  │
│  │  - ActionExtractor                               │  │
│  │  - KnowledgeSynthesizer                          │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
│  ┌──────────────▼───────────────────────────────────┐  │
│  │  MemoryLayer Service                             │  │
│  │  - Wrapper autour de Mem0 API                   │  │
│  │  - Abstraction pour agents                       │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
│  ┌──────────────▼───────────────────────────────────┐  │
│  │  Mem0 Service (Docker)                           │  │
│  │  - API Server (Python)                           │  │
│  │  - PostgreSQL + pgvector                        │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 5.2. Service MemoryLayer

**Rôle :** Abstraction TypeScript autour de l'API Mem0 REST.

**Fichier :** `packages/intelligence-hub/src/services/memory-layer.ts`

**Fonctions Principales :**
- `addMemory(userId, messages)` - Ajouter une mémoire
- `searchMemory(userId, query, options)` - Rechercher
- `addFact(userId, fact)` - Ajouter un fait structuré
- `searchFacts(userId, query, dateRange)` - Recherche temporelle
- `deleteMemory(userId, memoryId)` - Supprimer

### 5.3. Tool LangGraph

**Rôle :** Outil pour agents LangGraph pour accéder à Mem0.

**Fichier :** `packages/intelligence-hub/src/tools/mem0-tool.ts`

**Utilisation :**
```typescript
// Dans un agent LangGraph
const tools = [
  Mem0MemoryTool,  // Recherche dans Mem0
  // ... autres tools
];
```

### 5.4. Indexation depuis Data Pod

**Rôle :** Worker Inngest qui indexe les données du Data Pod dans Mem0.

**Fichier :** `packages/intelligence-hub/src/workers/memory-indexer.ts`

**Flow :**
1. Événement `synap/data.updated` déclenche le worker
2. Worker récupère données via Hub Protocol
3. Worker extrait faits structurés
4. Worker indexe dans Mem0

---

## 6. Considérations Techniques

### 6.1. Performance

**Benchmarks (selon documentation Mem0) :**
- +11% vs Graphiti
- -27% token usage vs RAG simple
- Latence : <100ms pour recherche simple, <500ms pour recherche complexe

**Optimisations :**
- Cache des résultats fréquents
- Batch indexing
- Async processing pour indexation

### 6.2. Sécurité

**Points d'Attention :**
- ✅ API Key pour authentification
- ✅ Isolation par `user_id` (multi-tenant)
- ✅ HTTPS en production
- ⚠️ PostgreSQL doit être sécurisé (RLS si partagé)

**Recommandations :**
- Générer `MEM0_API_KEY` sécurisé (32+ caractères)
- Utiliser PostgreSQL dédié pour Mem0
- Activer SSL/TLS pour connexions DB

### 6.3. Scaling

**Horizontal Scaling :**
- Mem0 API : Stateless, peut scaler avec load balancer
- PostgreSQL : Read replicas pour recherche
- Vector Store : Sharding par `user_id`

**Vertical Scaling :**
- PostgreSQL : Plus de RAM pour cache
- Vector Store : GPU pour embeddings (optionnel)

### 6.4. Monitoring

**Métriques à Surveiller :**
- Latence API Mem0
- Taux d'erreur
- Utilisation DB
- Taille des mémoires par utilisateur

**Outils :**
- Prometheus + Grafana
- Logs structurés (JSON)

---

## 7. Alternatives Considérées

### 7.1. PostgreSQL Temporal (Alternative Simple)

**Avantages :**
- ✅ Déjà utilisé dans Synap
- ✅ Pas de service supplémentaire
- ✅ Plus simple à maintenir

**Inconvénients :**
- ❌ -11% performance vs Mem0
- ❌ Pas de graphe temporel natif
- ❌ Plus de code custom à maintenir

**Recommandation :** Commencer avec Mem0 si performance critique, sinon PostgreSQL temporal pour MVP.

### 7.2. Graphiti

**Avantages :**
- ✅ Intégration LangChain native
- ✅ TypeScript/JavaScript

**Inconvénients :**
- ❌ -11% performance vs Mem0
- ❌ Moins mature
- ❌ Pas de temporal reasoning natif

**Recommandation :** Mem0 est supérieur.

---

## 8. Plan d'Implémentation

### 8.1. Phase 1 : Infrastructure (Semaine 1)

**Objectifs :**
- Déployer Mem0 en Docker
- Configurer PostgreSQL + pgvector
- Tester API de base

**Livrables :**
- `docker-compose.yml` avec service Mem0
- Variables d'environnement configurées
- Tests de santé API

### 8.2. Phase 2 : Service Layer (Semaine 1-2)

**Objectifs :**
- Créer `MemoryLayer` service
- Implémenter fonctions principales
- Tests unitaires

**Livrables :**
- `packages/intelligence-hub/src/services/memory-layer.ts`
- Tests unitaires
- Documentation

### 8.3. Phase 3 : Intégration LangGraph (Semaine 2)

**Objectifs :**
- Créer `Mem0MemoryTool`
- Intégrer dans agents
- Tests end-to-end

**Livrables :**
- `packages/intelligence-hub/src/tools/mem0-tool.ts`
- Agent `KnowledgeSynthesizer` utilisant Mem0
- Tests E2E

### 8.4. Phase 4 : Indexation (Semaine 3)

**Objectifs :**
- Créer worker d'indexation
- Indexer données Data Pod
- Monitoring

**Livrables :**
- `packages/intelligence-hub/src/workers/memory-indexer.ts`
- Worker Inngest fonctionnel
- Dashboard monitoring

---

## 9. Risques et Mitigations

| Risque | Impact | Probabilité | Mitigation |
|:---|:---|:---|:---|
| **Service Python à maintenir** | Moyen | Élevée | Docker + monitoring |
| **Performance insuffisante** | Faible | Faible | Benchmarks avant déploiement |
| **Complexité opérationnelle** | Moyen | Moyenne | Documentation complète |
| **Coût embeddings** | Faible | Moyenne | Cache + batch processing |

---

## 10. Conclusion

**Mem0 est un choix stratégique pour Synap :**
- ✅ Performance supérieure validée
- ✅ Open source = contrôle total
- ✅ Self-hosted = souveraineté
- ✅ Temporal reasoning = valeur ajoutée

**Prochaine étape :** Créer le plan d'action détaillé avec fichiers à créer/modifier.

