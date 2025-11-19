# Épopée 1 - Étape 1: Design Tokens & Layout
## 📋 Prêt pour Revue & Approbation

**Date**: 2025-11-18
**Statut**: ✅ Implémenté, en attente d'approbation
**Build Status**: ✅ Successful (742KB, -60% vs V1)

---

## 🎨 Design Tokens Implémentés

### 1. Couleurs

#### Couleurs Sémantiques (Status du Système)

```typescript
Success:  #10B981  ● Opérations réussies, statut healthy
Warning:  #F59E0B  ● Avertissements, statut degraded
Error:    #EF4444  ● Erreurs, statut critical
Info:     #3B82F6  ● Informations générales
```

**Rationale**: Couleurs standard industry (vert=bon, rouge=mauvais, ambre=attention)

---

#### Couleurs par Type d'Événement

```typescript
Created:  #8B5CF6  ● Événements de création (Purple)
Updated:  #3B82F6  ● Événements de mise à jour (Blue)
Deleted:  #EF4444  ● Événements de suppression (Red)
AI:       #F59E0B  ● Événements liés à l'IA (Amber)
System:   #6B7280  ● Événements système (Gray)
```

**Rationale**: Couleurs distinctes pour reconnaissance visuelle rapide dans le stream

---

#### Couleurs de Fond

```typescript
Primary:    #FFFFFF  ● Fond principal (blanc)
Secondary:  #F9FAFB  ● Fond secondaire (gray-50)
Elevated:   #FFFFFF  ● Surfaces élevées + ombre
Hover:      #F3F4F6  ● État hover (gray-100)
Active:     #E5E7EB  ● État active (gray-200)
```

**Rationale**: Hiérarchie claire avec contraste subtil, accessible WCAG AA

---

#### Couleurs de Bordure

```typescript
Light:      #F3F4F6  ● Bordures subtiles
Default:    #E5E7EB  ● Bordures par défaut
Strong:     #D1D5DB  ● Bordures fortes
Interactive:#3B82F6  ● Éléments interactifs
```

---

#### Couleurs de Texte

```typescript
Primary:    #111827  ● Texte principal (gray-900)
Secondary:  #6B7280  ● Texte secondaire (gray-500)
Tertiary:   #9CA3AF  ● Texte tertiaire (gray-400)
Disabled:   #D1D5DB  ● Texte désactivé (gray-300)
Inverse:    #FFFFFF  ● Texte sur fond sombre
```

**Rationale**: Ratio de contraste WCAG AA (4.5:1 minimum)

---

### 2. Typographie

#### Fonts

```typescript
Sans:  Inter, system-ui, sans-serif
      → Highly legible, modern, professional

Mono:  JetBrains Mono, Consolas, monospace
      → Clear character distinction for IDs/code
```

**Rationale**:
- **Inter**: Excellente lisibilité même à petites tailles (métadonnées, logs)
- **JetBrains Mono**: Distinction claire 0/O, 1/I/l pour IDs techniques

---

#### Scale de Tailles

```typescript
xs:   12px  → Metadata, timestamps, badges
sm:   14px  → Body text, secondary content
base: 16px  → Default body text
lg:   18px  → Subheadings
xl:   20px  → Page titles
2xl:  24px  → Section headings
3xl:  30px  → Large headings
```

**Rationale**: Échelle modulaire (ratio ~1.125) pour hiérarchie cohérente

---

#### Weights

```typescript
Normal:    400  → Body text
Medium:    500  → Emphasis
Semibold:  600  → Subheadings
Bold:      700  → Headings
```

---

### 3. Spacing

**Base Unit: 4px** (cohérence visuelle)

```typescript
1:  4px   → Espacement minimal
2:  8px   → Espacement tight
3:  12px  → Espacement between elements
4:  16px  → Default padding (components)
6:  24px  → Section spacing
8:  32px  → Page margins
12: 48px  → Major sections
16: 64px  → Page padding
```

**Rationale**: Multiples de 4 pour alignement pixel-perfect

---

### 4. Border Radius

```typescript
sm:   2px   → Subtle rounding
base: 4px   → Default
md:   6px   → Medium
lg:   8px   → Cards, panels
xl:   12px  → Large elements
full: 9999px → Pills, badges
```

---

### 5. Shadows

```typescript
sm:   Subtle lift
base: Standard depth
md:   Moderate elevation
lg:   Strong elevation
xl:   Maximum depth
```

**Rationale**: Hiérarchie de profondeur pour progressive disclosure

---

### 6. Layout Dimensions

```typescript
TopBar Height:      60px
MainNav Width:      250px
MainNav Collapsed:  60px
Content Max Width:  1400px
Sidebar Width:      320px
```

**Rationale**:
- TopBar 60px = standard pour desktop apps
- Nav 250px = assez large pour labels complets
- Content 1400px = optimal reading width

---

## 🏗️ Architecture du Layout

### Structure à 3 Zones

