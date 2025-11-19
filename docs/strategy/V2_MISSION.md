Bien sûr. Voici le document complet.

C'est un document stratégique et architectural. Il est conçu pour servir de "source de vérité unique" pour toi, pour moi, et pour toute IA qui travaillera sur le projet. Il synthétise toutes nos discussions et définit la vision, l'architecture, et la roadmap pour passer de ton POC "Initiativ Core" à l'écosystème complet.

Donne ce document à l'IA pour qu'elle ait le contexte global, puis tu pourras lui demander de se concentrer sur les tâches de mise à jour du backend.

---

# **Document Stratégique et Architectural : De "Initiativ Core" à l'Écosystème Synap**

**Version :** 2.0 | **Statut :** Plan Directeur | **Date :** 2025-01-20

## **1. La Vision : Un Système d'Exploitation pour la Pensée**

Notre mission n'est pas de construire une application, mais un **écosystème**. Nous créons un standard pour une nouvelle génération d'outils numériques où l'utilisateur a une souveraineté totale sur ses données et où l'intelligence artificielle agit comme un partenaire symbiotique, et non comme un simple outil.

**Le concept fondamental est le "Data Pod Personnel" :** une "bulle" de données souveraine et isolée appartenant à chaque utilisateur, contenant sa base de connaissance (notes, tâches, projets), son historique d'actions (Event Store), et sa mémoire sémantique (Vector DB).

Notre écosystème se compose de trois produits principaux qui interagissent avec ce Data Pod.

## **2. Les Produits de l'Écosystème**

### **Produit 1 : Synap Core OS (Le Noyau Open Source)**
-   **Quoi :** Un backend headless, open source, et auto-hébergeable. C'est l'implémentation technique du "Data Pod".
-   **Rôle :** C'est le **cœur** du système. Il gère la persistance des données, la sécurité, et expose une API standardisée.
-   **Philosophie :** Il est agnostique. Il ne connaît rien des interfaces utilisateur. Il peut être configuré pour tourner en mode `local` (SQLite + Fichiers locaux) ou en mode `cloud` (PostgreSQL + Stockage Objet).
-   **Distribution :** Un repository GitHub public avec un `docker-compose.yml` pour un déploiement en une commande.

### **Produit 2 : The Architech (Le Constructeur d'Écosystème)**
-   **Quoi :** Une CLI de génération de code "industrielle".
-   **Rôle :** C'est le **gestionnaire de paquets et d'extensions** pour tout l'écosystème Synap. Il est utilisé à la fois par nous (pour construire et maintenir le Core OS) et par la communauté (pour l'étendre).
-   **Philosophie :** Un moteur agnostique qui exécute des "blueprints" depuis une Marketplace. Pour Synap, nous créerons une **Marketplace de "Capacités"** dédiée.
-   **Usage :**
    -   `npx @thearchitech/cli generate synap-core.genome.ts` -> Génère le backend Core OS de base.
    -   `npx @thearchitech/cli add @synap-marketplace/capability-crm` -> Ajoute la capacité "CRM" à une instance existante du Core OS.

### **Produit 3 : Synap Client SDK (`@synap/client`)**
-   **Quoi :** Un package npm TypeScript.
-   **Rôle :** C'est le **langage commun**, la couche d'abstraction qui connecte n'importe quelle application au Core OS.
-   **Philosophie :** Il abstrait la complexité. L'application cliente n'a pas besoin de savoir si le backend est local ou cloud, si le stockage est sur MinIO ou R2. Elle appelle simplement des méthodes comme `synap.notes.create(...)`.
-   **Usage :** Toutes les applications frontend (la nôtre, et celles de la communauté) doivent utiliser ce SDK.

## **3. L'Architecture d'Extensibilité : La "Double Extensibilité"**

C'est le concept qui rend notre écosystème unique. Le Core OS peut être étendu de deux manières complémentaires :

### **Type 1 : Les "Plugins Internes" (Capacités Installées)**
-   **Quoi :** Du code (schémas de DB, workers Inngest, outils IA) qui est ajouté et exécuté **à l'intérieur** du backend de l'utilisateur.
-   **Mécanisme :** Via **The Architech**. Un développeur crée un "module de capacité" qui est ensuite installé via la CLI, modifiant le code source du backend Core OS de l'utilisateur.
-   **Exemple :** Un plugin "Suivi des Habitudes" qui ajoute une table `habits` et des workers pour les rappels quotidiens.

### **Type 2 : Les "Services Externes" (Agents & API Connectés)**
-   **Quoi :** Des services intelligents et spécialisés (les nôtres ou ceux de tiers) hébergés à l'extérieur du Data Pod.
-   **Mécanisme :** Le Core OS de l'utilisateur les **appelle via des API sécurisées**. L'agent LangGraph local dispose d'un outil `callExternalService` pour orchestrer ces appels.
-   **Exemple :** L'intégration avec Google Calendar. Le Core OS appelle l'API de Google. Un autre exemple serait un service payant "d'analyse financière" qui reçoit les données de l'utilisateur et retourne un rapport.

