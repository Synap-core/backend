



Parfait. Tu as raison, nous devons maintenant nous concentrer sur le "comment" de la construction. Ta séquence est la bonne : spécifier chaque brique avant de les assembler.

Commençons par le document le plus important, celui qui définit la fondation sur laquelle tout l'écosystème reposera.

---
---

# **Document 1 : PRD du Backend Open Source "Synap Core OS" (Le Data Pod)**

**Version :** 1.0 | **Statut :** Spécification Architecturale

## **1. Vision & Rôle dans l'Écosystème**

Le **Synap Core OS** est la **fondation souveraine de la connaissance personnelle**. Ce n'est pas une application, mais un **backend headless open source** qui constitue le "Data Pod" personnel de chaque utilisateur.

**Son unique rôle est de :**
1.  **Stocker** les données de l'utilisateur de manière sécurisée, structurée et portable.
2.  **Exposer** des interfaces (API) standardisées et stables pour que des applications ("Shells") et des services d'intelligence puissent interagir avec ces données, avec la permission de l'utilisateur.

Il est conçu pour être **agnostique** de l'interface et **configurable** pour un déploiement local (self-hosted) ou cloud.

## **2. Architecture et Modèle de Données : Comment le Pod Permet les Capacités Futures**

L'intelligence de l'écosystème Synap émerge de la manière dont les données sont structurées dans le Pod. L'architecture est conçue pour permettre des fonctionnalités avancées comme la mémoire à long terme, l'analyse de patterns et le "branching" de pensées.

### **2.1. La Hiérarchie de la Vérité**

Le Pod est gouverné par une hiérarchie de données stricte :
1.  **La Conversation (`conversation_history`) :** C'est la source de vérité de l'**intention** de l'utilisateur. Chaque interaction est un bloc immuable dans une chaîne cryptographique.
2.  **Le Journal d'Événements (`events`) :** C'est la source de vérité des **actions** validées qui résultent de la conversation.
3.  **Les Projections d'État (Tables SQL & Fichiers) :** C'est l'**état actuel** du monde de l'utilisateur, optimisé pour la lecture.

### **2.2. Schémas de Données Fondamentaux**

Voici les tables que le Data Pod **doit** implémenter pour permettre le bon fonctionnement de l'écosystème.

#### **Table `conversation_messages` (Permet le Chat et le Branching)**
-   **Objectif :** Stocker l'historique complet et immuable de toutes les conversations.
-   **Ce qu'elle permet :**
    -   **Le "Branching" :** La structure `parent_id` permet à une conversation de "forker" en plusieurs `thread_id`, créant des explorations parallèles. C'est la base de la réflexion non-linéaire.
    -   **La Mémoire Contextuelle :** Les agents IA peuvent lire l'historique d'un `thread_id` pour comprendre le contexte immédiat d'une requête.
-   **Schéma Drizzle :** `id (uuid)`, `thread_id (uuid)`, `parent_id (uuid)`, `previous_hash (text)`, `hash (text)`, `role (enum)`, `content (text)`, `metadata (jsonb)`.

#### **Table `events` (Permet les Automatisations)**
-   **Objectif :** Enregistrer chaque action atomique qui modifie l'état du système.
-   **Ce qu'elle permet :**
    -   **Les Automatisations :** C'est le déclencheur de tous les `workers` Inngest. Un événement `task.completed` peut déclencher un `worker` qui envoie une notification, un autre qui met à jour un rapport de projet, etc.
    -   **L'Audit et la Résilience :** Permet de reconstruire l'état en cas de problème.
-   **Schéma Drizzle (pour TimescaleDB) :** `id (uuid)`, `timestamp (timestamptz)`, `type (text)`, `data (jsonb)`, `correlation_id (uuid)`.

#### **Table `entities`, `relations`, et Tables "Composants" (Permet le Graphe de Connaissance)**
-   **Objectif :** Stocker l'état actuel des objets structurés et leurs liens.
-   **Ce qu'elles permettent :**
    -   **Un Graphe Extensible :** Le modèle `entities` (générique) + `task_details` (spécifique) permet aux plugins d'ajouter de nouveaux types d'objets (comme un `deal_details` pour un plugin CRM) sans modifier le noyau.
    -   **La Découverte d'Insights :** La table `relations` est exploitée par les agents du "Cerveau Profond" pour trouver des connexions sémantiques entre les entités.
