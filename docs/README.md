# 📚 Synap Backend Documentation

**Documentation complète du Synap Core OS - Backend Event-Driven avec IA**

---

## 🗺️ Navigation Rapide

### Pour Démarrer
- **[Getting Started](./getting-started/README.md)** - Installation et premier démarrage
- **[Quick Start Guide](./getting-started/QUICKSTART.md)** - Guide rapide en 3 étapes
- **[Setup Guide](./getting-started/SETUP.md)** - Configuration détaillée

### Architecture & Concepts
- **[Architecture Overview](./architecture/README.md)** - Vue d'ensemble de l'architecture
- **[Ecosystem Analysis](./architecture/ECOSYSTEM_ANALYSIS.md)** - Analyse complète de l'écosystème
- **[Event-Driven Architecture](./architecture/EVENT_DRIVEN.md)** - Architecture événementielle
- **[AI Architecture](./architecture/AI_ARCHITECTURE.md)** - Système d'IA (LangGraph + Vercel AI SDK)
- **[Authentication Architecture](./architecture/AUTHENTICATION_ARCHITECTURE.md)** - Architecture d'authentification
- **[Storage System](./architecture/STORAGE.md)** - Système de stockage (R2/MinIO)
- **[Hub Protocol V1.0](./architecture/PRDs/HUB_PROTOCOL_V1.md)** - Spécification du Hub Protocol

### Développement
- **[Developer Guide](./development/README.md)** - Guide pour développeurs
- **[Backend SDK Reference](./development/SDK_REFERENCE.md)** - Référence du SDK backend
- **[Extensibility Guide V1](./development/EXTENSIBILITY_GUIDE_V1.md)** - Comment étendre le système
- **[Creating Custom Hubs](./development/CREATING_CUSTOM_HUB.md)** - Guide pour créer des Hubs personnalisés
- **[SDK npm Package](./development/SDK_NPM.md)** - Créer le package @synap/client

### Déploiement
- **[Deployment Guide](./deployment/README.md)** - Guide de déploiement
- **[Docker Deployment](./deployment/DOCKER.md)** - Déploiement avec Docker
- **[Production Setup](./deployment/PRODUCTION.md)** - Configuration production

### Vision & Stratégie
- **[V2 Mission](./strategy/V2_MISSION.md)** - Vision et roadmap V2.0
- **[Roadmap](./strategy/ROADMAP.md)** - Feuille de route

### Référence
- **[API Reference](./api/README.md)** - Référence de l'API tRPC
- **[Changelog](../CHANGELOG.md)** - Historique des versions

---

## 📖 Structure de la Documentation

```
docs/
├── README.md (ce fichier)
│
├── getting-started/          # Guides de démarrage
│   ├── README.md
│   ├── QUICKSTART.md
│   └── SETUP.md
│
├── architecture/             # Documentation technique
│   ├── README.md
│   ├── EVENT_DRIVEN.md
│   ├── AI_ARCHITECTURE.md
│   └── STORAGE.md
│
├── development/              # Guides pour développeurs
│   ├── README.md
│   ├── SDK_REFERENCE.md
│   ├── EXTENSIBILITY.md
│   └── SDK_NPM.md
│
├── deployment/               # Guides de déploiement
│   ├── README.md
│   ├── DOCKER.md
│   └── PRODUCTION.md
│
├── strategy/                 # Vision et stratégie
│   ├── V2_MISSION.md
│   ├── ROADMAP.md
│   └── PRD.md
│
├── api/                      # Référence API
│   └── README.md
│
└── archive/                  # Documentation historique
    └── ...
```

---

## 🎯 Par Où Commencer ?

### Nouveau sur Synap ?
1. Lisez **[Getting Started](./getting-started/README.md)**
2. Suivez le **[Quick Start Guide](./getting-started/QUICKSTART.md)**
3. Explorez **[Architecture Overview](./architecture/README.md)**

### Développeur Backend ?
1. **[Developer Guide](./development/README.md)**
2. **[Backend SDK Reference](./development/SDK_REFERENCE.md)**
3. **[Extensibility Guide](./development/EXTENSIBILITY.md)**

### Déploiement Production ?
1. **[Deployment Guide](./deployment/README.md)**
2. **[Docker Deployment](./deployment/DOCKER.md)**
3. **[Production Setup](./deployment/PRODUCTION.md)**

### Créer une Capacité ?
1. **[Extensibility Guide V1](./development/EXTENSIBILITY_GUIDE_V1.md)**
2. **[Backend SDK Reference](./development/SDK_REFERENCE.md)**
3. **[Creating Custom Hubs](./development/CREATING_CUSTOM_HUB.md)**

### Intégrer le SDK Frontend ?
1. **[SDK npm Package](./development/SDK_NPM.md)**
2. **[API Reference](./api/README.md)**

---

## 📝 Contribution

Pour améliorer la documentation :
1. Les fichiers sont organisés par thème
2. Utilisez des exemples de code clairs
3. Gardez la documentation à jour avec le code
4. Archivez les anciennes versions dans `archive/`

---

## 🔗 Liens Utiles

- **Repository GitHub** : [synap-core-os](https://github.com/synap/core-os)
- **Issues** : [GitHub Issues](https://github.com/synap/core-os/issues)
- **Discussions** : [GitHub Discussions](https://github.com/synap/core-os/discussions)

---

**Dernière mise à jour** : 2025-01-20