```
┌─────────────────────────────────────────────┐
│  TopBar (60px height)                       │
│  ┌────────┐ Synap Control Tower V2   🔍 👤 │
├─────────────────────────────────────────────┤
│         │                                   │
│ MainNav │  ContentArea                      │
│ (250px) │                                   │
│         │  <Outlet />                       │
│ 🏠 Dash │  (pages render here)              │
│ 🔍 Inv  │                                   │
│ 🧪 Test │                                   │
│ 📚 Expl │                                   │
│         │                                   │
│ Legacy  │                                   │
│ • Cap   │                                   │
│ • Pub   │                                   │
│         │                                   │
└─────────┴───────────────────────────────────┘
```

---

### TopBar

**Éléments**:
- ✅ Logo + "Synap Control Tower" + Badge "V2"
- ✅ Search icon (trigger Command Palette)
- ✅ User icon (menu placeholder)

**Style**:
- Fond blanc, bordure grise
- Sticky (reste visible au scroll)
- Height 60px

---

### MainNav

**Sections**:

**Primary (4 workflow sections)**:
- 🏠 **Dashboard** - Health Monitoring
- 🔍 **Investigate** - Incident Investigation
- 🧪 **Testing** - Development & Testing
- 📚 **Explore** - System Exploration

**Legacy (anciennes pages)**:
- System Capabilities
- Event Publisher

**Style**:
- Active state highlighted (blue background)
- Icons + labels + descriptions
- Divider entre primary et legacy
- Label "LEGACY" en petites majuscules grises

---

### ContentArea

**Caractéristiques**:
- Padding 32px (spacing[8])
- Background gray-50
- Max-width none (full utilization)
- Utilise React Router `<Outlet />`

---

## 📱 Pages Placeholder Créées

### 1. Dashboard (/)

```
┌──────────────────────────────────────┐
│ Dashboard                            │
│ Health Monitoring & Quick Access     │
├──────────────────────────────────────┤
│ ℹ️ Coming Soon                       │
│ • Cartes métriques temps réel        │
│ • Quick Actions                      │
│ • Live Event Stream                  │
│ • Auto-refresh                       │
├──────────────────────────────────────┤
│        🏠                            │
│   Dashboard Placeholder              │
│   En attente validation design       │
└──────────────────────────────────────┘
```

---

### 2. Investigate (/investigate)

```
┌──────────────────────────────────────┐
│ Investigate                          │
│ Incident Investigation & Tracing     │
├──────────────────────────────────────┤
│ ℹ️ Coming in Épopée 2                │
│ • Event Trace Viewer                 │
│ • Advanced Search                    │
│ • Details sidebar                    │
│ • Related events nav                 │
├──────────────────────────────────────┤
│        🔍                            │
│   Investigate Placeholder            │
└──────────────────────────────────────┘
```

---

### 3. Testing (/testing)

```
┌──────────────────────────────────────┐
│ Testing                              │
│ Development & Testing Tools          │
├──────────────────────────────────────┤
│ ℹ️ Coming in Épopée 2                │
│ • AI Tools Playground                │
│ • Event Publisher                    │
│ • Execution history                  │
│ • Link to published events           │
├──────────────────────────────────────┤
│        🧪                            │
│   Testing Placeholder                │
└──────────────────────────────────────┘
```

---

### 4. Explore (/explore)

```
┌──────────────────────────────────────┐
│ Explore                              │
│ System Exploration & Architecture    │
├──────────────────────────────────────┤
│ ℹ️ Coming in Épopée 3                │
│ • Interactive architecture           │
│ • Real-time statistics               │
│ • Example events                     │
│ • Quick actions                      │
├──────────────────────────────────────┤
│        📚                            │
│   Explore Placeholder                │
└──────────────────────────────────────┘
```

---

## ⌨️ Command Palette (Placeholder)

**Status**: Trigger fonctionnel, UI placeholder

**Fonctionnalités**:
- ✅ Trigger avec **Cmd/Ctrl + K** (global)
- ✅ Overlay avec backdrop blur
- ✅ Modal centré
- ⏳ Recherche fuzzy (à implémenter)
- ⏳ Actions catégorisées (à implémenter)
- ⏳ Recent items (à implémenter)

**UI Actuelle**:
```
┌─────────────────────────────┐
│  Command Palette            │
│  (Will be implemented       │
│   in next step)             │
│                             │
│  [ Close (Esc) ]            │
└─────────────────────────────┘
```

---

## 📊 Métriques de Performance

### Bundle Size

**Avant** (V1):
```
index.js: 1,817 KB (532 KB gzipped)
```

**Après** (V2):
```
index.js: 743 KB (215 KB gzipped)
```

**Réduction**: -60% (-1,074 KB)

**Raison**: Suppression des pages V1 non utilisées du bundle initial

---

### Build Time

```
✅ Build successful: 22.3s
✅ TypeScript compilation: 0 errors
✅ 6,824 modules transformed
```

---

## 📁 Fichiers Créés

### Theme System

