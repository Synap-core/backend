# Developer Guide - Synap Control Tower

Technical documentation for developers working on the Control Tower.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Key Concepts](#key-concepts)
4. [Adding Features](#adding-features)
5. [Best Practices](#best-practices)
6. [Testing](#testing)
7. [Performance](#performance)

## Architecture Overview

### Tech Stack

```
React 18 + TypeScript
├── Mantine UI (Component Library)
├── tRPC (Type-safe API Client)
├── React Router (Navigation)
├── TanStack Query (Data Fetching)
├── TanStack Virtual (List Virtualization)
└── cmdk (Command Palette)
```

### Design Principles

1. **Type Safety First**: No `any`, no `@ts-ignore`
2. **User Experience**: Smart defaults, contextual actions
3. **Performance**: Virtualization, lazy loading, memoization
4. **Accessibility**: ARIA labels, keyboard navigation
5. **Responsive**: Mobile-first, adaptive layouts

## Project Structure

```
apps/admin-ui/
├── src/
│   ├── components/          # Reusable components
│   │   ├── architecture/   # Architecture visualization
│   │   ├── error/          # Error boundaries
│   │   ├── events/         # Event components
│   │   ├── forms/          # Form generators
│   │   ├── layout/         # Layout components
│   │   ├── loading/        # Loading states
│   │   ├── search/         # Search components
│   │   └── trace/          # Event tracing
│   ├── lib/                # Utilities
│   │   ├── notifications.tsx
│   │   └── trpc.ts
│   ├── pages/              # Page components
│   │   ├── (v2)/          # V2 pages (main)
│   │   └── ...            # Legacy pages
│   ├── theme/              # Design system
│   │   └── tokens.ts
│   └── types/             # TypeScript types
│       └── index.ts
├── README.md
├── USER_GUIDE.md
└── DEVELOPER_GUIDE.md
```

## Key Concepts

### Dynamic Form Generation

Forms are generated from Zod schemas:

```typescript
// Backend: packages/types/src/synap-event.ts
export const EventTypeSchemas = {
  'note.creation.requested': z.object({
    content: z.string().min(1),
    title: z.string().optional(),
  }),
};

// Frontend: Automatically generates form
<SchemaFormGenerator
  eventType="note.creation.requested"
  value={formData}
  onChange={setFormData}
/>
```

**How it works:**

1. Frontend calls `system.getEventTypeSchema`
2. Backend extracts Zod schema structure
3. Frontend maps Zod types to Mantine components
4. Form renders with validation

### tRPC Integration

All API calls use tRPC for type safety:

```typescript
// Query
const { data, isLoading } = trpc.system.getCapabilities.useQuery();

// Mutation
const mutation = trpc.system.publishEvent.useMutation({
  onSuccess: (data) => {
    showSuccessNotification({ message: "Published!" });
  },
});
```

### State Management

- **Local State**: `useState` for component state
- **Server State**: TanStack Query (via tRPC)
- **Persistent State**: `localStorage` for preferences
- **URL State**: React Router for navigation state

### Component Patterns

#### Memoization

Heavy components are memoized:

```typescript
export default memo(EventCard);
```

#### Lazy Loading

Heavy dependencies are lazy-loaded:

```typescript
const Editor = lazy(() => import('@monaco-editor/react'));

<Suspense fallback={<Skeleton />}>
  <Editor />
</Suspense>
```

#### Virtualization

Long lists are virtualized:

```typescript
const virtualizer = useVirtualizer({
  count: events.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 60,
});
```

## Adding Features

### Adding a New Page

1. **Create Page Component**

```typescript
// src/pages/(v2)/MyNewPage.tsx
import { Title, Text } from '@mantine/core';

export default function MyNewPage() {
  return (
    <div style={{ padding: '2rem' }}>
      <Title>My New Page</Title>
      <Text>Page content here</Text>
    </div>
  );
}
```

2. **Add Route**

```typescript
// src/App.tsx
import MyNewPage from './pages/(v2)/MyNewPage';

<Route path="/my-page" element={<MyNewPage />} />
```

3. **Add Navigation**

```typescript
// src/components/layout/MainNav.tsx
const navItems = [
  // ... existing items
  {
    path: "/my-page",
    label: "My Page",
    icon: IconMyIcon,
    description: "My page description",
  },
];
```

### Adding a New Event Type Schema

1. **Define Schema**

```typescript
// packages/types/src/synap-event.ts
export const EventTypeSchemas = {
  "my.new.event": z.object({
    field1: z.string().min(1),
    field2: z.number().optional(),
    field3: z.enum(["option1", "option2"]).optional(),
  }),
} as const;
```

2. **Form Appears Automatically**

The form generator will automatically:

- Detect the schema
- Generate appropriate fields
- Add validation
- Show required indicators

### Adding a New Tool Form

Tools use a similar pattern:

1. **Tool Schema** (already in backend)
2. **Frontend automatically generates form**

```typescript
<ToolFormGenerator
  toolName="myTool"
  value={params}
  onChange={setParams}
/>
```

### Adding Notifications

```typescript
import {
  showSuccessNotification,
  showErrorNotification,
  showWarningNotification,
  showInfoNotification,
} from "../lib/notifications";

// Success
showSuccessNotification({
  message: "Operation completed",
  title: "Success", // optional
});

// Error
showErrorNotification({
  message: "Something went wrong",
});

// Warning
showWarningNotification({
  message: "Please review",
});

// Info
showInfoNotification({
  message: "Processing...",
});
```

### Adding Contextual Actions

```typescript
// In EventContextMenu.tsx or create new menu
<Menu.Item
  leftSection={<IconMyIcon size={16} />}
  onClick={(e) => {
    e.stopPropagation();
    handleMyAction();
  }}
>
  My Action
</Menu.Item>
```

## Best Practices

### Type Safety

✅ **DO:**

```typescript
interface MyProps {
  eventId: string;
  onSelect: (id: string) => void;
}

function MyComponent({ eventId, onSelect }: MyProps) {
  // ...
}
```

❌ **DON'T:**

```typescript
function MyComponent(props: any) {
  // ...
}
```

### Error Handling

✅ **DO:**

```typescript
const mutation = trpc.system.publishEvent.useMutation({
  onSuccess: (data) => {
    showSuccessNotification({ message: "Success!" });
  },
  onError: (error) => {
    showErrorNotification({ message: error.message });
  },
});
```

### Loading States

✅ **DO:**

```typescript
const { data, isLoading } = trpc.system.getCapabilities.useQuery();

{isLoading ? (
  <Skeleton height={200} />
) : (
  <ActualContent data={data} />
)}
```

### Accessibility

✅ **DO:**

```typescript
<ActionIcon
  aria-label="Refresh data"
  onClick={handleRefresh}
>
  <IconRefresh />
</ActionIcon>
```

### Performance

✅ **DO:**

```typescript
// Memoize heavy components
export default memo(HeavyComponent);

// Lazy load heavy dependencies
const HeavyLib = lazy(() => import('./HeavyLib'));

// Virtualize long lists
const virtualizer = useVirtualizer({ ... });
```

### Responsive Design

✅ **DO:**

```typescript
const isMobile = useMediaQuery(`(max-width: ${breakpoints.tablet})`);

{isMobile ? (
  <MobileLayout />
) : (
  <DesktopLayout />
)}
```

## Testing

### Manual Testing Checklist

- [ ] Test on desktop (1920x1080)
- [ ] Test on tablet (768px)
- [ ] Test on mobile (375px)
- [ ] Test keyboard navigation
- [ ] Test with screen reader
- [ ] Test error scenarios
- [ ] Test loading states
- [ ] Test form validation

### Common Test Scenarios

1. **Publish Event**
   - Select event type with schema
   - Fill form
   - Publish
   - Verify in Live Event Stream

2. **Search Events**
   - Enter user ID
   - View results
   - Click event
   - View details

3. **Test Tool**
   - Select tool
   - Fill parameters
   - Execute
   - Verify output

## Performance

### Optimization Strategies

1. **Virtualization**: Long lists use `@tanstack/react-virtual`
2. **Lazy Loading**: Heavy components loaded on demand
3. **Memoization**: Expensive components memoized
4. **Code Splitting**: Routes loaded on demand
5. **Query Optimization**: Proper `refetchInterval` and caching

### Performance Monitoring

- Use React DevTools Profiler
- Monitor bundle size
- Check network requests
- Verify virtualization works

### Known Performance Characteristics

- **Event Lists**: Virtualized, handles 1000+ events smoothly
- **Form Generation**: Instant for schemas with < 20 fields
- **Search**: Debounced, efficient filtering
- **Dashboard**: Auto-refresh every 5s (configurable)

## Code Style

### Naming Conventions

- **Components**: PascalCase (`EventCard.tsx`)
- **Hooks**: camelCase with `use` prefix (`useEventData`)
- **Utilities**: camelCase (`formatDate`)
- **Types**: PascalCase (`EventData`)

### File Organization

- One component per file
- Co-locate related files
- Group by feature, not type

### Imports

```typescript
// External libraries
import { useState } from "react";
import { Button } from "@mantine/core";

// Internal components
import EventCard from "../components/events/EventCard";

// Utilities
import { showSuccessNotification } from "../lib/notifications";

// Types
import type { Event } from "../types";
```

## Debugging

### Common Issues

**Forms not appearing:**

- Check schema exists in `EventTypeSchemas`
- Verify API endpoint returns schema
- Check browser console for errors

**Events not loading:**

- Verify API URL in `.env`
- Check backend is running
- Inspect network tab

**Type errors:**

- Run `pnpm type-check`
- Ensure all imports are correct
- Check tRPC types are up to date

### Debug Tools

- **React DevTools**: Component inspection
- **TanStack Query DevTools**: Query debugging
- **Browser DevTools**: Network, console
- **tRPC DevTools**: API call inspection

## Deployment

### Build Process

```bash
# Build for production
pnpm build

# Output in dist/
```

### Environment Variables

Required:

- `VITE_API_URL`: Backend API URL

Optional:

- Custom configuration

### Build Optimization

- Code splitting enabled
- Tree shaking active
- Minification enabled
- Source maps for production

---

**Questions?** Check the [README](./README.md) or [User Guide](./USER_GUIDE.md).
