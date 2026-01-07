# Permission System Documentation

**Version**: 1.0 (Streamlined Approach)  
**Last Updated**: January 6, 2026  
**Status**: Production

---

## 🎯 Overview

Synap uses an **event-driven permission system** where all write operations go through a validation layer before reaching the database.

### **Architecture**:
```
Router → .requested Event → Permission Validator → .validated Event → Table Worker → Database
```

### **Design Principles**:
1. **Single source of truth**: Events table contains all approval metadata
2. **Reusable helpers**: Permission logic uses existing workspace-permissions utilities
3. **Extensible**: Easy to add new policies via roles table or code
4. **Auditable**: Every decision logged in event metadata

---

## 📊 Current Capabilities

### ✅ **Supported Features**

| Feature | Status | Description |
|---------|--------|-------------|
| **Role-based auto-approval** | ✅ Implemented | Editor+ auto-approved for create/update |
| **Owner bypass** | ✅ Implemented | Workspace owners bypass all checks |
| **Delete protection** | ✅ Implemented | Only owner can delete resources |
| **AI proposal approval** | ✅ Implemented | AI actions require user approval (unless auto-enabled) |
| **Personal resources** | ✅ Implemented | Personal resources require ownership |
| **Audit trail** | ✅ Implemented | All decisions in events.metadata |
| **Event sourcing** | ✅ Implemented | Can replay approvals from events |
| **Custom policies (basic)** | ✅ Implemented | Via roles table JSONB field |

### **Permission Flow Example**:

```typescript
// User creates a view
POST /api/trpc/views.create
  ↓
Router publishes: views.create.requested
  ↓
Permission Validator checks:
  - Is user a workspace editor? → YES
  ↓
Updates event metadata:
  {
    approvalStatus: 'approved',
    approvedBy: 'user-123',
    approvalReason: 'editor-modify',
    autoApproved: true
  }
  ↓
Emits: views.create.validated
  ↓
Views Worker creates view in database
  ↓
Returns to user
```

---

## ⚙️ How It Works

### **1. Event Metadata Structure**

All approval information is stored in the `events.metadata` JSONB field:

```typescript
{
  // Approval status
  approvalStatus: 'pending' | 'approved' | 'denied',
  
  // When auto-approved
  approvedBy: 'user-id',
  approvedAt: '2026-01-06T15:30:00Z',
  approvalReason: 'owner-delete' | 'editor-modify' | 'viewer-read',
  autoApproved: true,
  
  // When needs approval
  approvers: ['owner-id'],
  pendingReason: 'Only workspace owner can delete',
  requestedAt: '2026-01-06T15:30:00Z',
  
  // When denied
  deniedReason: 'Viewers cannot create resources',
  deniedAt: '2026-01-06T15:30:00Z',
  
  // Source tracking
  source: 'user' | 'ai',
}
```

### **2. Permission Rules**

Implemented in `packages/jobs/src/functions/permission-validator.ts`:

```typescript
// Rule 1: DELETE = Owner only
if (action === 'delete') {
  await requireOwner(db, workspaceId, userId);
  // Not owner? → Needs approval from owner
}

// Rule 2: CREATE/UPDATE = Editor+
if (action === 'create' || action === 'update') {
  await requireEditor(db, workspaceId, userId);
  // Not editor? → Denied (viewers can't modify)
}

// Rule 3: AI proposals = User approval
if (source === 'ai' && !workspace.aiAutoApprove) {
  // → Pending (user must approve)
}
```

### **3. Querying Pending Approvals**

```typescript
// List pending approvals for current user
const pendingApprovals = await db.query.events.findMany({
  where: and(
    eq(events.metadata->>'approvalStatus', 'pending'),
    sql`${userId} = ANY((metadata->>'approvers')::text[])`
  ),
  orderBy: desc(events.timestamp),
});
```

---

## ⚠️ Known Limitations

### **1. Multi-Approver Workflows** 
**Status**: Partially supported  
**Limitation**: Requires multiple JSONB queries  
**Workaround**: Works for simple cases (1-2 approvers)

