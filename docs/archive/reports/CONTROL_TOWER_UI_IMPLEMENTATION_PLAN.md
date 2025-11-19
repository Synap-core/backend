# Synap Control Tower - UI Implementation Plan

**Date**: 2025-01-18
**Status**: READY TO IMPLEMENT
**Backend Completion**: ✅ 100%

---

## Executive Summary

This document provides a comprehensive implementation plan for building all 6 Control Tower UI features. The backend is fully ready with all required APIs, and this plan breaks down each feature into specific components, API integrations, and implementation steps.

### Implementation Timeline

**Total Estimated Effort**: 15-18 days

| Phase | Features | Days | Priority |
|-------|----------|------|----------|
| **Phase 1** | #1 Event Trace Viewer + #3 Metrics Dashboard | 5 | ⭐⭐⭐⭐⭐ |
| **Phase 2** | #2 Event Flow Visualizer + #4 Event Search | 6 | ⭐⭐⭐⭐ |
| **Phase 3** | #6 AI Tools Playground | 3 | ⭐⭐⭐ |
| **Future** | #5 Handler Inspector (V2) | TBD | Complex |

---

## Feature #1: Event Trace Viewer (Visionneuse de Trace) ⭐⭐⭐⭐⭐

### Priority: HIGHEST VALUE - Absolute Priority

**Goal**: Visualize the complete lifecycle of a user action through the event-driven architecture.

### Backend Readiness: ✅ 100%

**Available API**:
```typescript
trpc.system.getTrace.useQuery({ correlationId: string })

// Returns:
{
  correlationId: string;
  events: Array<{
    id: string;
    type: string;
    timestamp: string;
    userId: string;
    aggregateId: string;
    data: object;
    metadata: object;
    causationId?: string;
  }>;
  totalEvents: number;
}
```

### UI Components

#### 1.1 Main Page: `/trace`

**File**: `/apps/admin-ui/src/pages/EventTracePage.tsx`

