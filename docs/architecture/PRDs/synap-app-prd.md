
# **Document 1 : PRD de l'Application SaaS "Synap" v1.0**

**Titre :** Synap - Votre Partenaire de Pensée Conversationnel  
**Version :** 1.0 | **Statut :** Spécification Initiale

## **1. Vision & Proposition de Valeur**

### **Vision**
Devenir l'interface par défaut entre l'humain et sa connaissance numérique. Un point d'entrée unique, intelligent et conversationnel pour capturer, explorer et agir sur ses idées.

### **Proposition de Valeur Unique (UVP)**
> Pour les professionnels créatifs et les "power users" qui se sentent submergés par la fragmentation de leurs outils numériques, **Synap** est un **partenaire de pensée conversationnel** qui transforme le chaos de leurs idées brutes en clarté structurée. Contrairement aux applications de notes qui exigent que vous soyez un archiviste, Synap vous demande seulement de penser à voix haute.

### **Personas Cibles**
-   **Chloé, la Créatrice Chaotique :** A besoin de capturer des inspirations sans friction.
-   **Marc, le Chercheur de Connexions :** A besoin de découvrir des liens sémantiques dans sa connaissance.
-   **Antoine, l'Architecte :** A besoin d'un outil qui s'adapte à ses workflows complexes.

## **2. Expérience Utilisateur & Fonctionnalités Clés**

### **Le Principe Fondamental : Le "Super Input" est l'Application**
L'expérience utilisateur de Synap est radicalement simple. Elle est centrée sur une seule et unique interface : une barre de commande conversationnelle.

#### **User Flow Principal : Le Cycle de la Pensée**
1.  **Capturer :** L'utilisateur tape, dicte ou partage n'importe quoi dans le Super Input (une idée, un lien, une photo, un mémo vocal).
2.  **Comprendre :** L'IA (notre backend propriétaire) analyse l'input en temps réel, en s'appuyant sur le contexte du "Data Pod" de l'utilisateur.
3.  **Proposer :** L'IA répond avec une synthèse et des **actions intelligentes et contextuelles** (créer une tâche, lier à un projet, sauvegarder un contact).
4.  **Agir :** L'utilisateur confirme ou modifie ces actions dans le chat.
5.  **Persister :** L'action validée est envoyée au "Data Pod" de l'utilisateur via une commande événementielle standardisée (ex: `note.create.requested`).

### **Features du "Shell" Synap**

-   **Super Input Intelligent :**
    -   Routage d'intention (distingue une recherche d'une capture).
    -   Autocomplétion basée sur les entités du Data Pod.
-   **Interface de Chat Avancée :**
    -   Historique de conversation immuable et "branchable".
    -   Affichage de réponses enrichies (cartes, boutons d'action, formulaires dynamiques).
    -   Notifications temps réel (via WebSockets).
-   **Navigateur de Contexte :**
    -   Visualisation de l'arborescence des "threads" de pensée.
    -   Navigation facile entre les projets et les branches d'exploration.
-   **Inbox de l'IA :**
    -   Un espace dédié où l'IA présente ses suggestions proactives (générées par les workers du "Cerveau Profond").
-   **Gestionnaire de Connexions :**
    -   Interface pour connecter l'application Synap au "Data Pod" de l'utilisateur (en entrant l'URL et la clé de son Pod).
    -   Interface pour se connecter à des services externes (Google Calendar, etc.).

## **3. Architecture Technique de l'Application Synap**

L'application Synap est un **"Shell" pur**. C'est un client "stupide" qui ne contient aucune logique métier.

-   **Frameworks :** Next.js (Web), Expo (Mobile), Tamagui (UI Partagée).
-   **Dépendance Unique :** Sa seule dépendance métier est le **`@synap/client` SDK**.
-   **Communication :**
    -   Toutes les lectures de données se font via les méthodes de "Query" du SDK.
    -   Toutes les écritures se font via les méthodes de "Commande" orientées intention du SDK (qui publient des événements).
    -   Toutes les interactions IA passent par `sdk.chat.sendMessage()`.
-   **Déploiement :** En tant que SaaS sur Vercel et les App Stores.

## **4. Monétisation**

L'application Synap sera le véhicule de notre modèle Freemium.
-   **Utilisateurs Gratuits :** Ont accès à Synap, mais les appels à notre backend d'intelligence propriétaire sont limités (ex: 50 analyses IA/mois).
-   **Utilisateurs Pro :** Paient un abonnement pour débloquer des appels illimités, des agents IA spécialisés, et des intégrations avancées.

