# User Guide - Synap Control Tower

A comprehensive guide for using the Synap Control Tower admin interface.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Dashboard](#dashboard)
3. [Investigating Events](#investigating-events)
4. [Testing Tools & Events](#testing-tools--events)
5. [Exploring the System](#exploring-the-system)
6. [Keyboard Shortcuts](#keyboard-shortcuts)
7. [Tips & Tricks](#tips--tricks)

## Getting Started

### First Launch

1. Open the Control Tower in your browser
2. You'll see the **Dashboard** with system health metrics
3. Use the sidebar to navigate between sections
4. Press **⌘K** (Mac) or **Ctrl+K** (Windows/Linux) to open the Command Palette

### Navigation

- **Sidebar**: Main navigation (collapsible on tablet, drawer on mobile)
- **Top Bar**: Search button and user menu
- **Command Palette**: Quick access to everything (⌘K)

## Dashboard

The Dashboard is your command center.

### System Health Metrics

View real-time metrics:

- **Total Events**: Number of events in the system
- **Active Users**: Currently active users
- **System Health**: Overall system status (Healthy/Warning/Critical)

### Quick Actions

Fast access to common tasks:

1. **Investigate User**
   - Click the button
   - Enter user ID or email in the search modal
   - View all events for that user

2. **View Event Trace**
   - Click the button
   - Enter event ID in the search modal
   - See the full correlation chain

3. **Test AI Tool**
   - Opens the Testing page
   - Jump directly to AI Tools Playground

4. **View Architecture**
   - Opens the Explore page
   - See system architecture overview

### Live Event Stream

Watch events as they happen:

- **Auto-refresh**: Enabled by default (every 5 seconds)
- **Manual Refresh**: Click the refresh icon
- **Pause/Resume**: Toggle auto-refresh
- **Click Event**: Navigate to event details
- **Right-Click Event**: Open context menu

**Context Menu Options:**

- **Inspect in Detail**: Full event view
- **View Full Trace**: See correlated events
- **Publish Similar Event**: Clone for testing
- **Copy Event ID**: Quick copy

## Investigating Events

The Investigate page helps you debug and trace issues.

### Searching Events

1. **Enter Search Term**
   - User ID or email
   - Event ID
   - Correlation ID
   - Any search term

2. **Filter by Type** (optional)
   - Select event type from dropdown
   - Or leave as "All types"

3. **Click Search** or press Enter

### Viewing Results

**Event List:**

- Click any event to see details
- Selected event is highlighted
- Related events shown in timeline

**Event Details Panel:**

- Full event data
- Metadata
- Correlation IDs
- Related events timeline

### Event Timeline

When viewing an event, you'll see:

- **Related Events**: Events with same correlation ID
- **Chronological Order**: Events sorted by timestamp
- **Quick Actions**: Click "View details" to inspect related events

## Testing Tools & Events

The Testing page has two powerful tools.

### AI Tools Playground

Test AI tools without writing code:

1. **Select Tool**
   - Choose from dropdown
   - See tool description

2. **Fill Parameters**
   - Smart form appears automatically
   - No JSON knowledge needed!
   - Required fields marked with red badge
   - Optional fields clearly indicated

3. **Execute**
   - Click "Execute Tool"
   - See results in output panel
   - Success/error notifications appear

4. **View History**
   - See all tool executions
   - Click to view details
   - Filter by success/error

**Example: Testing Semantic Search**

1. Select "semanticSearch" tool
2. Form shows:
   - **query** (required): Enter your search query
   - **limit** (optional): Number of results
3. Fill in query: "user authentication"
4. Execute
5. See search results in output

### Event Publisher

Publish events for testing:

#### Using Templates (Recommended)

1. **Choose Template**
   - Click "Note Creation", "Task Creation", or "Project Creation"
   - Form pre-fills automatically

2. **Modify Fields**
   - Edit any field as needed
   - Add or remove optional fields

3. **Publish**
   - Click "Publish Event"
   - See success notification
   - Event appears in Live Event Stream

#### Manual Event Creation

1. **Select Event Type**
   - Choose from dropdown
   - If schema exists, form appears
   - Otherwise, use JSON editor

2. **Fill Form or JSON**
   - **Form Mode**: Use smart form (default)
   - **JSON Mode**: Switch to JSON editor
   - Toggle with segmented control

3. **Enter User ID**
   - Pre-filled from last use (smart default!)
   - Or enter new user ID

4. **Publish**

#### Publishing Similar Events

From any event (Dashboard, Investigate, etc.):

1. Right-click event (or click "...")
2. Select "Publish Similar Event"
3. Event Publisher opens with:
   - Event type pre-selected
   - Data pre-filled
   - User ID pre-filled
4. Modify as needed
5. Publish

## Exploring the System

The Explore page shows your system architecture.

### Architecture View

See all system components:

- **Event Store**: Where events are stored
- **AI Tools**: Available AI capabilities
- **Handlers**: Event processors
- **Routers**: API endpoints

### Tool Registry

Browse all available AI tools:

- Tool name and description
- Version and source
- Click to test in Testing page

### Recent Events

See examples of recent system activity:

- Event types
- Timestamps
- Sample data

## Keyboard Shortcuts

### Global Shortcuts

- **⌘K / Ctrl+K**: Open Command Palette
- **Esc**: Close Command Palette / Modals
- **Enter**: Submit forms / Execute search

### Command Palette Navigation

- **↑↓**: Navigate options
- **Enter**: Select option
- **Esc**: Close palette

### Form Navigation

- **Tab**: Move between fields
- **Enter**: Submit form
- **Esc**: Cancel (if applicable)

## Tips & Tricks

### 1. Use Templates

Instead of manually creating events:

- Use templates for common event types
- Modify as needed
- Save time!

### 2. Search History

The search modal remembers:

- Last 10 searches per type
- Click to reuse
- Clear history if needed

### 3. Smart Defaults

The app remembers:

- Last user ID used
- Your preferences
- Recent searches

### 4. Contextual Actions

Right-click (or click "...") on any event for:

- Quick navigation
- Event cloning
- Copy operations

### 5. Command Palette

Use ⌘K for:

- Quick navigation
- Fast actions
- System utilities

### 6. Form vs JSON

- **Form Mode**: Easier, guided, validated
- **JSON Mode**: Advanced, full control
- Switch anytime with toggle

### 7. Event Tracing

To trace a user journey:

1. Search by user ID
2. Click any event
3. View timeline
4. Follow correlation IDs

### 8. Testing Workflow

1. Use AI Tools Playground to test tools
2. Check results
3. If needed, publish events to trigger workflows
4. Monitor in Live Event Stream
5. Investigate if issues occur

## Common Workflows

### Debugging a User Issue

1. Go to Dashboard
2. Click "Investigate User"
3. Enter user ID
4. Review events chronologically
5. Click suspicious event
6. View full trace
7. Identify root cause

### Testing a New Event Type

1. Go to Testing → Event Publisher
2. Select event type
3. Fill form (or use JSON)
4. Publish
5. Check Live Event Stream
6. Verify event appears
7. Check handlers executed

### Monitoring System Health

1. Stay on Dashboard
2. Watch metrics update (auto-refresh)
3. Check Live Event Stream for errors
4. Click error events to investigate
5. Use Command Palette for quick actions

### Creating Test Data

1. Go to Testing → Event Publisher
2. Use template (e.g., "Note Creation")
3. Modify fields
4. Publish
5. Repeat for different scenarios
6. Monitor in Live Event Stream

## Troubleshooting

### Events Not Appearing

- Check auto-refresh is enabled
- Click manual refresh
- Verify backend is running
- Check browser console

### Forms Not Loading

- Ensure event type has schema
- Check network tab for API errors
- Try switching to JSON mode
- Reload page

### Search Not Working

- Check search term format
- Try different search types
- Clear filters
- Check browser console

### Performance Issues

- Large event lists are virtualized (only visible items rendered)
- If slow, reduce auto-refresh interval
- Use filters to narrow results
- Clear browser cache

---

**Need Help?** Check the main [README](./README.md) or contact the development team.