```
src/theme/
  └── tokens.ts (270 lines)
      ✓ Colors (semantic, health, events, backgrounds, borders, text)
      ✓ Typography (fonts, sizes, weights, line heights)
      ✓ Spacing (4px base scale)
      ✓ Border radius, shadows, z-index
      ✓ Breakpoints, transitions
      ✓ Layout dimensions
      ✓ Helper functions (withOpacity)
      ✓ TypeScript types
```

---

### Layout Components

```
src/components/layout/
  ├── TopBar.tsx (70 lines)
  │   ✓ Logo + title + V2 badge
  │   ✓ Command Palette trigger
  │   ✓ User menu placeholder
  │
  ├── MainNav.tsx (110 lines)
  │   ✓ 4 primary sections avec icons
  │   ✓ Descriptions sous labels
  │   ✓ Active state highlighting
  │   ✓ Legacy section séparée
  │
  └── MainLayout.tsx (95 lines)
      ✓ TopBar + MainNav + ContentArea
      ✓ Command Palette overlay (placeholder)
      ✓ Cmd/Ctrl+K shortcut handler
      ✓ React Router <Outlet />
```

---

### V2 Pages (Placeholders)

```
src/pages/v2/
  ├── DashboardPage.tsx
  ├── InvestigatePage.tsx
  ├── TestingPage.tsx
  └── ExplorePage.tsx
```

Chaque page:
- ✓ Titre + description
- ✓ Alert "Coming Soon" avec feature list
- ✓ Placeholder visuel avec emoji
- ✓ Utilise design tokens

---

### App Router

```
src/App.tsx (35 lines)
  ✓ Routes avec MainLayout wrapper
  ✓ V2 routes: /, /investigate, /testing, /explore
  ✓ Legacy routes: /capabilities, /publish
  ✓ Clean structure avec <Outlet />
```

---

## 🎯 Questions pour Approbation

Avant de continuer vers **Étape 2 (Command Palette)**, j'ai besoin de ton feedback sur :

### 1. **Couleurs**

**Approuves-tu le choix de couleurs ?**
- ✅ Sémantiques: Green (success), Amber (warning), Red (error), Blue (info)
- ✅ Event types: Purple (created), Blue (updated), Red (deleted), Amber (AI), Gray (system)
- ✅ Backgrounds: White (primary), Gray-50 (secondary)
- ✅ Text: Gray-900 (primary), Gray-500 (secondary)

**Changements souhaités ?** _______________________

---

### 2. **Typographie**

**Approuves-tu les fonts ?**
- ✅ **Inter** pour l'interface (sans-serif, moderne, lisible)
- ✅ **JetBrains Mono** pour code/IDs (monospace, caractères distincts)

**Scale de tailles OK ?** (12px → 30px)
- ✅ Oui
- ❌ Non → Ajustements : _______________________

---

### 3. **Spacing**

**Base 4px OK ?**
- ✅ Oui (standard industry)
- ❌ Non → Préférence : _______________________

**Spacing[4] = 16px pour padding components OK ?**
- ✅ Oui
- ❌ Non → Préférence : _______________________

---

### 4. **Layout**

**Dimensions OK ?**
- TopBar 60px height: ✅ Oui / ❌ Non → _______
- MainNav 250px width: ✅ Oui / ❌ Non → _______
- Content padding 32px: ✅ Oui / ❌ Non → _______

**Structure 3 zones (TopBar + Nav + Content) OK ?**
- ✅ Oui
- ❌ Non → Suggestions : _______________________

---

### 5. **Navigation**

**4 sections primaires OK ?**
- 🏠 Dashboard (Health Monitoring)
- 🔍 Investigate (Incident Investigation)
- 🧪 Testing (Development & Testing)
- 📚 Explore (System Exploration)

**Changements ?** _______________________

**Labels OK ou à modifier ?**
- Dashboard → _______________________
- Investigate → _______________________
- Testing → _______________________
- Explore → _______________________

---

### 6. **Overall Feel**

**L'apparence générale te convient ?**
- Professional: ✅ / ❌
- Clean: ✅ / ❌
- Modern: ✅ / ❌
- Easy to scan: ✅ / ❌

**Commentaires généraux**: _______________________

---

## ⏭️ Prochaine Étape

**Après ton approbation**, je procède à :

**Étape 2: Command Palette** (1 heure)
- Implémentation complète avec cmdk
- Fuzzy search
- Actions catégorisées
- Keyboard navigation
- Smart ID detection

**Ensuite**: Dashboard Page V2 (2 heures)

---

## 🚀 Comment Tester

```bash
# Start dev server
pnpm dev

# Visit
http://localhost:5173

# Navigation
- Click 🏠 Dashboard → Voir placeholder
- Click 🔍 Investigate → Voir placeholder
- Click 🧪 Testing → Voir placeholder
- Click 📚 Explore → Voir placeholder

# Command Palette
- Press Cmd/Ctrl + K → Voir placeholder modal
- Press Esc → Ferme le modal

# Legacy pages
- Click "System Capabilities" → Fonctionne (V1)
- Click "Event Publisher" → Fonctionne (V1)
```

---

**Attente de ton retour avant de continuer !** 🎨
