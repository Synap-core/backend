1. Product Requirements Document (PRD) - Synap Control Tower v1.0
   Objectif : Créer un dashboard de développement interne pour visualiser, débugger et interagir avec l'architecture événementielle du backend Synap.
   Personas Cibles :
   • Le Développeur Backend : A besoin de tracer le flux des événements et de débugger les workers.  • L'Architecte Système : A besoin d'une vue d'ensemble de la santé et de la composition du système.
   Features Clés (MVP)
1. Vue "Live Event Stream"
   • User Story : En tant que développeur, je veux voir tous les événements passer sur le bus en temps réel pour comprendre ce qui se passe dans le système à chaque instant.  • Description : Un flux vertical de cartes, où chaque carte représente un événement. Les nouveaux événements apparaissent en haut avec une animation subtile.  • Informations par Carte d'Événement :
   ▪ Type d'événement (ex: ⁠note.creation.requested).  ▪ Timestamp (format relatif, ex: "il y a 3 secondes").  ▪ Statut du traitement par les workers (⁠pending, ⁠success, ⁠error).  ▪ Un bouton "Inspecter" pour voir le payload JSON complet de l'événement.
1. Explorateur de "Capacités"
   • User Story : En tant qu'architecte, je veux voir tous les modules et handlers actuellement enregistrés dans le système pour valider mon architecture.  • Description : Une page statique avec plusieurs sections.  • Sections :
   ▪ Event Types : La liste de tous les types d'événements reconnus (⁠note.created, etc.).  ▪ Event Handlers (Workers) : Une table listant chaque classe de handler, l'événement auquel elle est abonnée, et son statut.  ▪ AI Tools : La liste des outils disponibles pour l'agent LangGraph.  ▪ API Routers : La liste des routeurs tRPC enregistrés.
1. Inspecteur de Trace d'Événement
   • User Story : En tant que développeur, quand un workflow échoue, je veux une vue détaillée de toutes les étapes pour trouver la source du problème rapidement.  • Description : Une vue modale ou une page séparée qui s'ouvre lorsqu'on clique sur "Inspecter" dans le Live Event Stream.  • Informations Affichées :
   ▪ Le payload JSON complet de l'événement initial.  ▪ Une chronologie visuelle des ⁠steps exécutés par le(s) worker(s) Inngest.  ▪ Le temps d'exécution pour chaque étape.  ▪ Les logs spécifiques à cette trace.  ▪ Le message d'erreur et la stack trace si une étape a échoué.
1. "Event Publisher" de Test
   • User Story : En tant que développeur, je veux pouvoir déclencher n'importe quel événement manuellement pour tester un handler spécifique sans avoir à passer par toute l'application.  • Description : Une interface simple avec :
   ▪ Un champ de sélection pour le ⁠type d'événement (auto-complété avec les types connus).  ▪ Un éditeur JSON pour le ⁠data (payload) de l'événement.  ▪ Un bouton "Publier l'Événement".
   Technologies Requises
   • Frontend : ⁠Vite + React + TypeScript (dans ⁠apps/admin-ui).  • UI : ⁠Mantine ou ⁠shadcn/ui (pour des composants prêts à l'emploi et une construction rapide).  • Communication Temps Réel : Un client WebSocket pour se connecter au backend.  • Backend (ajouts nécessaires) :
   ▪ Un endpoint WebSocket pour streamer les événements.  ▪ Des endpoints tRPC pour fournir les données (liste des capacités, traces, etc.).
