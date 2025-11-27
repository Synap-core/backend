
# **Synap Intelligence Architecture V2.1 - De l'Intuition à l'Architecture Validée**

## **1. Notre Philosophie : La Séparation comme Stratégie (Confirmée)**

Notre vision fondamentale reste inchangée et est **fortement validée** par la recherche. La séparation entre un **Data Pod open source** (le gardien souverain des données) et un **Intelligence Hub propriétaire** (le cerveau externe) est alignée avec les meilleures pratiques de l'industrie (Solid Pods, architecture fédérée).

-   **Data Pod (Core OS) :** Il gère le stockage, l'API de base, le "Hub Protocol", et les plugins d'intégration simples (non-IA). Il possède un moteur LangGraph minimaliste pour les automatisations locales.
-   **Intelligence Hub :** Notre produit SaaS. Il héberge notre propriété intellectuelle : les agents IA complexes, la "Super Memory", l'analyse proactive.

## **2. Audit de Notre Architecture : Avant la Recherche vs. Après la Recherche**

C'est ici que nous faisons évoluer notre pensée. Ce tableau confronte nos idées initiales avec les révélations du rapport pour définir nos décisions stratégiques finales.

| **Composant** | **Notre Vision Initiale (Avant Recherche)** | **Ce que la Recherche Révèle (État de l'Art 2025)** | **✅ Décision Stratégique & Actions** |
|:---|:---|:---|:---|
| **Orchestration d'Agents** | "On utilisera LangChain/LangGraph." | LangGraph est bien le leader, mais la vraie valeur réside dans l'utilisation de **Design Patterns** avancés ("Supervisor", "Hierarchical"). | **Valider & Spécialiser :** Le Data Pod contient un graphe `simple` pour les plugins. L'Intelligence Hub implémente les patterns avancés (`Supervisor`, etc.) comme des **"plugins d'intelligence"** propriétaires. |
| **Recherche & Mémoire (RAG)** | "On met un RAG (pgvector) dans le Data Pod pour la recherche sémantique." | Le RAG vectoriel simple est **inefficace** pour les questions temporelles ("Qu'est-ce que je pensais la semaine dernière ?") et multi-niveaux. La solution "State-of-the-Art" est un **Graphe de Connaissance Temporel (Temporal KG)** qui combine relations et vecteurs. L'outil open source **Zep/Graphiti** est conçu pour cela. | **Déplacer & Sophistiquer :** On **retire** la logique RAG complexe du Data Pod. Le Pod garde `pgvector` pour de la recherche de similarité simple. L'**Intelligence Hub** implémentera la "Super Memory" en utilisant un service **Zep/Graphiti** dédié. |
| **IA Proactive** | "Des 'workers' analyseront les données." | C'est un problème de **Data Science** qui nécessite des outils spécifiques (analyse de séquences, détection d'anomalies) qui ne sont pas des LLM. La stack recommandée est **Inngest + Service Python externe** (avec `mlxtend`, `scikit-learn`). | **Externaliser & Spécialiser :** L'analyse de patterns se fera dans un **microservice Python externe** appelé par les workers Inngest de notre Intelligence Hub. Le Data Pod ne fait que fournir le flux d'événements brut. |
| **Sécurité & Écosystème** | "On utilisera des clés API ou Better Auth." | Pour un véritable écosystème avec des agents tiers, OAuth2 est le standard. Le rapport identifie la stack **Ory Hydra (serveur OAuth2) + Ory Kratos (Identity Provider)** comme la plus légère et la plus modulaire. | **Standardiser & Adopter :** Nous remplaçons notre authentification actuelle par la stack **Ory**. Le Data Pod devient un "Resource Server", le Hub un "Client" de confiance, et les agents tiers d'autres "Clients" avec des permissions granulaires (scopes). |

## **3. La "One Map" V2.1 : Architecture Cible Validée**

Ce nouveau schéma intègre nos décisions stratégiques.

```mermaid
graph TD
    subgraph "Écosystème Externe"
        Ory[🛡️ Ory Stack (Hydra/Kratos)]
        ExtAPI[🌍 API Externes (Google, etc.)]
    end

    subgraph "Data Pod de l'Utilisateur (Open Source)"
        DP_API[📡 API Publique (tRPC)]
        HubProto[🤝 Hub Protocol V1]
        DP_Agent[🧠 Agent Local (LangGraph simple)]
        Store[🗄️ DB (Postgres + pgvector)]
        
        DP_API -- Authentifié par --> Ory
        DP_API -- Appelle --> HubProto
        HubProto --> DP_Agent
        DP_Agent --> Store
    end

    subgraph "Notre Infrastructure SaaS (Propriétaire)"
        Hub[🤖 Intelligence Hub (Orchestrateur LangGraph)]
        Zep[🔮 Super Memory (Zep/Graphiti)]
        Analytics[🔬 Analytics Service (Python)]
        Paiement[💳 Paiements (Stripe)]
        
        Hub -- Appelle --> Zep
        Hub -- Appelle --> Analytics
        Hub -- Appelle --> Paiement
        Hub -- Authentifié par --> Ory
    end

    App[📱 App Cliente] -- Interagit avec --> DP_API
    Hub -- "Lit le contexte" --> HubProto
    Hub -- "Retourne un plan d'action" --> HubProto
```
**Changements Clés Visibles :**
-   **Ory** est maintenant le gardien central de l'identité et des accès.
-   La **"Super Memory" (Zep)** et l'**Analytics Service** sont des composants distincts à l'intérieur de notre infrastructure propriétaire.
-   Le Data Pod expose une API publique et le Hub Protocol, tous deux sécurisés par Ory.