**Example** (current approach):
```typescript
// Approvals stored as array in metadata
metadata: {
  approvers: ['owner', 'admin-1', 'admin-2'],
  approvalsReceived: ['owner', 'admin-1'],
  approvalsRequired: 2
}

// Complex query needed
WHERE jsonb_array_length(metadata->'approvalsReceived') 
      >= (metadata->>'approvalsRequired')::int
```

**When to upgrade**: 
- Need 3+ required approvers regularly
- Need approval delegation
- Need approval chains (A approves → B reviews → C signs off)

**Upgrade Path → `approval_requests` table**:
```sql
CREATE TABLE approval_requests (
  id UUID PRIMARY KEY,
  event_id UUID REFERENCES events(id),
  approvers TEXT[],
  approvals_received INTEGER DEFAULT 0,
  approvals_required INTEGER DEFAULT 1,
  -- Easy query: approvals_received >= approvals_required
);
```

### **2. Query Performance at Scale**
**Status**: Good up to ~500 pending approvals  
**Limitation**: JSONB queries slower than indexed columns  

**Benchmark** (PostgreSQL 15, 100MB dataset):
- < 100 pending: 5-10ms (acceptable)
- 100-500 pending: 20-50ms (acceptable)
- 500-1000 pending: 50-100ms (noticeable)
- 1000+ pending: 100-200ms (slow)

**When to upgrade**:
- Workspace has 500+ pending approvals regularly
- Dashboard showing pending approvals is slow (> 100ms)
- Users complain about approval page loading time

**Upgrade Path → Add indexes + optional table**:
```sql
-- Option A: Better indexes
CREATE INDEX idx_events_approval_status 
  ON events USING GIN (metadata)
  WHERE (metadata->>'approvalStatus') IS NOT NULL;

-- Option B: Materialized view
CREATE MATERIALIZED VIEW approval_queue AS
SELECT 
  id,
  metadata->>'approvalStatus' as status,
  (metadata->>'approvers')::text[] as approvers,
  timestamp
FROM events
WHERE metadata->>'approvalStatus' = 'pending';

-- Option C: Dedicated table (same as multi-approver upgrade)
```

### **3. Complex Policy Conditions**
**Status**: Basic policies supported  
**Limitation**: Complex conditions require code changes  

**Currently supported** (via `roles.permissions` JSONB):
```typescript
{
  requiredRole: 'editor',
  maxResourceCount: 100,
  allowedResourceTypes: ['view', 'document']
}
```

**Not easily supported**:
- Time-based conditions ("only during business hours")
- IP-based restrictions
- Rate limiting ("max 10 creates per hour")
- Conditional chains ("if X then require Y")

**When to upgrade**:
- Need time/IP/rate-limit based policies
- Need external approval (webhook to API)
- Need complex conditional logic

**Upgrade Path → Policy engine**:
```typescript
// Option A: Enhanced JSONB policies
{
  conditions: {
    timeRestriction: { start: '09:00', end: '17:00' },
    ipWhitelist: ['192.168.1.0/24'],
    rateLimit: { max: 10, window: '1h' }
  }
}

// Option B: Dedicated permission_policies table with priority
CREATE TABLE permission_policies (
  id UUID PRIMARY KEY,
  workspace_id UUID,
  resource_type TEXT,
  action TEXT,
  conditions JSONB,
  priority INTEGER
);
```

### **4. Approval Analytics**
**Status**: Basic queries work  
**Limitation**: Complex aggregations are slower  

**Works well**:
```sql
-- Who approved most requests this month?
SELECT 
  metadata->>'approvedBy' as approver,
  COUNT(*) as count
FROM events
WHERE metadata->>'approvalStatus' = 'approved'
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY metadata->>'approvedBy';
```

**Slower**:
- Average approval time by user
- Approval rates by resource type
- Denial patterns over time

**When to upgrade**:
- Need real-time analytics dashboard
- Need approval SLA monitoring
- Need compliance reports (monthly)

