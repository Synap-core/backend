# Synap Control Tower - Admin UI

> **Version 2.0** - Internal Admin Tool for Synap System Management

The Synap Control Tower is a powerful, user-friendly admin interface for managing, monitoring, and debugging the Synap event-driven system. Built with React, TypeScript, Hero UI, Tailwind CSS, and tRPC.

## 🎯 Overview

The Control Tower provides a comprehensive view of your Synap system, allowing you to:

- **Monitor** system health and metrics in real-time
- **Investigate** events and trace user journeys
- **Test** AI tools and publish events
- **Explore** system architecture and capabilities

## ✨ Key Features

### 🚀 Smart Forms

- **Dynamic Form Generation**: Automatically generates forms from event type schemas
- **No JSON Required**: Fill forms instead of writing JSON manually
- **Real-time Validation**: Get instant feedback on your inputs
- **Template System**: Quick-start templates for common events

### 🔍 Powerful Search

- **Unified Search Interface**: Professional search modal with history
- **Event Tracing**: Follow event chains and correlations
- **User Investigation**: Search all events for a specific user
- **Search History**: Access your recent searches instantly

### ⚡ Contextual Actions

- **Right-Click Menus**: Quick actions on every event
- **Smart Navigation**: Seamlessly move between related views
- **Publish Similar**: Clone and modify events with one click
- **Copy & Share**: Copy event IDs and URLs easily

### 🎨 Professional UX

- **Responsive Design**: Works on desktop, tablet, and mobile
- **Command Palette**: Quick access to all features (⌘K / Ctrl+K)
- **Toast Notifications**: Instant feedback for all actions
- **Loading States**: Visual feedback during data fetching
- **Error Handling**: Graceful error boundaries and recovery

## 📋 Table of Contents