**Layout**:
```
┌──────────────────────────────────────────────────────────┐
│  Event Trace Viewer                                      │
│  ┌────────────────────────────────────────────┐          │
│  │ Search by Correlation ID or Event ID       │ [Search] │
│  └────────────────────────────────────────────┘          │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Timeline View                                       │ │
│  │                                                     │ │
│  │  ┌─── 12:34:01 ───┐                                │ │
│  │  │ note.creation  │────┐                           │ │
│  │  │  .requested    │    │                           │ │
│  │  └────────────────┘    │                           │ │
│  │                        ▼                           │ │
│  │                   ┌─── 12:34:02 ───┐              │ │
│  │                   │ file.uploaded  │──────┐       │ │
│  │                   └────────────────┘      │       │ │
│  │                                           ▼       │ │
│  │                                     ┌─── 12:34:03 ───┐│
│  │                                     │ note.creation  ││
│  │                                     │  .completed    ││
│  │                                     └────────────────┘│
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Event Details Panel (click on event above)         │ │
│  │ {                                                   │ │
│  │   "type": "note.creation.requested",               │ │
│  │   "data": { "title": "My Note", ... }             │ │
│  │ }                                                   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Components**:

1. **TraceSearchInput** - Search form
   ```tsx
   <TextInput
     placeholder="Enter correlationId or eventId"
     value={searchQuery}
     onChange={(e) => setSearchQuery(e.target.value)}
     rightSection={<IconSearch />}
     onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
   />
   ```

2. **EventTimeline** - Visual timeline of events
   ```tsx
   interface TimelineEvent {
     id: string;
     type: string;
     timestamp: Date;
     causationId?: string;
   }

   function EventTimeline({ events }: { events: TimelineEvent[] }) {
     const sortedEvents = useMemo(() =>
       [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
       [events]
     );

     return (
       <Timeline active={events.length - 1} bulletSize={24} lineWidth={2}>
         {sortedEvents.map((event) => (
           <Timeline.Item
             key={event.id}
             bullet={<IconPoint size={12} />}
             title={event.type}
             onClick={() => handleEventClick(event.id)}
           >
             <Text size="xs" c="dimmed">
               {format(event.timestamp, 'HH:mm:ss.SSS')}
             </Text>
             <Badge variant="light">{event.id.slice(0, 8)}</Badge>
           </Timeline.Item>
         ))}
       </Timeline>
     );
   }
   ```

3. **EventDetailsPanel** - JSON view of selected event
   ```tsx
   import ReactJson from 'react-json-view';

   function EventDetailsPanel({ event }: { event: Event | null }) {
     if (!event) {
       return <Text c="dimmed">Select an event to view details</Text>;
     }

     return (
       <Stack>
         <Group>
           <Badge size="lg">{event.type}</Badge>
           <Text size="sm" c="dimmed">{event.timestamp}</Text>
         </Group>

         <Divider label="Event Data" />
         <ReactJson
           src={event.data}
           theme="monokai"
           displayDataTypes={false}
           collapsed={1}
         />

         {event.metadata && (
           <>
             <Divider label="Metadata" />
             <ReactJson src={event.metadata} theme="monokai" collapsed={2} />
           </>
         )}

         <Divider label="Tracing" />
         <Table>
           <tbody>
             <tr>
               <td>Event ID</td>
               <td><Code>{event.id}</Code></td>
             </tr>
             <tr>
               <td>Causation ID</td>
               <td><Code>{event.causationId || 'N/A'}</Code></td>
             </tr>
             <tr>
               <td>Aggregate ID</td>
               <td><Code>{event.aggregateId}</Code></td>
             </tr>
           </tbody>
         </Table>
       </Stack>
     );
   }
   ```

4. **CausationGraph** (Optional - Advanced) - Visual graph of event relationships
   ```tsx
   import Cytoscape from 'cytoscape';
   import CytoscapeComponent from 'react-cytoscapejs';

   function CausationGraph({ events }: { events: Event[] }) {
     const elements = useMemo(() => {
       const nodes = events.map(event => ({
         data: { id: event.id, label: event.type }
       }));

       const edges = events
         .filter(event => event.causationId)
         .map(event => ({
           data: {
             source: event.causationId,
             target: event.id
           }
         }));

       return [...nodes, ...edges];
     }, [events]);

     return (
       <CytoscapeComponent
         elements={elements}
         style={{ width: '100%', height: '400px' }}
         layout={{ name: 'breadthfirst', directed: true }}
         stylesheet={[
           {
             selector: 'node',
             style: {
               'background-color': '#666',
               'label': 'data(label)',
               'text-valign': 'center',
               'text-halign': 'center',
               'font-size': '10px'
             }
           },
           {
             selector: 'edge',
             style: {
               'width': 2,
               'line-color': '#ccc',
               'target-arrow-color': '#ccc',
               'target-arrow-shape': 'triangle',
               'curve-style': 'bezier'
             }
           }
         ]}
       />
     );
   }
   ```

### Implementation Steps

1. **Day 1**: Create page structure + search input
   - Create `EventTracePage.tsx`
   - Add route in App.tsx: `/trace`
   - Implement search input with validation
   - Wire up `trpc.system.getTrace` query

2. **Day 2**: Build timeline component
   - Install dependencies: `date-fns`, `@mantine/timeline`
   - Create EventTimeline component
   - Add event selection state
   - Style timeline with Mantine theme

3. **Day 3**: Build event details panel
   - Install `react-json-view`
   - Create EventDetailsPanel component
   - Add copy-to-clipboard functionality
   - Add export JSON button

4. **Optional** (Day 4): Causation graph
   - Install `cytoscape`, `react-cytoscapejs`
   - Create CausationGraph component
   - Add toggle to switch between timeline/graph view

### Dependencies

```json
{
  "date-fns": "^3.0.0",
  "react-json-view": "^1.21.3",
  "cytoscape": "^3.28.0",
  "react-cytoscapejs": "^2.0.0"
}
```

### Testing Checklist

- [ ] Search by valid correlationId returns events
- [ ] Search by invalid ID shows error message
- [ ] Timeline renders events in chronological order
- [ ] Click event shows details in panel
- [ ] Event data displays correctly in JSON viewer
- [ ] Causation links are visible in timeline
- [ ] Export button downloads JSON file

---

## Feature #2: Event Flow Architecture Visualizer ⭐⭐⭐⭐

### Priority: Very Powerful - "Living Documentation"

**Goal**: Visualize which handlers are triggered by which events, showing the complete architecture as a graph.

### Backend Readiness: ✅ 100%

**Available API**:
```typescript
trpc.system.getCapabilities.useQuery()

// Returns:
{
  eventTypes: Array<{ type: string; hasSchema: boolean }>;
  handlers: Array<{
    eventType: string;
    handlers: Array<{ name: string; eventType: string }>;
  }>;
  tools: Array<{ name: string; description: string; ... }>;
  routers: Array<{ name: string; description: string; ... }>;
  stats: { totalEventTypes, totalHandlers, totalTools, totalRouters, sseClients };
}
```

### UI Components

#### 2.1 Main Page: `/architecture`

**File**: `/apps/admin-ui/src/pages/ArchitecturePage.tsx`

**Layout**:
```
┌──────────────────────────────────────────────────────────┐
│  Event Flow Architecture                                 │
│  [View: Graph] [Grid]  [Filter: All] [Event Types▼]     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                                                     │ │
│  │   note.creation      ──────►  NoteCreationHandler │ │
│  │   .requested                      │                │ │
│  │                                   ├──► create_note │ │
│  │                                   └──► upload_file │ │
│  │                                                     │ │
│  │   task.creation      ──────►  TaskCreationHandler │ │
│  │   .requested                      │                │ │
│  │                                   └──► create_task │ │
│  │                                                     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  Selected: NoteCreationHandler                           │
│  - Listens to: note.creation.requested                  │
│  - Uses tools: create_note, upload_file                 │
│  - Publishes: note.creation.completed                   │
└──────────────────────────────────────────────────────────┘
```

**Components**:

1. **ArchitectureGraph** - Main graph visualization
   ```tsx
   import CytoscapeComponent from 'react-cytoscapejs';

   function ArchitectureGraph({ data }: { data: Capabilities }) {
     const elements = useMemo(() => {
       const nodes: any[] = [];
       const edges: any[] = [];

       // Create nodes for event types
       data.eventTypes.forEach(et => {
         nodes.push({
           data: {
             id: `event-${et.type}`,
             label: et.type,
             type: 'event',
             shape: 'ellipse'
           }
         });
       });

       // Create nodes for handlers and edges
       data.handlers.forEach(h => {
         h.handlers.forEach(handler => {
           const handlerId = `handler-${handler.name}`;

           // Handler node
           if (!nodes.find(n => n.data.id === handlerId)) {
             nodes.push({
               data: {
                 id: handlerId,
                 label: handler.name,
                 type: 'handler',
                 shape: 'rectangle'
               }
             });
           }

           // Edge from event to handler
           edges.push({
             data: {
               source: `event-${h.eventType}`,
               target: handlerId
             }
           });
         });
       });

       // Add tool nodes (tools used by handlers)
       data.tools.forEach(tool => {
         nodes.push({
           data: {
             id: `tool-${tool.name}`,
             label: tool.name,
             type: 'tool',
             shape: 'diamond'
           }
         });
       });

       return { nodes, edges };
     }, [data]);

     return (
       <CytoscapeComponent
         elements={[...elements.nodes, ...elements.edges]}
         style={{ width: '100%', height: '600px' }}
         layout={{
           name: 'dagre',
           rankDir: 'LR', // Left to right
           nodeSep: 50,
           rankSep: 100
         }}
         stylesheet={[
           {
             selector: 'node[type="event"]',
             style: {
               'background-color': '#4299e1', // Blue for events
               'label': 'data(label)',
               'shape': 'ellipse',
               'width': 120,
               'height': 60,
               'text-valign': 'center',
               'text-halign': 'center',
               'font-size': '10px',
               'text-wrap': 'wrap',
               'text-max-width': 100
             }
           },
           {
             selector: 'node[type="handler"]',
             style: {
               'background-color': '#48bb78', // Green for handlers
               'label': 'data(label)',
               'shape': 'rectangle',
               'width': 140,
               'height': 50
             }
           },
           {
             selector: 'node[type="tool"]',
             style: {
               'background-color': '#ed8936', // Orange for tools
               'label': 'data(label)',
               'shape': 'diamond',
               'width': 100,
               'height': 100
             }
           },
           {
             selector: 'edge',
             style: {
               'width': 2,
               'line-color': '#a0aec0',
               'target-arrow-color': '#a0aec0',
               'target-arrow-shape': 'triangle',
               'curve-style': 'bezier'
             }
           },
           {
             selector: ':selected',
             style: {
               'background-color': '#ed64a6', // Pink when selected
               'line-color': '#ed64a6',
               'target-arrow-color': '#ed64a6',
               'border-width': 3,
               'border-color': '#ed64a6'
             }
           }
         ]}
         cy={(cy) => {
           cy.on('tap', 'node', (evt) => {
             const node = evt.target;
             onNodeSelect(node.data());
           });
         }}
       />
     );
   }
   ```

2. **ArchitectureGrid** - Alternative table view
   ```tsx
   function ArchitectureGrid({ data }: { data: Capabilities }) {
     return (
       <Table striped highlightOnHover>
         <thead>
           <tr>
             <th>Event Type</th>
             <th>Handler</th>
             <th>Tools Used</th>
           </tr>
         </thead>
         <tbody>
           {data.handlers.map(h =>
             h.handlers.map(handler => (
               <tr key={`${h.eventType}-${handler.name}`}>
                 <td>
                   <Badge color="blue">{h.eventType}</Badge>
                 </td>
                 <td>
                   <Text ff="monospace">{handler.name}</Text>
                 </td>
                 <td>
                   {/* Show related tools */}
                   <Group gap="xs">
                     {getToolsForHandler(handler.name, data.tools).map(tool => (
                       <Badge key={tool.name} color="orange" variant="light">
                         {tool.name}
                       </Badge>
                     ))}
                   </Group>
                 </td>
               </tr>
             ))
           )}
         </tbody>
       </Table>
     );
   }
   ```

3. **NodeDetailsPanel** - Show details for selected node
   ```tsx
   function NodeDetailsPanel({ node }: { node: any }) {
     if (!node) {
       return <Text c="dimmed">Click a node to see details</Text>;
     }

     if (node.type === 'handler') {
       return (
         <Card>
           <Title order={4}>{node.label}</Title>
           <Text size="sm" c="dimmed">Event Handler</Text>
           <Divider my="md" />
           <Stack gap="xs">
             <Text size="sm"><strong>Listens to:</strong></Text>
             <Badge>{node.eventType}</Badge>
             <Text size="sm"><strong>Tools used:</strong></Text>
             {/* List tools */}
           </Stack>
         </Card>
       );
     }

     // Similar for event and tool nodes
   }
   ```

### Implementation Steps

1. **Day 1**: Page structure + data fetching
   - Create `ArchitecturePage.tsx`
   - Add route: `/architecture`
   - Fetch capabilities data
   - Create data transformation logic

2. **Day 2**: Build graph visualization
   - Install `cytoscape`, `dagre`
   - Create ArchitectureGraph component
   - Implement node/edge creation logic
   - Style nodes by type (event/handler/tool)

3. **Day 3**: Add interactivity
   - Implement node selection
   - Create NodeDetailsPanel
   - Add zoom/pan controls
   - Add search/filter

4. **Day 4**: Alternative grid view
   - Create ArchitectureGrid component
   - Add view toggle (graph/grid)
   - Add CSV export

### Dependencies

```json
{
  "cytoscape": "^3.28.0",
  "react-cytoscapejs": "^2.0.0",
  "cytoscape-dagre": "^2.5.0"
}
```

### Testing Checklist

- [ ] Graph loads with all nodes
- [ ] Event → Handler connections visible
- [ ] Node click shows details
- [ ] Search filters nodes
- [ ] Grid view shows same data
- [ ] Export works

---

## Feature #3: Real-time Metrics Dashboard ⭐⭐⭐⭐

### Priority: High Value "Quick Win"

**Goal**: Display real-time system health metrics (events/sec, error rate, latency, connections).

### Backend Readiness: ✅ 100%

**Available APIs**:
1. SSE Stream: `/api/events/stream`
2. Prometheus Metrics: `GET /metrics`

### UI Components

#### 3.1 Main Page: `/metrics`

**File**: `/apps/admin-ui/src/pages/MetricsDashboardPage.tsx`

**Layout**:
```
┌──────────────────────────────────────────────────────────┐
│  System Metrics                     Last updated: 12:34  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │Events/sec│ │Error Rate│ │Latency  │ │WebSocket │   │
│  │   12.5   │ │   0.1%   │ │  45ms   │ │    5     │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│                                                           │
│  Event Processing Rate (last 5 min)                     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │     ▃▅▇▃▅▇▅▃▅▇▃▅                                    │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  Top Event Types                                         │
│  note.creation.requested ████████ 45%                   │
│  task.creation.requested ████ 20%                       │
│  file.uploaded ██ 10%                                   │
└──────────────────────────────────────────────────────────┘
```

**Components**:

1. **MetricCard** - Reusable metric display
   ```tsx
   interface MetricCardProps {
     title: string;
     value: string | number;
     icon: React.ReactNode;
     color: string;
     trend?: 'up' | 'down' | 'neutral';
     trendValue?: string;
   }

   function MetricCard({ title, value, icon, color, trend, trendValue }: MetricCardProps) {
     return (
       <Card withBorder padding="lg">
         <Group justify="apart">
           <div>
             <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
               {title}
             </Text>
             <Text size="xl" fw={700} mt="xs">
               {value}
             </Text>
             {trend && (
               <Group gap={4} mt="xs">
                 {trend === 'up' ? <IconArrowUp size={14} color="green" /> : <IconArrowDown size={14} color="red" />}
                 <Text size="xs" c={trend === 'up' ? 'green' : 'red'}>
                   {trendValue}
                 </Text>
               </Group>
             )}
           </div>
           <ThemeIcon color={color} size={50} radius="md">
             {icon}
           </ThemeIcon>
         </Group>
       </Card>
     );
   }
   ```

2. **useRealtimeMetrics** - Custom hook for SSE
   ```tsx
   function useRealtimeMetrics() {
     const [metrics, setMetrics] = useState({
       eventsPerSecond: 0,
       errorRate: 0,
       eventCount: 0,
       lastEventTime: null as Date | null
     });

     useEffect(() => {
       const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
       const eventSource = new EventSource(`${API_URL}/api/events/stream`);

       const eventTimestamps: number[] = [];

       eventSource.onmessage = (event) => {
         const data = JSON.parse(event.data);

         if (data.type === 'connected') return;

         // Track event timestamps for rate calculation
         const now = Date.now();
         eventTimestamps.push(now);

         // Keep only last 60 seconds of timestamps
         const oneMinuteAgo = now - 60000;
         const recentEvents = eventTimestamps.filter(t => t > oneMinuteAgo);

         // Calculate events per second
         const eventsPerSecond = recentEvents.length / 60;

         setMetrics(prev => ({
           ...prev,
           eventsPerSecond: Number(eventsPerSecond.toFixed(2)),
           eventCount: prev.eventCount + 1,
           lastEventTime: new Date(data.timestamp)
         }));
       };

       return () => eventSource.close();
     }, []);

     return metrics;
   }
   ```

3. **EventRateChart** - Line chart of event rate
   ```tsx
   import { LineChart } from '@mantine/charts';

   function EventRateChart() {
     const [dataPoints, setDataPoints] = useState<Array<{ time: string; events: number }>>([]);

     useEffect(() => {
       const interval = setInterval(() => {
         const now = new Date();
         const timeLabel = format(now, 'HH:mm:ss');

         setDataPoints(prev => {
           const newPoints = [...prev, { time: timeLabel, events: Math.random() * 20 }];
           // Keep only last 20 data points
           return newPoints.slice(-20);
         });
       }, 3000);

       return () => clearInterval(interval);
     }, []);

     return (
       <LineChart
         h={300}
         data={dataPoints}
         dataKey="time"
         series={[{ name: 'events', color: 'blue' }]}
         curveType="natural"
       />
     );
   }
   ```

4. **PrometheusMetrics** - Fetch and display Prometheus metrics
   ```tsx
   function usePrometheusMetrics() {
     const [metrics, setMetrics] = useState<any>(null);

     useEffect(() => {
       const fetchMetrics = async () => {
         const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
         const response = await fetch(`${API_URL}/metrics`);
         const text = await response.text();

         // Parse Prometheus text format
         const parsed = parsePrometheusText(text);
         setMetrics(parsed);
       };

       fetchMetrics();
       const interval = setInterval(fetchMetrics, 5000);

       return () => clearInterval(interval);
     }, []);

     return metrics;
   }

   function parsePrometheusText(text: string) {
     const lines = text.split('\n');
     const metrics: Record<string, number> = {};

     lines.forEach(line => {
       if (line.startsWith('#') || !line.trim()) return;

       const [metricLine, value] = line.split(' ');
       const metricName = metricLine.split('{')[0];
       metrics[metricName] = parseFloat(value);
     });

     return metrics;
   }
   ```

### Implementation Steps

1. **Day 1**: Page structure + metric cards
   - Create `MetricsDashboardPage.tsx`
   - Create MetricCard component
   - Add 4 key metrics (events/sec, errors, latency, connections)

2. **Day 2**: Real-time event stream
   - Implement useRealtimeMetrics hook
   - Connect to SSE endpoint
   - Update metrics in real-time

3. **Day 3**: Charts and visualizations
   - Install `@mantine/charts`
   - Create EventRateChart
   - Add top event types bar chart

4. **Optional**: Prometheus metrics integration
   - Fetch `/metrics` endpoint
   - Parse Prometheus format
   - Display additional system metrics

### Dependencies

```json
{
  "@mantine/charts": "^7.5.0",
  "recharts": "^2.10.0",
  "date-fns": "^3.0.0"
}
```

### Testing Checklist

- [ ] SSE connection established
- [ ] Events/sec updates in real-time
- [ ] Charts render correctly
- [ ] No memory leaks (EventSource cleanup)
- [ ] Handles disconnection gracefully

---

## Feature #4: Event Store Advanced Search ⭐⭐⭐

### Priority: Very Useful - "UI for SQL Queries"

**Goal**: Filter and search events by user, type, aggregate, date range with pagination.

### Backend Readiness: ✅ 100%

**Available API**:
```typescript
trpc.system.searchEvents.useQuery({
  userId?: string;
  eventType?: string;
  aggregateType?: string;
  aggregateId?: string;
  correlationId?: string;
  fromDate?: string; // ISO datetime
  toDate?: string;   // ISO datetime
  limit: number;     // default 100
  offset: number;    // default 0
})

// Returns:
{
  events: Array<Event>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
```

### UI Components

#### 4.1 Main Page: `/events`

**File**: `/apps/admin-ui/src/pages/EventSearchPage.tsx`

**Layout**:
```
┌──────────────────────────────────────────────────────────┐
│  Event Store Search                                      │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Filters                                            │ │
│  │ User ID: [_______] Event Type: [__________▼]      │ │
│  │ Aggregate: [______] From: [📅] To: [📅]           │ │
│  │ [Clear] [Search]                                   │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  Results (125 events found)                              │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Timestamp      │ Type              │ User │ Actions │ │
│  ├────────────────┼───────────────────┼──────┼─────────┤ │
│  │ 12:34:01       │ note.creation.req │ u123 │ [View] │ │
│  │ 12:34:02       │ file.uploaded     │ u123 │ [View] │ │
│  └─────────────────────────────────────────────────────┘ │
│  [Previous] Page 1 of 13 [Next]                         │
│  [Export CSV] [Export JSON]                             │
└──────────────────────────────────────────────────────────┘
```

**Components**:

1. **EventSearchFilters** - Search form
   ```tsx
   interface SearchFilters {
     userId?: string;
     eventType?: string;
     aggregateType?: string;
     aggregateId?: string;
     fromDate?: Date;
     toDate?: Date;
   }

   function EventSearchFilters({ onSearch }: { onSearch: (filters: SearchFilters) => void }) {
     const [filters, setFilters] = useState<SearchFilters>({});
     const { data: capabilities } = trpc.system.getCapabilities.useQuery();

     const eventTypeOptions = capabilities?.eventTypes.map(et => ({
       value: et.type,
       label: et.type
     })) || [];

     return (
       <Card withBorder p="md">
         <Stack>
           <Group grow>
             <TextInput
               label="User ID"
               placeholder="Enter user ID"
               value={filters.userId || ''}
               onChange={(e) => setFilters({ ...filters, userId: e.target.value })}
             />
             <Select
               label="Event Type"
               placeholder="Select event type"
               data={eventTypeOptions}
               value={filters.eventType}
               onChange={(value) => setFilters({ ...filters, eventType: value || undefined })}
               searchable
               clearable
             />
           </Group>

           <Group grow>
             <DateTimePicker
               label="From"
               placeholder="Start date"
               value={filters.fromDate}
               onChange={(value) => setFilters({ ...filters, fromDate: value || undefined })}
               clearable
             />
             <DateTimePicker
               label="To"
               placeholder="End date"
               value={filters.toDate}
               onChange={(value) => setFilters({ ...filters, toDate: value || undefined })}
               clearable
             />
           </Group>

           <Group justify="flex-end">
             <Button variant="light" onClick={() => setFilters({})}>
               Clear
             </Button>
             <Button onClick={() => onSearch(filters)}>
               Search
             </Button>
           </Group>
         </Stack>
       </Card>
     );
   }
   ```

2. **EventResultsTable** - Results table with pagination
   ```tsx
   function EventResultsTable({ events, pagination, onPageChange }: Props) {
     return (
       <>
         <Table striped highlightOnHover>
           <thead>
             <tr>
               <th>Timestamp</th>
               <th>Event Type</th>
               <th>User ID</th>
               <th>Aggregate ID</th>
               <th>Actions</th>
             </tr>
           </thead>
           <tbody>
             {events.map(event => (
               <tr key={event.id}>
                 <td>
                   <Text size="sm" ff="monospace">
                     {format(new Date(event.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                   </Text>
                 </td>
                 <td>
                   <Badge variant="light">{event.type}</Badge>
                 </td>
                 <td>
                   <Code>{event.userId.slice(0, 8)}</Code>
                 </td>
                 <td>
                   <Code>{event.aggregateId.slice(0, 8)}</Code>
                 </td>
                 <td>
                   <Group gap="xs">
                     <ActionIcon
                       variant="light"
                       onClick={() => handleViewEvent(event)}
                     >
                       <IconEye size={16} />
                     </ActionIcon>
                     <ActionIcon
                       variant="light"
                       onClick={() => handleCopyId(event.id)}
                     >
                       <IconCopy size={16} />
                     </ActionIcon>
                   </Group>
                 </td>
               </tr>
             ))}
           </tbody>
         </Table>

         <Group justify="space-between" mt="md">
           <Text size="sm" c="dimmed">
             Showing {pagination.offset + 1} to {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
           </Text>
           <Pagination
             total={Math.ceil(pagination.total / pagination.limit)}
             value={Math.floor(pagination.offset / pagination.limit) + 1}
             onChange={(page) => onPageChange((page - 1) * pagination.limit)}
           />
         </Group>
       </>
     );
   }
   ```

3. **EventViewModal** - Modal to view full event details
   ```tsx
   function EventViewModal({ event, opened, onClose }: Props) {
     return (
       <Modal
         opened={opened}
         onClose={onClose}
         title="Event Details"
         size="lg"
       >
         <Stack>
           <Group>
             <Badge size="lg">{event.type}</Badge>
             <Text size="sm" c="dimmed">
               {format(new Date(event.timestamp), 'PPpp')}
             </Text>
           </Group>

           <Divider />

           <ReactJson
             src={{
               id: event.id,
               type: event.type,
               timestamp: event.timestamp,
               userId: event.userId,
               aggregateId: event.aggregateId,
               data: event.data,
               metadata: event.metadata,
               correlationId: event.correlationId,
               causationId: event.causationId
             }}
             theme="monokai"
             displayDataTypes={false}
             collapsed={1}
             enableClipboard
           />

           <Group justify="flex-end">
             <Button
               variant="light"
               leftSection={<IconDownload size={16} />}
               onClick={() => downloadJSON(event)}
             >
               Export JSON
             </Button>
             {event.correlationId && (
               <Button
                 leftSection={<IconSearch size={16} />}
                 onClick={() => navigateToTrace(event.correlationId)}
               >
                 View Trace
               </Button>
             )}
           </Group>
         </Stack>
       </Modal>
     );
   }
   ```

4. **ExportButtons** - CSV/JSON export
   ```tsx
   function ExportButtons({ events }: { events: Event[] }) {
     const handleExportCSV = () => {
       const csv = [
         ['Timestamp', 'Event Type', 'User ID', 'Aggregate ID', 'Correlation ID'].join(','),
         ...events.map(e => [
           e.timestamp,
           e.type,
           e.userId,
           e.aggregateId,
           e.correlationId || ''
         ].join(','))
       ].join('\n');

       const blob = new Blob([csv], { type: 'text/csv' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = `events-${Date.now()}.csv`;
       a.click();
     };

     const handleExportJSON = () => {
       const json = JSON.stringify(events, null, 2);
       const blob = new Blob([json], { type: 'application/json' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = `events-${Date.now()}.json`;
       a.click();
     };

     return (
       <Group>
         <Button variant="light" onClick={handleExportCSV}>
           Export CSV
         </Button>
         <Button variant="light" onClick={handleExportJSON}>
           Export JSON
         </Button>
       </Group>
     );
   }
   ```

### Implementation Steps

1. **Day 1**: Search form
   - Create EventSearchPage
   - Build EventSearchFilters component
   - Wire up form state

2. **Day 2**: Results table + pagination
   - Create EventResultsTable
   - Implement pagination
   - Add loading/error states

3. **Day 3**: Event view modal + export
   - Create EventViewModal
   - Add view button to table
   - Implement CSV/JSON export

### Dependencies

```json
{
  "@mantine/dates": "^7.5.0",
  "date-fns": "^3.0.0",
  "react-json-view": "^1.21.3"
}
```

### Testing Checklist

- [ ] Search with filters returns correct results
- [ ] Pagination works
- [ ] Event modal shows full details
- [ ] CSV export contains correct data
- [ ] JSON export is valid
- [ ] "View Trace" button navigates to trace viewer

---

## Feature #6: AI Tools Playground ⭐⭐⭐

### Priority: Useful for AI Development

**Goal**: Test AI tools in isolation without running the full agent.

### Backend Readiness: ✅ 100%

**Available APIs**:
```typescript
// Get tool schema
trpc.system.getToolSchema.useQuery({ toolName: string })

// Execute tool
trpc.system.executeTool.useMutation({
  toolName: string;
  parameters: Record<string, any>;
  userId: string;
  threadId?: string;
})
```

### UI Components

#### 6.1 Main Page: `/tools`

**File**: `/apps/admin-ui/src/pages/ToolsPlaygroundPage.tsx`

**Layout**:
```
┌──────────────────────────────────────────────────────────┐
│  AI Tools Playground                                     │
│  Select Tool: [create_note ▼]                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ create_note                                        │ │
│  │ Create a new note from content                     │ │
│  │                                                     │ │
│  │ Parameters:                                         │ │
│  │ Title: [_____________________]                     │ │
│  │ Content: [__________________]                      │ │
│  │ Tags: [tag1, tag2]                                 │ │
│  │ User ID: [test-user]                               │ │
│  │                                                     │ │
│  │ [Execute Tool]                                     │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  Result:                                                 │
│  ┌────────────────────────────────────────────────────┐ │
│  │ ✅ Success                                         │ │
│  │ {                                                   │ │
│  │   "entityId": "note-123",                          │ │
│  │   "eventId": "evt-456"                             │ │
│  │ }                                                   │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  Execution History (last 10)                            │
│  12:34 create_note ✅                                   │
│  12:33 semantic_search ✅                               │
└──────────────────────────────────────────────────────────┘
```

**Components**:

1. **ToolSelector** - Select tool from dropdown
   ```tsx
   function ToolSelector({ onSelect }: { onSelect: (toolName: string) => void }) {
     const { data: capabilities } = trpc.system.getCapabilities.useQuery();

     const toolOptions = capabilities?.tools.map(tool => ({
       value: tool.name,
       label: tool.name,
       description: tool.description
     })) || [];

     return (
       <Select
         label="Select Tool"
         placeholder="Choose a tool to test"
         data={toolOptions}
         onChange={(value) => value && onSelect(value)}
         searchable
       />
     );
   }
   ```

2. **ToolParameterForm** - Dynamic form based on schema
   ```tsx
   function ToolParameterForm({ toolName, onExecute }: Props) {
     const { data: schema } = trpc.system.getToolSchema.useQuery({ toolName });
     const [parameters, setParameters] = useState<Record<string, any>>({});

     if (!schema) return <Loader />;

     return (
       <Card withBorder p="md">
         <Stack>
           <div>
             <Title order={4}>{schema.name}</Title>
             <Text size="sm" c="dimmed">{schema.description}</Text>
           </div>

           <Divider label="Parameters" />

           {/* Dynamically render form fields based on schema */}
           {Object.entries(schema.schema.properties).map(([key, prop]: [string, any]) => (
             <div key={key}>
               {prop._def?.typeName === 'ZodString' && (
                 <TextInput
                   label={key}
                   placeholder={`Enter ${key}`}
                   value={parameters[key] || ''}
                   onChange={(e) => setParameters({ ...parameters, [key]: e.target.value })}
                   required={schema.schema.required.includes(key)}
                 />
               )}
               {prop._def?.typeName === 'ZodNumber' && (
                 <NumberInput
                   label={key}
                   placeholder={`Enter ${key}`}
                   value={parameters[key]}
                   onChange={(value) => setParameters({ ...parameters, [key]: value })}
                   required={schema.schema.required.includes(key)}
                 />
               )}
               {prop._def?.typeName === 'ZodArray' && (
                 <TagsInput
                   label={key}
                   placeholder={`Enter ${key}`}
                   value={parameters[key] || []}
                   onChange={(value) => setParameters({ ...parameters, [key]: value })}
                 />
               )}
             </div>
           ))}

           <TextInput
             label="User ID"
             placeholder="Enter user ID for context"
             value={parameters.userId || 'test-user'}
             onChange={(e) => setParameters({ ...parameters, userId: e.target.value })}
           />

           <Button
             fullWidth
             onClick={() => onExecute(parameters)}
             leftSection={<IconPlayerPlay size={16} />}
           >
             Execute Tool
           </Button>
         </Stack>
       </Card>
     );
   }
   ```

3. **ToolResultPanel** - Show execution result
   ```tsx
   function ToolResultPanel({ result }: { result: ToolExecutionResult | null }) {
     if (!result) {
       return (
         <Card withBorder p="md">
           <Text c="dimmed" ta="center">
             Execute a tool to see results
           </Text>
         </Card>
       );
     }

     return (
       <Card withBorder p="md">
         <Stack>
           <Group>
             {result.success ? (
               <Badge color="green" leftSection={<IconCheck size={14} />}>
                 Success
               </Badge>
             ) : (
               <Badge color="red" leftSection={<IconX size={14} />}>
                 Error
               </Badge>
             )}
             <Text size="xs" c="dimmed">
               Executed at: {format(new Date(result.executedAt), 'HH:mm:ss')}
             </Text>
           </Group>

           <Divider />

           {result.success ? (
             <ReactJson
               src={result.result}
               theme="monokai"
               displayDataTypes={false}
               collapsed={1}
               enableClipboard
             />
           ) : (
             <Alert color="red" icon={<IconAlertCircle size={16} />}>
               {result.error}
             </Alert>
           )}

           <Group justify="flex-end">
             <Button variant="light" size="xs" onClick={() => copyResult(result)}>
               Copy Result
             </Button>
           </Group>
         </Stack>
       </Card>
     );
   }
   ```

4. **ExecutionHistory** - List of recent executions
   ```tsx
   function ExecutionHistory({ history }: { history: ToolExecution[] }) {
     return (
       <Card withBorder p="md">
         <Title order={5} mb="md">Execution History</Title>
         <Timeline active={history.length} bulletSize={20}>
           {history.map((exec, idx) => (
             <Timeline.Item
               key={idx}
               bullet={exec.success ? <IconCheck size={12} /> : <IconX size={12} />}
               title={exec.toolName}
             >
               <Text size="xs" c="dimmed">
                 {format(new Date(exec.executedAt), 'HH:mm:ss')}
               </Text>
               {exec.success ? (
                 <Badge color="green" size="xs">Success</Badge>
               ) : (
                 <Badge color="red" size="xs">Error</Badge>
               )}
             </Timeline.Item>
           ))}
         </Timeline>
       </Card>
     );
   }
   ```

### Implementation Steps

1. **Day 1**: Tool selector + schema fetching
   - Create ToolsPlaygroundPage
   - Build ToolSelector
   - Fetch and display tool schema

2. **Day 2**: Dynamic parameter form
   - Create ToolParameterForm
   - Implement dynamic field generation
   - Handle different Zod types (string, number, array)

3. **Day 3**: Execution + results
   - Wire up execute mutation
   - Create ToolResultPanel
   - Add execution history
   - Add copy/export functionality

### Dependencies

```json
{
  "react-json-view": "^1.21.3",
  "@mantine/dates": "^7.5.0"
}
```

### Testing Checklist

- [ ] Tool selector shows all tools
- [ ] Schema loads for selected tool
- [ ] Form renders correctly for different parameter types
- [ ] Tool execution works
- [ ] Success result displays
- [ ] Error displays correctly
- [ ] Execution history updates

---

## Feature #5: Handler Execution Inspector ⭐⭐⭐⭐⭐

### Priority: Critical but Complex - V2 Feature

**Goal**: View step-by-step execution of Inngest handlers, including retry attempts and errors.

### Backend Readiness: ⚠️ 60% - Requires Inngest Cloud API Integration

**Status**: DEFER TO V2

**Why Complex**:
- Requires Inngest Cloud API client setup
- Need to fetch run history from Inngest
- Step-by-step execution tracking
- Retry/failure analysis

**Recommendation**: Implement this after the first 4 features are complete and proven useful. The Inngest dashboard already provides some of this functionality, so it's lower priority.

**Future Implementation Notes**:
- Use Inngest SDK to fetch run history
- Display step execution timeline
- Show retry attempts with failure reasons
- Link to Inngest Cloud for detailed debugging

---

## Global Navigation Updates

Add all new pages to the navigation:

**File**: `/apps/admin-ui/src/App.tsx`

```tsx
import { AppShell, NavLink } from '@mantine/core';
import {
  IconTimeline,
  IconTopologyRing,
  IconChartBar,
  IconSearch,
  IconTool,
  IconBolt
} from '@tabler/icons-react';

const navLinks = [
  { to: '/stream', label: 'Live Events', icon: <IconBolt /> },
  { to: '/trace', label: 'Event Trace', icon: <IconTimeline /> },
  { to: '/architecture', label: 'Architecture', icon: <IconTopologyRing /> },
  { to: '/metrics', label: 'Metrics', icon: <IconChartBar /> },
  { to: '/events', label: 'Event Search', icon: <IconSearch /> },
  { to: '/tools', label: 'AI Tools', icon: <IconTool /> },
  { to: '/capabilities', label: 'Capabilities', icon: <IconInfoCircle /> },
  { to: '/publisher', label: 'Event Publisher', icon: <IconSend /> },
];

function App() {
  return (
    <AppShell
      navbar={{ width: 250, breakpoint: 'sm' }}
      padding="md"
    >
      <AppShell.Navbar p="md">
        <Title order={3} mb="md">Control Tower</Title>
        {navLinks.map(link => (
          <NavLink
            key={link.to}
            to={link.to}
            label={link.label}
            leftSection={link.icon}
            component={Link}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/stream" element={<EventStreamPage />} />
          <Route path="/trace" element={<EventTracePage />} />
          <Route path="/architecture" element={<ArchitecturePage />} />
          <Route path="/metrics" element={<MetricsDashboardPage />} />
          <Route path="/events" element={<EventSearchPage />} />
          <Route path="/tools" element={<ToolsPlaygroundPage />} />
          <Route path="/capabilities" element={<CapabilitiesPage />} />
          <Route path="/publisher" element={<EventPublisherPage />} />
          <Route path="/" element={<Navigate to="/stream" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
```

---

## Implementation Roadmap

### Phase 1: High-Value Features (Week 1)

**Days 1-3**: Event Trace Viewer (#1)
- Highest priority
- Core debugging tool
- Backend 100% ready

**Days 4-5**: Real-time Metrics Dashboard (#3)
- Quick win
- High value
- Shows system health

**Deliverable**: Core debugging and monitoring capabilities

---

### Phase 2: Architecture Visibility (Week 2)

**Days 1-4**: Event Flow Visualizer (#2)
- Living documentation
- Onboarding tool
- Complex visualization

**Days 5-6**: Event Store Search (#4)
- Useful for investigations
- SQL-like querying via UI

**Deliverable**: Complete system visibility

---

### Phase 3: Development Tools (Week 3)

**Days 1-3**: AI Tools Playground (#6)
- Development productivity
- Tool testing

**Deliverable**: Complete Control Tower V1

---

### Future: V2 Features

**TBD**: Handler Execution Inspector (#5)
- Complex Inngest integration
- Lower priority (Inngest dashboard exists)

---

## Success Criteria

### Phase 1 Complete When:
- [ ] Can trace any user action through system
- [ ] Can see system health metrics in real-time
- [ ] No critical bugs
- [ ] Performance is acceptable

### Phase 2 Complete When:
- [ ] Can visualize complete event architecture
- [ ] Can search events by any criteria
- [ ] Export functionality works
- [ ] Documentation is updated

### Phase 3 Complete When:
- [ ] Can test any AI tool in isolation
- [ ] Parameter validation works
- [ ] Execution history is saved

---

## Documentation Requirements

For each feature, create:
1. **README** with screenshots
2. **User guide** for operations team
3. **Developer guide** for maintenance
4. **Troubleshooting** section

---

## Final Notes

- **Backend is 100% ready** for features #1, #2, #3, #4, #6
- **Estimated total effort**: 15-18 days for V1
- **Defer feature #5** to V2 (complex Inngest integration)
- **All APIs are tested and working**
- **TypeScript types are fixed**

**YOU ARE READY TO START IMPLEMENTING THE UI!** 🚀

---

**Last Updated**: 2025-01-18
**Next Review**: After Phase 1 completion