---
## **4. La Nouvelle Roadmap : Construire l'Intelligence Hub V1**

Ce plan d'action se concentre sur la construction de notre produit propriétaire, en se basant sur cette nouvelle architecture validée.

### **Épopée 1 : Le "Cerveau" Prend Forme (4 semaines)**
-   **Objectif :** Construire le squelette de l'Intelligence Hub et sa mémoire avancée.

    1.  **Little Win 1.1 : Forker et Structurer.**
        -   **Action :** Créer le nouveau repository privé `synap-hub` en forkant la base du Core OS. Installer LangGraph. Mettre en place le pattern "Supervisor" de base comme orchestrateur principal.
        -   **Spécificité Tech :** Le graphe "Supervisor" a pour seul but de router vers d'autres agents et d'agréger leurs résultats.

    2.  **Little Win 1.2 : Déployer la "Super Memory".**
        -   **Action :** Déployer une instance de **Zep/Graphiti** dans notre infrastructure. Créer un "Tool" LangChain (`ZepMemoryTool`) qui permet à nos agents d'interroger cette mémoire (recherche temporelle, par similarité, etc.).
        -   **Spécificité Tech :** Zep sera configuré pour utiliser notre base de données PostgreSQL existante comme backend de stockage.

    3.  **Little Win 1.3 : La Première Connexion.**
        -   **Action :** Implémenter le "Hub Protocol Client" dans notre Hub. Créer un premier "Tool" qui utilise ce client pour lire les données du Data Pod (via `hub.requestData`) et les indexer dans Zep.
        -   **Spécificité Tech :** C'est la première utilisation concrète du protocole que nous avons défini.

🏆 **Résultat de l'Épopée 1 :** Nous avons un Intelligence Hub fonctionnel, capable de se connecter à un Data Pod, de lire ses données, de les stocker dans une mémoire avancée, et de les interroger. Les fondations sont posées.

### **Épopée 2 : Donner Vie aux Agents Experts (3 semaines)**
-   **Objectif :** Construire nos premiers "plugins d'intelligence" monétisables.

    1.  **Little Win 2.1 : L'Agent `ActionExtractor`.**
        -   **Action :** Créer notre premier agent expert. C'est un graphe LangGraph simple qui prend une phrase, utilise l'outil `ZepMemoryTool` pour le contexte, et retourne un `HubInsight` pour créer une note ou une tâche.
        -   **Spécificité Tech :** Cet agent sera optimisé pour la vitesse et le faible coût.

    2.  **Little Win 2.2 : L'Agent `KnowledgeSynthesizer`.**
        -   **Action :** Créer le deuxième agent expert, spécialisé dans les questions/réponses. Il utilisera intensivement `ZepMemoryTool` pour effectuer des recherches hybrides (vectorielles + graphe).
        -   **Spécificité Tech :** C'est cet agent qui justifie l'utilisation de Zep en répondant à des questions comme "Quelles étaient mes priorités la semaine dernière concernant le projet X ?".

🏆 **Résultat de l'Épopée 2 :** Nous avons deux "produits" d'IA distincts, démontrant des capacités différentes, que nous pouvons commencer à facturer.

### **Épopée 3 : Mettre en Place la Sécurité de l'Écosystème (En parallèle)**
-   **Objectif :** Remplacer notre système d'authentification par une solution de classe mondiale.

    1.  **Little Win 3.1 : Migration vers Ory.**
        -   **Action :** C'est un chantier technique majeur mais nécessaire. Remplacer Better Auth par la stack Ory. Le Core OS devient un "Resource Server", notre Hub un "Client" privilégié.
        -   **Spécificité Tech :** Implémenter le flux de "consentement" où l'utilisateur autorise explicitement le Hub à accéder à son Data Pod avec des `scopes` spécifiques.

🏆 **Résultat de l'Épopée 3 :** Notre architecture est prête à accueillir des agents tiers de manière sécurisée, ouvrant la voie à la marketplace.