- [Getting Started](#getting-started)
- [User Guide](#user-guide)
- [Architecture](#architecture)
- [Development](#development)
- [Features Deep Dive](#features-deep-dive)

## 🚀 Getting Started

### Prerequisites

- Node.js 20.19+ or 22.12+
- pnpm (recommended) or npm
- Access to Synap backend API

### Installation

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview
```

The application will be available at `http://localhost:5173`

### Environment Variables

Create a `.env` file in the `apps/admin-ui` directory:

```env
VITE_API_URL=http://localhost:3000
```

## 📖 User Guide

### Dashboard

The **Dashboard** is your home base. It provides:

- **System Health Metrics**: Real-time status of your system
- **Quick Actions**: Fast access to common tasks
- **Live Event Stream**: See events as they happen

**Quick Actions:**

- **Investigate User**: Search all events for a specific user
- **View Event Trace**: Follow an event's correlation chain
- **Test AI Tool**: Open the AI Tools Playground
- **View Architecture**: Explore system architecture

### Investigate

The **Investigate** page helps you debug and trace events:

1. **Search Events**: Enter a user ID, event ID, or search term
2. **Filter by Type**: Narrow down by event type
3. **View Details**: Click any event to see full details
4. **Trace Correlations**: See related events in the timeline

**Contextual Actions** (right-click or "..." menu):

- **Inspect in Detail**: Navigate to full event details
- **View Full Trace**: See all correlated events
- **Publish Similar Event**: Clone this event for testing
- **Copy Event ID**: Copy to clipboard

### Testing

The **Testing** page has two main tools:

#### AI Tools Playground

1. **Select a Tool**: Choose from available AI tools
2. **Fill Parameters**: Use the smart form (no JSON needed!)
3. **Execute**: Run the tool and see results
4. **View History**: See all your tool executions

#### Event Publisher

1. **Choose Template** (optional): Start with a pre-filled template
2. **Select Event Type**: Choose the event type
3. **Fill Form**: Use the dynamic form or switch to JSON view
4. **Publish**: Send the event to the system

**Templates Available:**

- Note Creation
- Task Creation
- Project Creation

### Explore

The **Explore** page shows your system architecture:

- **Architecture Components**: Visual overview of system parts
- **Tool Registry**: All available AI tools
- **Recent Events**: Examples of recent system activity

### Command Palette

Press **⌘K** (Mac) or **Ctrl+K** (Windows/Linux) to open the Command Palette.

**Available Commands:**

- Navigate to any page
- Quick actions (refresh, copy URL, etc.)
- Search for features by name

## 🏗️ Architecture

### Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **Hero UI** - Component library (React Aria)
- **Tailwind CSS** - Styling
- **tRPC** - Type-safe API client
- **React Router** - Navigation
- **TanStack Query** - Data fetching
- **TanStack Virtual** - List virtualization
- **cmdk** - Command palette

### Project Structure

```
apps/admin-ui/
├── src/
│   ├── components/
│   │   ├── architecture/     # Architecture visualization
│   │   ├── error/            # Error boundaries
│   │   ├── events/           # Event-related components
│   │   ├── forms/            # Dynamic form generators
│   │   ├── layout/           # Layout components
│   │   ├── loading/          # Loading skeletons
│   │   ├── search/           # Search components
│   │   └── trace/            # Event tracing
│   ├── lib/
│   │   ├── notifications.tsx # Toast notifications
│   │   └── trpc.ts          # tRPC client setup
│   ├── pages/
│   │   ├── (v2)/            # V2 pages (main app)
│   │   └── ...              # Legacy pages
│   ├── theme/
│   │   └── tokens.ts        # Design tokens
│   └── types/
│       └── index.ts         # TypeScript types
├── README.md
└── package.json
```

### Key Components

#### Dynamic Form Generators

- **`SchemaFormGenerator`**: Converts Zod schemas to Hero UI / native form controls
- **`ToolFormGenerator`**: Generates forms for AI tool parameters
- **`EventTemplates`**: Pre-filled event templates

#### Event Components

- **`VirtualizedEventList`**: Efficient rendering of large event lists
- **`EventContextMenu`**: Right-click menu for events
- **`EventCard`**: Detailed event display

#### Search Components

- **`SearchModal`**: Unified search interface with history
- **`SearchFilters`**: Advanced filtering options

## 🔧 Development

### Adding a New Event Type

1. Add the event type schema in `packages/types/src/synap-event.ts`:

```typescript
export const EventTypeSchemas = {
  "my.new.event": z.object({
    field1: z.string(),
    field2: z.number().optional(),
  }),
} as const;
```

2. The form will automatically appear in Event Publisher!

### Adding a New Page

1. Create a new file in `src/pages/(v2)/`:

```typescript
export default function MyNewPage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">My New Page</h1>
    </div>
  );
}
```

2. Add route in `src/App.tsx`:

```typescript
<Route path="/my-page" element={<MyNewPage />} />
```

3. Add to navigation in `src/components/layout/MainNav.tsx`

### Adding Notifications

```typescript
import {
  showSuccessNotification,
  showErrorNotification,
} from "../lib/notifications";

// Success
showSuccessNotification({
  message: "Operation completed successfully",
  title: "Success",
});

// Error
showErrorNotification({
  message: "Something went wrong",
  title: "Error",
});
```

### Type Safety

The application is fully type-safe:

- ✅ No `@ts-ignore` or `@ts-expect-error`
- ✅ No `any` types (except where necessary)
- ✅ Full tRPC type inference
- ✅ Type-safe event schemas

## 🎨 Features Deep Dive

### Smart Forms

The dynamic form system automatically generates forms from Zod schemas:

**Supported Field Types:**

- `string` → TextInput or Textarea
- `number` → NumberInput
- `boolean` → Switch
- `enum` → Select
- `array` → Dynamic array with add/remove

**Features:**

- Required field indicators
- Real-time validation
- Default values
- Field descriptions

### Search System

The search modal provides:

- **History**: Last 10 searches per type
- **Presets**: Saved search configurations
- **Autocomplete**: Smart suggestions
- **Quick Filters**: Common time ranges

### Contextual Actions

Every event has a context menu with:

- **Inspect**: View full event details
- **Trace**: Follow correlation chain
- **Publish Similar**: Clone event
- **Copy ID**: Quick copy to clipboard

### Responsive Design

- **Desktop**: Full sidebar navigation
- **Tablet**: Collapsible sidebar
- **Mobile**: Drawer navigation

Breakpoints:

- Mobile: < 768px
- Tablet: 768px - 1024px
- Desktop: > 1024px

## 🐛 Troubleshooting

### Build Errors

**Error: "Expected '>' but found 'size'"**

- Make sure files with JSX have `.tsx` extension
- Check that React is imported in files using JSX

**Error: "Cannot find module '@synap/types'"**

- Run `pnpm install` from the monorepo root
- Ensure all packages are built

### Runtime Errors

**Events not loading:**

- Check API URL in `.env`
- Verify backend is running
- Check browser console for errors

**Forms not appearing:**

- Ensure event type has a schema in `EventTypeSchemas`
- Check browser console for schema fetch errors

## 📚 Additional Resources

- [UX Deep Dive Report](./UX_DEEP_DIVE_REPORT.md) - Comprehensive UX analysis
- [Enhancement Report](./ENHANCEMENT_REPORT.md) - Initial enhancement suggestions
- [Backend SDK Reference](../../docs/BACKEND_SDK_REFERENCE.md) - Backend API documentation

## 🤝 Contributing

When adding new features:

1. **Follow Type Safety**: No `any`, no `@ts-ignore`
2. **Add Loading States**: Use Skeleton components
3. **Add Notifications**: Provide user feedback
4. **Make it Responsive**: Test on mobile/tablet
5. **Add Accessibility**: Use `aria-label` on icon buttons

## 📝 License

Internal tool - Synap project

---

**Built with ❤️ for the Synap team**
