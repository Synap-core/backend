# n8n Integration Architecture - Final Plan

## From Isolated Data Pod to Connected Intelligence Ecosystem

**Version**: 2.0 (OAuth2 Revision)  
**Date**: 2025-12-07  
**Authors**: Archie (CTO), Product Team  
**Status**: 📋 Ready for Stakeholder Review

---

## Executive Summary

Transform Synap from an isolated Data Pod into **the intelligent orchestration layer** for users' entire digital ecosystem. n8n integration enables Synap to become the "brain" that perceives, reasons about, and acts upon external services.

### Strategic Impact

| Dimension              | Value                                                         |
| ---------------------- | ------------------------------------------------------------- |
| **Market Access**      | 50k+ n8n community members, enterprise automation users       |
| **Product Stickiness** | 10x increase - Synap becomes mission-critical infrastructure  |
| **Vision Validation**  | First proof of "Personal OS" + "3 Systems Brain" architecture |
| **Revenue Unlock**     | Premium "Automation Agent" tier, B2B opportunities            |

### Architecture Approach

**✅ Leverage Existing Infrastructure**: Use Ory Hydra OAuth2 (already configured) instead of building custom API keys

**🎯 Three Foundation Pillars**:

1. **OAuth2 Authentication** - Industry-standard machine-to-machine auth via Hydra
2. **Webhooks System** - Real-time event notifications to external services
3. **Actions API** - Programmatic access to Synap's intelligence