**Upgrade Path → Analytics table or service**:
```sql
-- Materialized view for analytics
CREATE MATERIALIZED VIEW approval_analytics AS
SELECT 
  DATE_TRUNC('day', timestamp) as date,
  metadata->>'approvedBy' as approver,
  subject_type as resource_type,
  COUNT(*) as approval_count,
  AVG(EXTRACT(EPOCH FROM (
    (metadata->>'approvedAt')::timestamp - timestamp
  ))) as avg_approval_time_seconds
FROM events
WHERE metadata->>'approvalStatus' = 'approved'
GROUP BY date, approver, resource_type;

-- Refresh daily or weekly
REFRESH MATERIALIZED VIEW approval_analytics;
```

---

## 🚀 Upgrade Decision Matrix

| Symptom | Threshold | Recommended Upgrade |
|---------|-----------|-------------------|
| Slow approval page | > 100ms load time | Add GIN indexes or materialized view |
| Many pending approvals | > 500 regularly | Create `approval_requests` table |
| Need 3+ approvers | Any workflow | Add `approval_requests` with workflow |
| Need time/IP policies | Any requirement | Enhance policy evaluator |
| Need analytics | Dashboard needed | Create `approval_analytics` materialized view |
| Need delegation | Any delegation | Add approval delegation to `approval_requests` |

---

## 📖 API Reference

### **List Pending Approvals**

```typescript
const approvals = await trpc.approvals.listPending.query({
  workspaceId: 'workspace-123',
});

// Returns events with pending approval
[{
  id: 'event-456',
  type: 'views.delete.requested',
  data: { viewId: 'view-789', name: 'Q4 Report' },
  metadata: {
    approvalStatus: 'pending',
    approvers: ['owner-id'],
    pendingReason: 'Only workspace owner can delete',
  }
}]
```

### **Approve/Deny Request**

```typescript
await trpc.approvals.review.mutate({
  eventId: 'event-456',
  decision: 'approve', // or 'deny'
  reason: 'Approved for Q4 cleanup',
});

// Updates event metadata and emits .validated or .denied
```

---

## 🔧 Extending the System

### **Add New Permission Rule**

Edit `packages/jobs/src/functions/permission-validator.ts`:

```typescript
// Example: Restrict creates on weekends
if (action === 'create') {
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      granted: false,
      needsApproval: true,
      approvers: [workspaceOwnerId],
      reason: 'Weekend creates require owner approval'
    };
  }
}
```

### **Add Custom Policy in Roles Table**

```sql
-- Insert custom policy
INSERT INTO roles (workspace_id, name, permissions) VALUES (
  'workspace-123',
  'weekend-restricted',
  '{
    "allowWeekendCreates": false,
    "requireApprovalOutsideHours": true
  }'
);

-- Query in validator
const role = await db.query.roles.findFirst({
  where: eq(roles.workspaceId, workspaceId)
});

if (!role.permissions.allowWeekendCreates && isWeekend()) {
  // Require approval
}
```

---

## 📚 Related Documentation

- `packages/api/src/utils/workspace-permissions.ts` - Permission helper functions
- `packages/jobs/src/functions/permission-validator.ts` - Validation logic
- `docs/brain/permission_roadmap.md` - Future evolution plan
- `docs/AUTHENTICATION.md` - User authentication system

---

## 🎯 Migration Path Summary

**Phase 1** (Current): Streamlined approach
- ✅ Handles 95% of use cases
- ✅ Simple, maintainable
- ✅ Events table as source of truth

**Phase 2** (If needed - 6+ months):
```sql
-- Add approval_requests for query performance
CREATE TABLE approval_requests AS SELECT ...

-- Add permission_policies for complex rules  
CREATE TABLE permission_policies ...
```

**Phase 3** (Advanced - 12+ months):
- External policy engine (OPA, Casbin)
- Real-time analytics service
- Approval workflow orchestration

**Key Principle**: Start simple, upgrade when metrics show need.