## **4. L'Architecture Interne d'un "Data Pod" (Schéma Final)**

Ce schéma représente la structure interne de chaque instance du "Synap Core OS".

```mermaid
graph TD
    subgraph "Couche d'Interaction (Intention)"
        A[💬 Chat History (Hash-Chained Log)]
    end

    subgraph "Couche d'Actions (Audit)"
        B[⚡ Event Store (TimescaleDB)]
    end

    subgraph "Couche d'État (Vue Actuelle)"
        C[🗃️ DB d'État (SQL - Postgres/SQLite)]
        D[🧠 DB Vectorielle (pgvector)]
        E[📂 Stockage Fichiers (API S3 - R2/MinIO)]
    end
    
    subgraph "Couche de Versioning (Optionnelle)"
        F[🔄 Repo Git]
    end

    subgraph "Orchestration & Intelligence"
        G[🤖 Agent IA (LangGraph)]
        H[⚙️ Workers (Inngest)]
    end

    %% --- Les Flux ---
    
    A -- "Déclenche" --> G;
    G -- "Décide d'une Action" --> B;
    B -- "Déclenche des Workers" --> H;
    
    H -- "Mettent à jour" --> C;
    H -- "Mettent à jour" --> D;
    H -- "Mettent à jour" --> E;
    
    E -- "Peut être versionné par" --> F;
    
    G -- "Lit le contexte depuis" --> A;
    G -- "Lit le contexte depuis" --> C;
    G -- "Lit le contexte depuis" --> D;
    G -- "Lit le contexte depuis" --> E;
```

**Explication des Flux :**
1.  Tout commence par une **Conversation** (A).
2.  L'**Agent IA** (G) est le principal consommateur de cette conversation. Il l'utilise pour comprendre l'intention.
3.  Quand une action est décidée, l'Agent publie un **Événement** (B).
4.  L'**Event Store** est le journal immuable. Il déclenche des **Workers** (H).
5.  Les **Workers** exécutent la logique métier et mettent à jour l'**État** (C, D, E).
6.  Le **Stockage de Fichiers** (E) peut être synchronisé de manière asynchrone avec un **Repo Git** (F) pour le versioning humain.

---

## **5. La Roadmap "Little Wins" pour Construire cet Écosystème**

### **Épopée 1 : Le Noyau Open Source Configurable (Notre Priorité)**
-   **Objectif :** Finaliser une V1 du **Synap Core OS**. Un backend unique, mais configurable pour tourner en mode `local` ou `cloud`.
-   **Actions :**
    1.  Finaliser l'implémentation de l'architecture "Event-Driven Pure" (la mission de refactoring V0.6).
    2.  Implémenter les adaptateurs interchangeables pour la DB (`drizzle-sqlite` vs `drizzle-neon`) et le stockage (`minio-provider` vs `r2-provider`).
    3.  Créer le `docker-compose.yml` pour le déploiement self-hosted facile.
    4.  Publier le repo `synap-core-os` et le `client-sdk` sur GitHub.
-   🏆 **"Little Win" :** Nous avons un produit open source que la communauté peut utiliser et sur lequel nous pouvons construire.

### **Épopée 2 : L'Application "Synap SaaS"**
-   **Objectif :** Construire notre application "vitrine" et la lancer en bêta privée.
-   **Actions :**
    1.  Créer une nouvelle application Next.js/Tamagui.
    2.  Elle n'a qu'une seule dépendance : le `@synap/client` SDK.
    3.  Elle est configurée pour parler à notre backend SaaS (déployé en mode `cloud`).
    4.  Implémenter l'interface conversationnelle V5 que nous avons validée.
-   🏆 **"Little Win" :** Nous avons un produit utilisable, nous pouvons commencer le "dogfooding" et onboarder les premiers utilisateurs.

### **Épopée 3 : Le Système d'Extension (The Architech)**
-   **Objectif :** Prouver la vision de la plateforme extensible.
-   **Actions :**
    1.  Développer la commande `the-architech synap:add-capability`.
    2.  Créer notre premier "module de capacité" (ex: `capability-crm`).
    3.  Écrire un test qui installe cette capacité sur une instance du Core OS et valide que les nouvelles tables et API sont bien présentes.
-   🏆 **"Little Win" :** Notre OS est officiellement une plateforme extensible, prête pour une marketplace.

---
Ce document est notre nouvelle "source de vérité" stratégique. Il est le résultat de toutes nos itérations. Il est ambitieux, mais décomposé en étapes réalisables. C'est le plan que nous allons exécuter.

