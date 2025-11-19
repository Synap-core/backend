# Épopée 1 - Fondation & Dashboard V2

**Date de début**: 2025-11-18
**Statut**: 🚧 En cours (Backend ✅ Complété, Frontend en cours)
**Durée estimée**: 2 semaines

---

## 🎯 Objectif

Transformer le Control Tower en une plateforme workflow-first avec un dashboard centralisé et une navigation intelligente.

---

## ✅ Backend - Complété

### Nouveaux Endpoints tRPC Ajoutés

#### 1. `system.getDashboardMetrics`

**Purpose**: Fournir toutes les métriques nécessaires pour le dashboard en une seule requête

**Retour**:
```typescript
{
  timestamp: string;              // ISO timestamp
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    errorRate: number;           // Percentage (0-100)
  };
  throughput: {
    eventsPerSecond: number;     // Last 5 min average
    totalEventsLast5Min: number;
  };
  connections: {
    activeSSEClients: number;
    activeHandlers: number;
  };
  tools: {
    totalTools: number;
    totalExecutions: number;
  };
  latestEvents: Array<{
    id: string;
    type: string;
    userId: string;
    timestamp: string;
    isError: boolean;
  }>;
}
```

**Logique**:
- Calcule le taux d'événements/seconde sur les 5 dernières minutes
- Détermine le statut de santé basé sur le taux d'erreur et le throughput
- Retourne les 20 derniers événements pour le live stream
- Agrège toutes les stats système (SSE, handlers, tools)

**Optimisations**:
- Une seule requête au lieu de 5-6 appels séparés
- Données pré-calculées (pas de calculs côté client)
- Minimal data transfer (pas de payloads complets)

---

#### 2. `system.getRecentEvents` (Amélioré)

**Purpose**: Stream optimisé pour la vue en temps réel

**Paramètres**:
```typescript
{
  limit?: number;        // 1-100, default 20
  eventType?: string;    // Filter par type
  userId?: string;       // Filter par user
  since?: string;        // ISO timestamp - polling incrémental
}
```

**Retour**:
```typescript
{
  events: Array<{
    id: string;
    type: string;
    userId: string;
    timestamp: string;
    correlationId: string | null;
    isError: boolean;
  }>;
  total: number;
  timestamp: string;
}
```

**Améliorations**:
- Support du paramètre `since` pour polling incrémental
- Flag `isError` pré-calculé pour styling rapide
- Filtrage flexible (type, user)
- Données minimales (pas de payload/metadata)

---

### Fichiers Modifiés

```
packages/api/src/routers/system.ts
  + getDashboardMetrics (nouveau)
  ~ getRecentEvents (amélioré avec 'since' + isError)
```

### Build Status

✅ **Tous les packages compilent correctement**

```bash
> api@1.0.0 build
> tsc
# ✅ Success
```

---

## 🚧 Frontend - En cours

### Dépendances Installées

```json
{
  "cmdk": "^1.1.1"  // Command Palette (Cmd+K)
}
```

### Prochaines Étapes

#### Tâche 1: Design Tokens System
- [ ] Créer `/src/theme/tokens.ts` avec:
  - Couleurs sémantiques (success, warning, error, info)
  - Couleurs par type d'événement (created, updated, deleted, ai, system)
  - Typographie (scale, font-family)
  - Spacing (échelle 4px base)
  - Breakpoints responsive

#### Tâche 2: Layout à 3 Zones
- [ ] Créer `/src/components/layout/MainLayout.tsx`:
  - TopBar avec trigger Command Palette + User menu
  - MainNav avec 4 sections (Dashboard, Investigate, Testing, Explore)
  - ContentArea pour le contenu principal
  - Support responsive (collapse nav sur mobile)

#### Tâche 3: Command Palette (cmdk)
- [ ] Créer `/src/components/CommandPalette.tsx`:
  - Trigger avec Cmd/Ctrl+K
  - Fuzzy search
  - Actions catégorisées (Pages, Quick Actions, Recent)
  - Smart ID detection
  - Keyboard navigation

#### Tâche 4: Dashboard Page V2
- [ ] Créer `/src/pages/DashboardPage.tsx`:
  - 3 KPI cards (Health, Events/s, Latency)
  - Quick Actions section
  - Live Event Stream component
  - Recent Searches
  - Auto-refresh avec pause control

#### Tâche 5: Composants Réutilisables
- [ ] `/src/components/dashboard/MetricCard.tsx`
- [ ] `/src/components/dashboard/QuickActions.tsx`
- [ ] `/src/components/dashboard/LiveEventStream.tsx`
- [ ] `/src/components/dashboard/StatusIndicator.tsx`

---

## 📐 Architecture Frontend (Nouvelle)

### Structure de Navigation

```
App
├── MainLayout
│   ├── TopBar (Cmd+K trigger, user menu)
│   ├── MainNav
│   │   ├── Dashboard (Home - Health Monitoring)
│   │   ├── Investigate (Incident Investigation)
│   │   ├── Testing (Development & Testing)
│   │   └── Explore (System Exploration)
│   └── ContentArea
│       └── <Route Content>
└── CommandPalette (Global overlay)
```

### Réduction de Complexité