-   **Schéma Drizzle :** Comme défini dans nos documents précédents.

#### **Table `knowledge_facts` (Permet la "Super Memory")**
-   **Objectif :** Stocker des faits atomiques et durables sur l'utilisateur. C'est une table que tu as mentionnée comme étant cruciale.
-   **Ce qu'elle permet :**
    -   **La Personnalisation Profonde :** Les agents IA lisent cette table pour adapter leur comportement. (Ex: `fact: "L'utilisateur préfère un ton formel"`).
    -   **La Mémoire à Long Terme :** C'est la "compression" des conversations passées. Un agent peut extraire un fait clé d'une conversation et le stocker ici pour une réutilisation future.
-   **Schéma Drizzle :** `id (uuid)`, `fact (text)`, `source_entity_id (uuid)`, `confidence (real)`, `embedding (vector)`.

#### **Table `user_preferences` (Permet le Contrôle Utilisateur)**
-   **Objectif :** Donner à l'utilisateur un contrôle granulaire sur le comportement de l'IA.
-   **Ce qu'elle permet :**
    -   L'utilisateur peut définir des règles comme "Ne jamais me suggérer de tâches le week-end" ou "Le ton de l'IA doit être 'poétique'". Ces préférences sont injectées dans le prompt système de tous les agents.
-   **Schéma Drizzle :** `id (uuid)`, `preference_key (text)`, `value (jsonb)`.

## **3. Interfaces et Capacités Exposées par le Data Pod**

Le Data Pod doit exposer une API standardisée et sécurisée. C'est le rôle du **SDK `@synap/client`** et du **Hub Protocol V1.0**.

### **3.1. Interfaces pour les Applications Client (Shells)**

-   **Interface d'Écriture (Commands) :** Le SDK doit exposer des méthodes orientées métier (`captureThought`, `completeTask`). En interne, toutes ces méthodes ne font qu'une seule chose : publier un événement sur l'Event Bus du Data Pod.
-   **Interface de Lecture (Queries) :** Le SDK expose des méthodes pour lire les projections d'état (`notes.list`, `projects.getById`). Elles sont rapides et directes.
-   **Interface de Conversation :** Le SDK expose `chat.sendMessage` comme point d'entrée principal pour l'interaction avec l'IA du Data Pod.
-   **Interface de Configuration :** Le SDK expose des méthodes pour lire et écrire dans la table `user_preferences`.

### **3.2. Interface pour l'Intelligence Hub (Hub Protocol V1.0)**

Le Data Pod expose un router tRPC dédié `hub.*` pour la communication avec le Synap Intelligence Hub. Cette interface garantit la sécurité, la traçabilité et la souveraineté des données.

**Endpoints principaux :**

-   **`hub.generateAccessToken`** : Génère un token JWT temporaire (5 minutes max) pour autoriser le Hub à accéder aux données
-   **`hub.requestData`** : Permet au Hub de demander des données en lecture seule selon un scope défini
-   **`hub.submitInsight`** : Permet au Hub de soumettre un insight structuré qui sera transformé en événements

**Caractéristiques de sécurité :**

- ✅ **Tokens à durée limitée** : Maximum 5 minutes de validité
- ✅ **Scope-based access** : Le Hub ne peut demander que les données explicitement autorisées
- ✅ **Audit trail complet** : Chaque accès est enregistré dans l'Event Store (`hub.token.generated`, `hub.data.requested`, `hub.insight.submitted`)
- ✅ **Transformation automatique** : Les insights de type `action_plan` sont automatiquement transformés en événements SynapEvent

**Format des insights :**

Les insights reçus du Hub suivent le schéma `HubInsightSchema V1.0` :

```typescript
{
  version: '1.0',
  type: 'action_plan' | 'suggestion' | 'analysis' | 'automation',
  correlationId: string, // UUID de la requête
  actions?: Action[], // Pour transformation en événements
  analysis?: Analysis, // Pour affichage à l'utilisateur
  confidence: number,
  reasoning?: string,
}
```

**Documentation complète :** Voir [Hub Protocol V1.0](./HUB_PROTOCOL_V1.md)