**📅 Timeline**: 8 weeks to production-ready MVP

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Authentication Strategy: OAuth2 via Hydra](#2-authentication-strategy-oauth2-via-hydra)
3. [Webhooks System Design](#3-webhooks-system-design)
4. [Actions API Design](#4-actions-api-design)
5. [Alignment with 3 Systems Brain](#5-alignment-with-3-systems-brain)
6. [Security & Risk Management](#6-security--risk-management)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Success Metrics](#8-success-metrics)

---

## 1. Current Architecture Analysis

### 1.1 Existing Infrastructure (Strong Foundation)

Our architecture is remarkably well-positioned for this integration:

#### ✅ Ory Hydra OAuth2 Server (Already Configured!)

```yaml
# docker-compose.yml - Already exists
kratos:
  image: oryd/kratos:v1.3.0
  profiles: ["auth"]

# packages/auth/src/ory-hydra.ts - Already implemented
- createOAuth2Client()
- introspectToken()
- Token exchange framework
```

**Discovery**: The infrastructure for authenticated plugin services **already exists**. This was specifically designed for this use case.

#### ✅ Event Sourcing System

```sql
-- Already operational
events (
  id UUID,
  type TEXT,              -- "task.completed", "note.created"
  data JSONB,             -- Flexible event payload
  userId TEXT,
  timestamp TIMESTAMPTZ,
  correlationId UUID
)
```

**Advantage**: Webhooks can be triggered by listening to this immutable event log.

#### ✅ Hub Protocol V1 - Intelligence Hub / Data Pod Separation

```
Intelligence Hub (Proprietary)        Data Pod (Open Source)
  ├─ Frontend UI                        ├─ Event Store
  ├─ mem0 memory                        ├─ Vector DB
  ├─ Agent orchestration                ├─ PostgreSQL
  └─ Hub Protocol ──────────────────────┴─ APIs
```

**Advantage**: n8n can integrate at both levels - cloud SaaS or self-hosted.

#### ✅ Plugin Manager & Dynamic Router Registry

```typescript
// Already supports runtime extensibility
pluginManager.register(n8nPlugin);
dynamicRouterRegistry.register("n8n-actions", router);
```

**Advantage**: n8n features can be added as plugins without core modifications.

### 1.2 What We Need to Build

| Component                    | Status     | Priority    |
| ---------------------------- | ---------- | ----------- |
| OAuth2 Client Management UI  | ❌ Missing | 🔴 Critical |
| OAuth2 Auth Middleware       | ⚠️ Partial | 🔴 Critical |
| Webhook Subscriptions System | ❌ Missing | 🔴 Critical |
| Webhook Broker (Inngest)     | ❌ Missing | 🔴 Critical |
| n8n Actions API Router       | ❌ Missing | 🟡 High     |
| Rate Limiting                | ❌ Missing | 🟡 High     |

---

## 2. Authentication Strategy: OAuth2 via Hydra

### 2.1 Why OAuth2 Over Custom API Keys?

| Criterion            | Custom API Keys            | OAuth2 Client Credentials ✅       |
| -------------------- | -------------------------- | ---------------------------------- |
| **Infrastructure**   | Need to build              | Already exists (Ory Hydra)         |
| **Standards**        | Custom implementation      | RFC 6749 (industry standard)       |
| **Token Lifetime**   | Long-lived (security risk) | Short-lived (15min, auto-refresh)  |
| **Scope Management** | Basic (read/write)         | Granular (read:notes, write:tasks) |
| **Enterprise Ready** | Requires work              | Native OAuth2                      |
| **Audit Trail**      | Custom implementation      | Built-in Hydra logs                |
| **Revocation**       | Database update            | Immediate (token introspection)    |

**Decision**: Use OAuth2 Client Credentials flow via existing Ory Hydra infrastructure.

### 2.2 OAuth2 Flow for n8n

```
┌─────────────────────────────────────────────────────┐
│              n8n Workflow (User's Instance)          │
│  Credential: "Synap OAuth2 Client"                  │
│    - client_id: synap_user123_abc                   │
│    - client_secret: ••••••••                        │
│    - grant_type: client_credentials                 │
│    - scopes: read:entities write:entities           │
└──────────────┬──────────────────────────────────────┘
               │
               │ 1. Request Access Token
               │ POST /oauth2/token
               ▼
┌──────────────────────────────────────────────────────┐
│         Ory Hydra (OAuth2 Authorization Server)      │
│  - Validates client_id + client_secret               │
│  - Issues JWT access token                           │
│  - Token lifetime: 15 minutes (configurable)         │
│  - Scopes: read:* write:* webhook:*                  │
└──────────────┬───────────────────────────────────────┘
               │
               │ 2. Returns access_token (JWT)
               │ { "access_token": "ory_at_...",
               │   "expires_in": 900 }
               ▼
┌──────────────────────────────────────────────────────┐
│           n8n Makes API Call to Synap                │
│  GET /api/entities                                   │
│  Authorization: Bearer ory_at_xxxxx                  │
└──────────────┬───────────────────────────────────────┘
               │
               │ 3. API Request with Token
               ▼
┌──────────────────────────────────────────────────────┐
│         Synap API (Hono + tRPC)                      │
│  Middleware: OAuth2TokenValidator                    │
│  1. Extract Bearer token                             │
│  2. Introspect via Hydra                             │
│  3. Validate scopes                                  │
│  4. Resolve userId from client metadata              │
│  5. Execute request                                  │
└──────────────────────────────────────────────────────┘
```

### 2.3 Database Schema

#### New Table: oauth2_client_owners

```sql
-- Maps OAuth2 clients to Synap users
-- Hydra manages clients, we manage user mapping
CREATE TABLE oauth2_client_owners (
  client_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- "n8n Production"
  scopes TEXT[] NOT NULL,             -- ["read:entities", "write:tasks"]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_oauth2_owners_user ON oauth2_client_owners(user_id);
```

### 2.4 Implementation: OAuth2 Client Management

#### API Endpoints

```typescript
// tRPC router: oauth2.clients
router.oauth2.clients.create({
  name: string,                      // "n8n Production Workflow"
  scopes: string[],                  // ["read:entities", "write:tasks"]
  description?: string
}) → {
  clientId: string,                  // synap_user123_abc
  clientSecret: string,              // Shown ONCE, never again
  tokenUrl: string                   // https://api.synap.ai/oauth2/token
}

router.oauth2.clients.list() → OAuth2Client[]
router.oauth2.clients.revoke(clientId: string) → { success: boolean }
router.oauth2.clients.getStats(clientId: string) → { requests: number, lastUsed: Date }
```

#### Service Implementation

```typescript
// packages/domain/src/services/oauth2-client-service.ts
import { createOAuth2Client } from "@synap/auth";
import { randomBytes } from "crypto";

export class OAuth2ClientService {
  async createClient(
    userId: string,
    input: {
      name: string;
      scopes: string[];
    }
  ) {
    // Generate client credentials
    const clientId = `synap_${userId}_${randomBytes(8).toString("hex")}`;
    const clientSecret = randomBytes(32).toString("hex");

    // Register with Hydra
    await createOAuth2Client({
      client_id: clientId,
      client_secret: clientSecret,
      grant_types: ["client_credentials"],
      response_types: [],
      scope: input.scopes.join(" "),
      redirect_uris: [], // Not needed for client_credentials
      metadata: {
        user_id: userId,
        name: input.name,
      },
    });

    // Store mapping in our DB
    await db.insert(oauth2ClientOwners).values({
      client_id: clientId,
      user_id: userId,
      name: input.name,
      scopes: input.scopes,
    });

    return {
      clientId,
      clientSecret, // Return once!
      tokenUrl: `${config.apiUrl}/oauth2/token`,
    };
  }
}
```

#### Middleware: OAuth2 Token Validation

```typescript
// packages/auth/src/middleware/oauth2-auth.ts
import { introspectToken } from "../ory-hydra.js";

export async function validateOAuth2Token(req: Request): Promise<{
  userId: string;
  scopes: string[];
  clientId: string;
}> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing OAuth2 token");
  }

  const token = authHeader.substring(7);

  // Introspect via Hydra
  const tokenInfo = await introspectToken(token);

  if (!tokenInfo?.active) {
    throw new UnauthorizedError("Invalid or expired token");
  }

  // Resolve user from client
  const client = await db.query.oauth2ClientOwners.findFirst({
    where: eq(oauth2ClientOwners.client_id, tokenInfo.client_id),
  });

  if (!client) {
    throw new UnauthorizedError("Client not found");
  }

  // Update last used
  await db
    .update(oauth2ClientOwners)
    .set({ last_used_at: new Date() })
    .where(eq(oauth2ClientOwners.client_id, tokenInfo.client_id));

  return {
    userId: client.user_id,
    scopes: tokenInfo.scope?.split(" ") || [],
    clientId: tokenInfo.client_id,
  };
}
```

### 2.5 User Experience: Connecting n8n

**Step 1**: User creates OAuth2 client in Synap UI

- Navigate to Settings > Integrations > OAuth2 Clients
- Click "Create New Client"
- Enter name: "n8n Production"
- Select scopes: `read:entities`, `write:entities`, `webhook:manage`
- Click Create

**Step 2**: Copy credentials (shown once!)

```
Client ID: synap_user123_abc7f2e4
Client Secret: ••••••••••••••••••••••••••
Token URL: https://api.synap.ai/oauth2/token
Scopes: read:entities write:entities webhook:manage
```

**Step 3**: Configure n8n credentials

- In n8n: Credentials > New > OAuth2 API
- Grant Type: Client Credentials
- Access Token URL: [paste from Synap]
- Client ID: [paste]
- Client Secret: [paste]
- Scope: `read:entities write:entities`
- Save

**Step 4**: Use in workflows

- n8n automatically handles token acquisition and refresh
- User builds workflows with Synap nodes

---

## 3. Webhooks System Design

### 3.1 Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│         Synap Event Store (PostgreSQL)               │
│  Event occurs: task.completed                        │
└──────────────┬───────────────────────────────────────┘
               │
               │ Emit: db/events.inserted
               ▼
┌──────────────────────────────────────────────────────┐
│         Inngest Webhook Broker (Background Job)      │
│  1. Find subscriptions for event type + user         │
│  2. For each subscription:                           │
│     - Create HMAC signature                          │
│     - POST to webhook URL                            │
│     - Log delivery status                            │
│     - Retry on failure (max 3)                       │
└──────────────┬───────────────────────────────────────┘
               │
               │ HTTPS POST
               ▼
┌──────────────────────────────────────────────────────┐
│              n8n Webhook (User's Instance)           │
│  Headers:                                            │
│    X-Synap-Signature: hmac_sha256...                │
│    X-Synap-Event-Type: task.completed               │
│  Body: { type, data, userId, timestamp }            │
└──────────────────────────────────────────────────────┘
```

### 3.2 Database Schema

```sql
-- Webhook subscriptions
CREATE TABLE webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- "n8n - Task Notifications"
  url TEXT NOT NULL,                     -- https://n8n.acme.com/webhook/xyz
  event_types TEXT[] NOT NULL,           -- ["task.completed", "note.created"]
  secret TEXT NOT NULL,                  -- For HMAC signature
  active BOOLEAN DEFAULT true,
  retry_config JSONB DEFAULT '{"maxRetries": 3, "backoff": "exponential"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX idx_webhooks_user_active ON webhook_subscriptions(user_id, active);

-- Delivery audit log
CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id),
  status TEXT NOT NULL,                  -- "success" | "failed" | "pending"
  response_status INTEGER,               -- HTTP status
  response_body TEXT,
  attempt INTEGER DEFAULT 1,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_subscription ON webhook_deliveries(subscription_id);
CREATE INDEX idx_deliveries_status ON webhook_deliveries(status, created_at);
```

### 3.3 Inngest Webhook Broker

```typescript
// packages/jobs/src/functions/webhook-broker.ts
import { inngest } from "../client";
import { createHmac } from "crypto";

export const webhookBroker = inngest.createFunction(
  { id: "webhook-broker", name: "Webhook Event Broadcaster" },
  { event: "db/events.inserted" },
  async ({ event, step }) => {
    const synapEvent = event.data;

    // Find active subscriptions
    const subscriptions = await step.run("find-subscriptions", async () => {
      return db.query.webhookSubscriptions.findMany({
        where: and(
          eq(webhookSubscriptions.userId, synapEvent.userId),
          eq(webhookSubscriptions.active, true),
          sql`event_types && ARRAY[${synapEvent.type}]::text[]`
        ),
      });
    });

    // Deliver to each subscription
    await Promise.all(
      subscriptions.map((sub) =>
        step.run(`deliver-${sub.id}`, async () => {
          const signature = createHmac("sha256", sub.secret)
            .update(JSON.stringify(synapEvent))
            .digest("hex");

          const response = await fetch(sub.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Synap-Signature": signature,
              "X-Synap-Event-Type": synapEvent.type,
              "X-Synap-Event-ID": synapEvent.id,
            },
            body: JSON.stringify(synapEvent),
          });

          await logDelivery({
            subscriptionId: sub.id,
            eventId: synapEvent.id,
            status: response.ok ? "success" : "failed",
            responseStatus: response.status,
          });

          if (!response.ok) throw new Error("Webhook delivery failed");
        })
      )
    );
  }
);
```

### 3.4 Webhook Management API

```typescript
// tRPC router: webhooks
router.webhooks.create({
  name: string,
  url: string,
  eventTypes: string[],
  secret?: string  // Auto-generate if not provided
}) → WebhookSubscription

router.webhooks.list() → WebhookSubscription[]
router.webhooks.update(id: UUID, { active: boolean }) → WebhookSubscription
router.webhooks.delete(id: UUID) → { success: boolean }
router.webhooks.test(id: UUID) → { deliveryId: UUID, status: string }
router.webhooks.getDeliveries(id: UUID, { limit: number }) → WebhookDelivery[]
```

---

## 4. Actions API Design

### 4.1 Core Actions for n8n

```typescript
// packages/api/src/routers/n8n/actions.ts
export const n8nActionsRouter = router({
  /**
   * Create Entity (Note, Task, Project)
   */
  createEntity: protectedOAuth2Procedure
    .input(
      z.object({
        type: z.enum(["note", "task", "project"]),
        data: z.record(z.any()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check scope
      if (!ctx.scopes.includes("write:entities")) {
        throw new ForbiddenError("Missing scope: write:entities");
      }

      const event = await eventService.createEvent({
        type: `${input.type}.creation.requested`,
        data: input.data,
        userId: ctx.userId,
      });

      return { eventId: event.id, status: "created" };
    }),

  /**
   * Semantic Search
   */
  searchEntities: protectedOAuth2Procedure
    .input(
      z.object({
        query: z.string(),
        type: z.enum(["note", "task", "all"]).optional(),
        limit: z.number().default(10),
      })
    )
    .query(async ({ input, ctx }) => {
      if (!ctx.scopes.includes("read:entities")) {
        throw new ForbiddenError("Missing scope: read:entities");
      }

      const embedding = await generateEmbedding(input.query);
      const results = await vectorService.searchByEmbedding({
        userId: ctx.userId,
        embedding,
        limit: input.limit,
      });

      return { results };
    }),

  /**
   * AI Analysis (🔥 Killer Feature!)
   */
  analyzeContent: protectedOAuth2Procedure
    .input(
      z.object({
        content: z.string(),
        analysisTypes: z
          .enum(["tags", "summary", "tasks", "sentiment"])
          .array(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!ctx.scopes.includes("ai:analyze")) {
        throw new ForbiddenError("Missing scope: ai:analyze");
      }

      // Call Intelligence Hub
      const insight = await intelligenceHub.analyze({
        userId: ctx.userId,
        content: input.content,
        types: input.analysisTypes,
      });

      return {
        tags: insight.analysis?.tags || [],
        summary: insight.analysis?.content || "",
        tasks: extractTasks(insight),
        sentiment: insight.metadata?.sentiment,
      };
    }),
});
```

### 4.2 REST Adapter for n8n

n8n expects REST endpoints, so we create a thin adapter:

```typescript
// packages/api/src/adapters/rest-to-trpc.ts
export function createRestAdapter(routerPath: string) {
  return async (c: Context) => {
    const method = c.req.method;
    const body = await c.req.json();

    // Call tRPC procedure
    const result = await trpcRouter[routerPath][method.toLowerCase()]({
      input: body,
      ctx: c.get("authContext"),
    });

    return c.json(result);
  };
}

// Usage in Hono
app.post("/api/n8n/entities", createRestAdapter("n8n.createEntity"));
app.post("/api/n8n/analyze", createRestAdapter("n8n.analyzeContent"));
```

---

## 5. Alignment with 3 Systems Brain

### 5.1 Mapping Integration to Brain Systems

| System                    | Role in Synap          | n8n Integration                                        |
| ------------------------- | ---------------------- | ------------------------------------------------------ |
| **Système 1: Perception** | Capture and store data | ✅ **Webhooks OUT**: n8n receives events from Data Pod |
| **Système 2: Raison**     | Process and decide     | ✅ **Actions API**: n8n calls Synap's AI for analysis  |
| **Système 3: Intuition**  | Discover patterns      | 🎯 **Future**: Agent generates n8n workflows           |

### 5.2 Evolution Path

#### Today (MVP - Week 8)

```
User manually creates n8n workflow:
"When task.completed → Analyze with Synap AI → Send Slack notification"
```

#### V2 (3-6 months) - Agent d'Automatisation

```
System 3 (Intuition) detects pattern:
"User completes 3 weekly reports every Friday 5pm"

Agent d'Automatisation proposes:
"Create automation: Weekly summary email every Friday 5pm?"

User approves → Agent generates n8n workflow JSON via API
System 2 (Raison) executes: POST /api/n8n/workflows/deploy
```

#### V3 (6-12 months) - Self-Improving OS

```
System monitors workflow performance:
"Your summary email has 90% open rate"

Agent suggests optimization:
"Add sentiment analysis to improve subject lines?"

Agent Codeur generates new Synap capability
New API endpoint auto-deployed via The Architech
```

### 5.3 Plugin Architecture

```typescript
// Future: n8n as a Data Pod plugin
export const n8nIntegrationPlugin: DataPodPlugin = {
  name: "n8n-integration",
  version: "1.0.0",
  enabled: true,

  registerRouter() {
    return n8nActionsRouter;
  },

  registerTools(toolRegistry) {
    toolRegistry.register({
      name: "generate_n8n_workflow",
      description: "Generate n8n workflow from natural language",
      execute: async ({ description }) => {
        // Agent d'Automatisation logic
        return { workflowJson };
      },
    });
  },

  async onInit() {
    await startWebhookBroker();
  },
};
```

---

## 6. Security & Risk Management

### 6.1 Security Layers

#### Layer 1: OAuth2 Authentication

- ✅ Industry-standard RFC 6749
- ✅ Short-lived tokens (15min default)
- ✅ Client secret hashing (bcrypt)
- ✅ Token introspection via Hydra

#### Layer 2: Scope-Based Authorization

```typescript
const scopes = {
  "read:entities": "Read notes, tasks, projects",
  "write:entities": "Create and update entities",
  "ai:analyze": "Use AI analysis features",
  "webhook:manage": "Create and manage webhooks",
  admin: "Full access (dangerous!)",
};
```

#### Layer 3: Rate Limiting

```typescript
// Redis-based rate limiter
const limiter = new RateLimiterRedis({
  points: 1000, // Requests
  duration: 3600, // Per hour
  blockDuration: 600, // 10min penalty
});
```

#### Layer 4: Webhook Security

- ✅ HMAC-SHA256 signature validation
- ✅ HTTPS-only URLs
- ✅ Secret rotation capability
- ✅ Delivery retry with exponential backoff

### 6.2 Risk Matrix

| Risk                   | Impact   | Likelihood | Mitigation                                         |
| ---------------------- | -------- | ---------- | -------------------------------------------------- |
| **OAuth2 Client Leak** | High     | Medium     | Short token lifetime, revocation UI, audit logs    |
| **Webhook DDoS**       | High     | Low        | HMAC validation, rate limiting, queue backpressure |
| **Data Exfiltration**  | Critical | Low        | Scope enforcement, audit all API calls, alerts     |
| **Token Replay**       | Medium   | Medium     | Token expiry, introspection check, nonce (future)  |
| **Inngest Failure**    | Medium   | Low        | Built-in retries, dead letter queue, monitoring    |

---

## 7. Implementation Roadmap

### Week 1-2: OAuth2 Foundation

**Goal**: Users can create OAuth2 clients and authenticate

| Task                                 | Owner    | Deliverable                           |
| ------------------------------------ | -------- | ------------------------------------- |
| Enable Hydra in docker-compose       | DevOps   | `docker compose --profile auth up` ✅ |
| Create `oauth2_client_owners` schema | Backend  | Migration file                        |
| Implement OAuth2 client service      | Backend  | `OAuth2ClientService`                 |
| Build OAuth2 auth middleware         | Backend  | `validateOAuth2Token()`               |
| Create management UI                 | Frontend | React components                      |
| Write integration tests              | QA       | 10+ test cases                        |

**Acceptance Criteria**:

- [ ] User can create OAuth2 client in UI
- [ ] Client credentials returned once
- [ ] API call with valid token succeeds
- [ ] Invalid/expired tokens rejected
- [ ] Scopes enforced correctly

---

### Week 3-4: Webhooks System

**Goal**: Events trigger webhooks to external URLs

| Task                      | Owner    | Deliverable             |
| ------------------------- | -------- | ----------------------- |
| Create webhook schemas    | Backend  | Migration files         |
| Implement webhook service | Backend  | `WebhookService`        |
| Build Inngest broker      | Backend  | `webhook-broker.ts`     |
| Add HMAC signature        | Security | `createSignature()`     |
| Create webhook UI         | Frontend | Subscription management |
| Test with n8n             | QA       | Live webhook test       |

**Acceptance Criteria**:

- [ ] User can create webhook subscription
- [ ] Webhook fires when event occurs
- [ ] HMAC signature validates
- [ ] Failed deliveries retry (max 3)
- [ ] Delivery log visible in UI

---

### Week 5-6: Actions API

**Goal**: n8n can call Synap actions via API

| Task                      | Owner    | Deliverable         |
| ------------------------- | -------- | ------------------- |
| Design n8n actions schema | Product  | API spec            |
| Implement tRPC router     | Backend  | `n8nActionsRouter`  |
| Build REST adapter        | Backend  | Hono middleware     |
| Add scope validation      | Security | Per-endpoint checks |
| Create API documentation  | DevRel   | OpenAPI spec        |
| Test with n8n HTTP node   | QA       | Example workflows   |

**Acceptance Criteria**:

- [ ] `createEntity` endpoint works
- [ ] `searchEntities` returns results
- [ ] `analyzeContent` calls Intelligence Hub
- [ ] Scope enforcement working
- [ ] Error messages clear

---

### Week 7-8: n8n Node Pack (Optional)

**Goal**: Official n8n community nodes for Synap

| Task                        | Owner     | Deliverable                  |
| --------------------------- | --------- | ---------------------------- |
| Create n8n credentials type | DevRel    | `SynapOAuth2.credentials.ts` |
| Build trigger node          | DevRel    | `SynapTrigger.node.ts`       |
| Build action nodes          | DevRel    | `SynapActions.node.ts`       |
| Write documentation         | DevRel    | README, examples             |
| Publish to npm              | DevOps    | `n8n-nodes-synap@1.0.0`      |
| Promote in community        | Marketing | n8n forum post               |

**Acceptance Criteria**:

- [ ] Node pack installs in n8n
- [ ] OAuth2 credentials work
- [ ] Trigger receives webhooks
- [ ] Actions call API successfully
- [ ] 5-star review from 3 beta users

---

## 8. Success Metrics

### Adoption Metrics (Month 1)

- 100 OAuth2 clients created
- 50 active webhook subscriptions
- 20 published workflows shared by community
- 10 beta users with >5 workflows each

### Engagement Metrics (Month 1-3)

- 10,000 webhook events delivered
- 5,000 API calls to `analyzeContent`
- Average 3 workflows per active user
- 70% weekly active rate for users with workflows

### Quality Metrics (Ongoing)

- < 1% webhook delivery failure rate
- < 100ms p95 API latency
- < 0.1% error rate
- Zero critical security incidents

### Business Metrics (Month 3-6)

- 20% conversion to premium (from freemium)
- 5 enterprise customers (>10 seats)
- Featured in n8n official integrations list
- 500+ npm downloads of node pack

---

## Appendix A: Dual-Track Strategy

### OAuth2 (Track A) + API Keys (Track B)

While OAuth2 is the primary approach for n8n, we may optionally add simple API keys for:

| Use Case                | Recommended Auth |
| ----------------------- | ---------------- |
| **n8n workflows**       | 🏆 OAuth2        |
| **Zapier integration**  | 🏆 OAuth2        |
| **Enterprise plugins**  | 🏆 OAuth2        |
| **Quick scripts**       | ⭐ API Keys      |
| **Webhooks (outgoing)** | ⭐ API Keys      |
| **Dev testing**         | ⭐ API Keys      |

**Implementation**: Unified middleware that accepts both:

```typescript
if (token.startsWith('ory_at_')) → OAuth2
else if (token.startsWith('sk_')) → API Key
```

---

## Appendix B: Data Pod vs Intelligence Hub

Both use the same OAuth2 infrastructure:

| Layer                        | Authentication                                   |
| ---------------------------- | ------------------------------------------------ |
| **Intelligence Hub (Cloud)** | Ory Hydra (centralized) + Better Auth (users)    |
| **Data Pod (Self-hosted)**   | Ory Hydra (self-hosted) + (optional Better Auth) |
| **Hybrid**                   | OAuth2 federation between Hub ↔ Pod              |

---

## Next Steps

**For Stakeholder Review**:

1. ✅ Review this architecture document
2. → Provide feedback on approach
3. → Approve roadmap and timeline
4. → Greenlight Sprint 1 (OAuth2 Foundation)

**Questions to Address**:

- Scope granularity: Start coarse or fine-grained from day 1?
- Rate limits: Fixed or tiered by plan?
- Webhook retry policy: Configurable per subscription?
- Multi-pod support: MVP or V2?

---

**Ready for your review and feedback!** 🚀

_Archie, CTO - "Let it learn, then it clicks with your brain."_