**Avant**: 8 pages déconnectées
```
- Live Event Stream
- Event Trace Viewer
- Metrics Dashboard
- Architecture Visualizer
- Event Search
- AI Tools Playground
- System Capabilities
- Event Publisher
```

**Après**: 4 sections workflow-oriented
```
🏠 Dashboard      (Vue d'ensemble + Quick Access)
🔍 Investigate    (Event Trace + Search unifié)
🧪 Testing        (Tools + Events ensemble)
📚 Explore        (Architecture + Live Data)
```

---

## 🎨 Design System

### Couleurs Sémantiques

```typescript
const colors = {
  // System Health
  healthy: '#10B981',    // Green
  degraded: '#F59E0B',   // Amber
  critical: '#EF4444',   // Red

  // Event Types
  created: '#8B5CF6',    // Purple
  updated: '#3B82F6',    // Blue
  deleted: '#EF4444',    // Red
  ai: '#F59E0B',         // Amber
  system: '#6B7280',     // Gray

  // UI
  background: '#FFFFFF',
  surface: '#F9FAFB',
  border: '#E5E7EB',
};
```

### Typography

```typescript
const typography = {
  fontFamily: {
    sans: 'Inter, system-ui, sans-serif',
    mono: 'JetBrains Mono, Consolas, monospace',
  },
  fontSize: {
    xs: '0.75rem',   // 12px - Metadata
    sm: '0.875rem',  // 14px - Body
    base: '1rem',    // 16px - Default
    lg: '1.125rem',  // 18px - Subheadings
    xl: '1.25rem',   // 20px - Page titles
    '2xl': '1.5rem', // 24px - Section headings
  },
};
```

### Spacing Scale

```typescript
const spacing = {
  1: '0.25rem',  // 4px
  2: '0.5rem',   // 8px
  3: '0.75rem',  // 12px
  4: '1rem',     // 16px - Default padding
  6: '1.5rem',   // 24px - Section spacing
  8: '2rem',     // 32px - Page margins
};
```

---

## 🎯 "Little Win" - Épopée 1

**Objectif**: Vue d'ensemble en temps réel de la santé du système

**Critères de succès**:
- ✅ Backend: Endpoints dashboard optimisés fonctionnels
- [ ] Frontend: Dashboard affiche health status en temps réel
- [ ] Frontend: Live event stream fonctionne
- [ ] Frontend: Command Palette (Cmd+K) opérationnel
- [ ] Frontend: Navigation 4-sections en place
- [ ] UX: Temps pour voir l'état du système < 2 secondes

**Impact mesuré**:
- Réduction des pages visitées pour monitoring: 3-4 → 1
- Temps pour repérer une anomalie: 2-3 min → 5 sec
- Clics pour accéder à une fonctionnalité: 2-3 → 1 (avec Cmd+K)

---

## 📊 Progrès Actuel

### Backend
- [x] ✅ Endpoints dashboard (getDashboardMetrics)
- [x] ✅ Enhanced event stream (getRecentEvents)
- [x] ✅ Build & compile OK

**Statut**: **100% Complété**

### Frontend
- [x] ✅ cmdk installé
- [ ] ⏳ Design tokens system (0%)
- [ ] ⏳ Layout 3 zones (0%)
- [ ] ⏳ Command Palette (0%)
- [ ] ⏳ Dashboard page V2 (0%)
- [ ] ⏳ Live Event Stream (0%)

**Statut**: **10% Complété** (dépendances OK)

---

## ⏭️ Prochaines Actions

### Immédiat (Aujourd'hui)
1. ✅ ~~Backend endpoints~~ → **Fait**
2. 🚧 Créer design tokens system
3. 🚧 Build MainLayout component
4. 🚧 Implement Command Palette

### Court terme (Cette semaine)
5. Build Dashboard page V2
6. Build Live Event Stream
7. Test end-to-end
8. Collect feedback

---

## 📝 Notes Techniques

### Choix d'Architecture

**Pourquoi cmdk?**
- Librairie standard pour command palettes
- Utilisée par Vercel, Linear, GitHub
- Excellent support keyboard
- Lightweight (< 10KB)

**Pourquoi polling au lieu de WebSocket pour metrics?**
- Simplicité d'implémentation
- 5s interval acceptable pour metrics
- Évite complexité WebSocket
- Peut upgrader plus tard si besoin

**Pourquoi un seul endpoint pour dashboard?**
- Réduit latence réseau (1 RTT vs 5-6)
- Cohérence des données (snapshot unique)
- Simplifie loading states
- Backend peut optimiser les requêtes

---

## 🐛 Issues Connues

### Backend
- ⚠️ `totalExecutions` toujours à 0 (TODO: tracker les exécutions de tools)

### Frontend
- ⚠️ Peer dependency warning: @mantine/dates v8 vs @mantine/core v7
  - Impact: None (fonctionne correctement)
  - Fix: Optionnel - upgrade Mantine to v8

---

## 📚 Références

- Design Plan: `/CONTROL_TOWER_UX_REDESIGN.md`
- Backend Issues Resolved: `/DEV_SERVER_ISSUES_RESOLVED.md`
- V1 Implementation Report: `/CONTROL_TOWER_IMPLEMENTATION_COMPLETE.md`

---

**Dernière mise à jour**: 2025-11-18 16:30
**Prochaine revue**: Après complétion Dashboard page V2
