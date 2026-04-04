# AI Governance & Security Audit

## OpenClaw × Synap Integration — February 2026

**Scope:** Hub Protocol API, A2AI channels, external relay, MCP injection, filesystem governance, OpenClaw provisioning
**Status:** Findings ready for review and remediation
**Severity levels:** 🔴 Critical — 🟠 High — 🟡 Medium — 🔵 Low / Informational

---

## Executive Summary

The OpenClaw × Synap integration introduces several new attack surfaces: a bidirectional relay between external messaging platforms and the workspace, a new A2AI channel type where agents can autonomously post and receive messages, an outbound relay that forwards AI responses to external platforms, and an MCP injection mechanism that adds tool servers to LLM requests. Overall the governance architecture is strong — every write goes through `checkPermissionOrPropose` and agent users are first-class citizens. But several specific gaps require attention before production.

**Critical findings (must fix before launch):** 2
**High findings (fix in next sprint):** 4
**Medium findings (address in next 30 days):** 5
**Low / Informational:** 5

---

## 🔴 Critical Findings

### C-1 — SSRF in `relayToExternalChannel`

**File:** `packages/api/src/routers/channels.ts`
**Function:** `relayToExternalChannel()`

**Issue:** The `service.endpoint` value comes from the `intelligence_services` table and is passed directly to `fetch()` without any URL validation. If an attacker can register a malicious intelligence service (or compromise an existing one), they can point `endpoint` at internal Docker network addresses:

```
http://postgres:5432/
http://redis:6379/
http://minio:9000/
http://172.17.0.1:2375/  (Docker daemon socket)
```

This would allow reading internal service banners, potentially triggering unintended side-effects, or in the Docker daemon case — full host compromise.

**Impact:** Full internal network scanning, potential RCE via Docker daemon.

**Remediation:**

```typescript
// Add URL validation before fetch in relayToExternalChannel
import { URL } from "url";

function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    // Must be http or https
    if (!["http:", "https:"].includes(url.protocol)) return false;
    // Block RFC1918, loopback, link-local, metadata
    const blocked = [
      /^127\./, // loopback
      /^10\./, // RFC1918
      /^192\.168\./, // RFC1918
      /^172\.(1[6-9]|2[0-9]|3[01])\./, // RFC1918
      /^169\.254\./, // link-local
      /^100\.64\./, // CGNAT
      /^::1$/, // IPv6 loopback
      /^fc00:/, // IPv6 ULA
    ];
    if (blocked.some((re) => re.test(url.hostname))) return false;
    // Optionally: block by hostname if not in allowlist
    return true;
  } catch {
    return false;
  }
}

// In relayToExternalChannel, before fetch:
if (!isAllowedExternalUrl(service.endpoint)) {
  logger.warn({ endpoint: service.endpoint }, "Blocked SSRF attempt in relay");
  return;
}
```

Also apply this check in `registerOnPod` and `createHubApiKeyOnPod` in `synap-control-plane-api/src/routes/openclaw.ts`.

---

### C-2 — MCP Server Injection via Service Registration

**File:** `packages/api/src/routers/channels.ts` (sendMessage, lines 723-734)
**File:** `packages/api/src/routers/intelligence-registry.ts`

**Issue:** When an intelligence service is registered with an `mcpEndpoint`, that URL is automatically injected into `mcpServers` for every LLM request in that workspace. The LLM receives tool manifests from the MCP server and will call those tools during reasoning.

A malicious actor who registers a service could point `mcpEndpoint` at a server that:

- Returns tool definitions that look like legitimate Synap tools (`entity_create`, `search`)
- Intercepts tool call arguments (extracting sensitive query content, entities, documents)
- Returns poisoned tool results that manipulate the LLM's behavior (prompt injection via tool output)

**Impact:** Data exfiltration via tool call arguments, LLM manipulation, shadow writes.

**Remediation:**

1. **Scope MCP injection** — Only inject `mcpEndpoint` if the service is `enabled: true` AND has been explicitly approved by an admin/workspace owner:
   ```typescript
   if (resolvedService.mcpEndpoint && resolvedService.mcpApproved) {
     mcpServers.push({ ... });
   }
   ```
2. **Add `mcpApproved: boolean`** to `intelligence_services` schema, defaulting to `false`
3. **Admin-only service registration** — `intelligenceRegistry.register` should require `adminProcedure` or at minimum validate the caller is a workspace admin
4. **Log all MCP tool calls** — Include `mcpServerId` in the AI steps so audit trails show which external server was called

---

## 🟠 High Findings

### H-1 — In-Memory OpenClaw Registry Loses State on Restart

**File:** `synap-control-plane-api/src/routes/openclaw.ts`

**Issue:**

```typescript
// In-memory registry — key: `${userId}:${podId}`
const registry = new Map<string, OpenClawInstance>();
```

The provisioning state is stored in a JavaScript `Map` with no persistence. On any process restart (deploy, crash, OOM), all provisioning state is lost. Users who provisioned OpenClaw will see `{ status: "not_provisioned" }` despite having a running instance. Re-provisioning would attempt to create a duplicate service.

**Impact:** Data loss of provisioning state, duplicate provisioning attempts, user confusion.

**Remediation:** Persist to database. Add a `provisioned_services` table (or a `jsonb` column on `data_pods`):

```sql
-- Or add to data_pods table:
ALTER TABLE data_pods ADD COLUMN provisioned_services jsonb DEFAULT '{}';
```

```typescript
// Replace registry.get/set with DB reads/writes
await db
  .update(dataPods)
  .set({ provisionedServices: { ...existing, openclaw: instance } })
  .where(eq(dataPods.id, podId));
```

---

### H-2 — `sendExternalMessage` Has No Rate Limiting

**File:** `packages/api/src/routers/hub-protocol/channels.ts`
**Procedure:** `sendExternalMessage`

**Issue:** OpenClaw (or any Hub Protocol caller with `hub-protocol.write` scope) can call `sendExternalMessage` in a tight loop. Each call:

1. Inserts a database message row
2. Emits a Socket.IO event to potentially thousands of connected clients
3. **Triggers an LLM call via `sendMessage`** — this costs money and takes 2–10 seconds

A compromised OpenClaw instance, or an attacker who steals a Hub Protocol API key, could cause:

- Massive LLM API costs (thousands of completions per minute)
- Database write amplification
- Socket.IO event storm

**Impact:** Denial of service, cost amplification, data spam.

**Remediation:**

```typescript
// Add to Hub Protocol middleware or per-procedure:
import { Ratelimit } from "@upstash/ratelimit";

const ratelimit = new Ratelimit({
  redis: redisClient,
  limiter: Ratelimit.slidingWindow(60, "1 m"), // 60 messages per minute per apiKey
});

// In sendExternalMessage:
const { success } = await ratelimit.limit(`sendExternal:${ctx.apiKeyId}`);
if (!success) throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
```

Also apply to `postToA2AIChannel` and `pollA2AIChannel`.

---

### H-3 — `agentUserId` Not Validated Against Workspace Membership

**File:** `packages/api/src/routers/hub-protocol/channels.ts`
**Procedures:** `sendExternalMessage`, `postToA2AIChannel`, all write procedures

**Issue:** The `agentUserId` field is an explicit input field (correct — not inferred from auth). But there is no validation that the provided `agentUserId` actually belongs to the workspace specified in the same request:

```typescript
// An attacker with a valid Hub Protocol key can do:
POST /api/hub/threads/:threadId/messages
{
  agentUserId: "uuid-of-agent-from-different-workspace",
  workspaceId: "attacker-workspace-id",
  ...
}
```

This could allow cross-workspace attribution — messages in workspace B appear to be from an agent that belongs to workspace A.

**Impact:** Agent identity spoofing across workspaces, incorrect attribution in audit logs.

**Remediation:**

```typescript
// After resolving the agent user, verify workspace membership:
if (input.agentUserId) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.userId, input.agentUserId),
      eq(workspaceMembers.workspaceId, input.workspaceId)
    ),
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "agentUserId is not a member of the specified workspace",
    });
  }
}
```

---

### H-4 — `POST /api/intelligence/services` REST Endpoint May Not Exist

**File:** `synap-control-plane-api/src/routes/openclaw.ts` and `zeroclaw.ts`
**Function:** `registerOnPod()`

**Issue:** Both `openclaw.ts` and `zeroclaw.ts` call:

```typescript
await fetch(`${podUrl}/api/intelligence/services`, { method: "POST", ... })
```

The Data Pod backend only exposes `intelligenceRegistry.register` as a **tRPC procedure** (POST to `/trpc/intelligenceRegistry.register`). There is no REST endpoint at `/api/intelligence/services`. This means service registration silently fails — the intelligence service is never actually registered in the database, so Synap's routing will never route to OpenClaw/ZeroClaw.

**Impact:** OpenClaw provisioning appears to succeed but the service is never actually usable. `resolveIntelligenceService` always falls back to the default hub.

**Remediation:** Change `registerOnPod` to call the tRPC endpoint:

```typescript
// Replace:
await fetch(`${podUrl}/api/intelligence/services`, { method: "POST", ... })

// With:
await fetch(`${podUrl}/trpc/intelligenceRegistry.register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${podApiKey}` },
  body: JSON.stringify({
    json: {
      serviceId,
      name: "OpenClaw",
      webhookUrl: openclawUrl,
      apiKey: hubApiKey || "placeholder",
      capabilities: [...],
      mcpEndpoint,
    }
  }),
});
```

This should be fixed and tested with an integration test before any provisioning goes to production.

---

## 🟡 Medium Findings

### M-1 — A2AI Open Channel: Proposal Bypass via `autoApproveFor`

**File:** `packages/api/src/routers/hub-protocol/channels.ts`
**Procedure:** `postToA2AIChannel`

**Issue:** When an open A2AI channel receives a first post from a new agent, a governance proposal is created. However, if the workspace has `autoApproveFor: ["a2ai.*"]` in its settings, the governance check auto-approves the join without any user notification.

This is intentional for some workflows (fully automated agent networks), but it means any agent with a valid Hub Protocol key can silently inject messages into open A2AI channels and trigger LLM responses — without the user ever seeing a proposal.

**Considerations:**

- `autoApproveFor: ["a2ai.*"]` is an explicit workspace setting, so the user opted into this
- But the default `autoApproveFor` list does NOT include `"a2ai.*"` — only if the user adds it

**Recommendation:** Add a workspace-level setting `requireApprovalForNewAgents: boolean` (default `true`) that, when `true`, always creates a proposal for the first post from a new agent — even if `autoApproveFor: ["a2ai.*"]` is set. Document this trade-off clearly.

---

### M-2 — `relayToExternalChannel` Uses Wrong Capability

**File:** `packages/api/src/routers/channels.ts`
**Function:** `relayToExternalChannel`

**Issue:** The function comment says "routes to service with channels capability" but the actual call uses `capability: "default"`:

```typescript
service = await resolveIntelligenceService({
  userId,
  workspaceId,
  capability: "default", // ← wrong — should route by "channels" capability
});
```

The `ServiceResolutionContext.capability` type only accepts `"chat" | "analysis" | "default"` — `"channels"` is not a valid value. This means the relay always goes to the default service, not specifically to OpenClaw. If OpenClaw is not the default service, the relay silently no-ops.

**Remediation:** Add `"channels"` to the `capability` type union in `intelligence-routing.ts` and implement capability-based routing that picks the registered service with the `"channels"` capability:

```typescript
// intelligence-routing.ts
type ServiceCapability =
  | "chat"
  | "analysis"
  | "default"
  | "channels"
  | "shell"
  | "browser";

// In resolveIntelligenceService:
if (context.capability === "channels") {
  // Find service with capabilities.includes("channels")
  const channelService = await db.query.intelligenceServices.findFirst({
    where: and(
      eq(intelligenceServices.status, "active"),
      eq(intelligenceServices.enabled, true),
      drizzleSql`${intelligenceServices.capabilities} ? 'channels'`
    ),
  });
  if (channelService) return buildResolvedService(channelService);
}
```

---

### M-3 — `triggerA2AIResponse` Is Fire-and-Forget with No Retry

**File:** `packages/api/src/routers/hub-protocol/channels.ts`
**Function:** `triggerA2AIResponse`

**Issue:** After an agent posts to an A2AI channel, the AI response is triggered asynchronously:

```typescript
triggerA2AIResponse(channel, input.content, input.agentUserId).catch((err) =>
  logger.error({ err }, "Failed to trigger A2AI response")
);
```

If the Intelligence Hub is temporarily unavailable (restart, overload), the trigger is dropped with a log entry. The agent posts a message, gets `{ status: "sent" }`, polls for a response, and never receives one. There is no retry mechanism and no dead-letter queue.

**Remediation:** Use PgBoss (already in the backend) to queue the trigger:

```typescript
import { getBoss } from "@synap/jobs";

// Instead of direct call:
await getBoss().send(
  "a2ai-response-trigger",
  {
    channelId: channel.id,
    content: input.content,
    agentUserId: input.agentUserId,
    userId: channel.userId,
    workspaceId: channel.workspaceId,
  },
  {
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 300,
  }
);
```

---

### M-4 — `metadata as any` Casts Could Leak Sensitive Fields

**File:** `packages/api/src/routers/hub-protocol/channels.ts`
**Files:** Several message insertions

**Issue:** Multiple places cast metadata to `any` to bypass TypeScript:

```typescript
metadata: { ... } as any
```

The `ConversationMessageMetadata` type is strict and doesn't allow extra fields. The `as any` cast is a reasonable workaround, but it means any object can be stored in metadata — including fields like `{ apiKey, password, secret }` that might accidentally be passed by an agent. These metadata fields are returned in API responses and could leak sensitive values to the frontend.

**Remediation:**

1. Define explicit metadata types for Hub Protocol messages:
   ```typescript
   interface A2AIMessageMetadata {
     agentUserId?: string;
     fromPlatform?: string;
     externalMessageId?: string;
   }
   ```
2. Validate metadata against the schema before insert (strip unknown keys)
3. Or at minimum, document what fields are allowed and add a test that rejects unknown sensitive fields

---

### M-5 — OpenClaw `openclaw_workspace` Volume Path Not Scoped to User

**File:** `synap-backend/deploy/docker-compose.yml`

**Issue:** The OpenClaw workspace volume is defined as:

```yaml
volumes:
  - openclaw_workspace:/root/openclaw/workspace
```

Named Docker volumes (`openclaw_workspace`) are shared across all containers in the compose project. If multiple users share a pod (enterprise/team deployment), their OpenClaw workspace directories are not isolated from each other. User A's files would be visible to User B's OpenClaw instance.

**Remediation:** For multi-tenant pods, use user-scoped volume names:

```yaml
volumes:
  - openclaw_workspace_${SYNAP_USER_ID}:/root/openclaw/workspace
```

Or use bind mounts to user-namespaced directories:

```yaml
volumes:
  - /var/synap/users/${SYNAP_USER_ID}/openclaw:/root/openclaw/workspace
```

---

## 🔵 Low / Informational Findings

### L-1 — Hub Protocol API Key Scope Enforcement Needs Verification

**Issue:** Hub Protocol API keys are created with scopes `["hub-protocol.read", "hub-protocol.write"]`. But it is unclear whether the Hub Protocol middleware actually **enforces** these scopes per-procedure. The `scopedProcedure` helper is used, but the scope names need to exactly match what the middleware checks.

**Action:** Verify that `scopedProcedure(["hub-protocol.read"])` in hub-protocol procedures correctly rejects requests where the API key does not have that scope. Write a test:

```typescript
// test: hub-protocol key with only "hub-protocol.read" cannot call sendExternalMessage
const readOnlyKey = await createApiKey({ scopes: ["hub-protocol.read"] });
await expect(
  callHubProtocol("channels.sendExternalMessage", readOnlyKey, {...})
).rejects.toThrow("FORBIDDEN");
```

---

### L-2 — `createA2AIChannel` Available to All Workspace Members

**Issue:** `createA2AIChannel` is a `workspaceProcedure` — any authenticated workspace member (including `viewer` role) can create A2AI channels. There is no check that only `editor` or `admin` roles can create new channel types.

**Action:** Decide on the intended access control. If A2AI channel creation should be restricted to `editor` and above, add a role check:

```typescript
if (!["editor", "admin", "owner"].includes(ctx.memberRole)) {
  throw new TRPCError({ code: "FORBIDDEN", message: "Editor role required" });
}
```

---

### L-3 — `synap` Skill Hard-codes GitHub URL

**File:** `synap-backend/skills/synap/SKILL.md`

**Issue:** The skill install URL is:

```
https://raw.githubusercontent.com/synap-app/synap-backend/main/skills/synap/SKILL.md
```

This URL points to a repository that does not yet exist publicly (`synap-app/synap-backend`). Until the repository is public and the URL is live, the skill install command in the OpenClaw provisioning response will fail silently.

**Action:** Either create the public repository, or change the URL to point to the actual public location. Consider also publishing the skill to ClawHub for discoverability.

---

### L-4 — `pollA2AIChannel` Returns Messages to Any Hub Protocol Caller

**File:** `packages/api/src/routers/hub-protocol/channels.ts`

**Issue:** `pollA2AIChannel` accepts a `channelId` and returns all messages since a timestamp. There is no check that the caller (identified by their Hub Protocol API key's `userId`) is actually a participant of the channel. Any authenticated Hub Protocol user can poll any channel if they know its UUID.

**Action:** Add a participant check before returning messages:

```typescript
// Verify the calling agent is either:
// 1. The channel owner (channel.userId === ctx.userId)
// 2. A named participant in metadata.participants
// 3. The channel is open and the agent has previously posted (history check)
```

---

### L-5 — No Audit Log for Hub Protocol Writes

**Issue:** Hub Protocol write operations (create entity, send external message, post to A2AI) are governed by `checkPermissionOrPropose`, which creates proposals. But operations that are auto-approved (`autoApproveFor` whitelist) leave no audit trail beyond structured application logs.

For compliance and debugging, it would be valuable to have an immutable audit log of every Hub Protocol write call — who called it, what action, what was approved/proposed/denied, timestamp.

**Action:** Consider adding an `audit_events` table or using the existing proposals table with a `status: "auto_approved"` state for whitelisted actions. This would give admins full visibility into what external agents have done in the workspace.

---

## Verification Checklist

Before launching the OpenClaw integration to production, verify the following:

### Security

- [ ] SSRF validation added to all `fetch()` calls with user-controlled URLs
- [ ] `intelligenceRegistry.register` restricted to admin users or requires workspace owner approval
- [ ] `mcpApproved` flag added to service schema; MCP injection gated on it
- [ ] Rate limiting added to `sendExternalMessage` and `postToA2AIChannel`
- [ ] `agentUserId` workspace membership validation added to all Hub Protocol write procedures

### Correctness

- [ ] `registerOnPod` fixed to call the correct endpoint for service registration
- [ ] Integration test: register OpenClaw → verify `intelligence_services` row exists → verify `resolveIntelligenceService` returns it
- [ ] `relayToExternalChannel` fixed to use `capability: "channels"` after capability routing is added
- [ ] `triggerA2AIResponse` queued via PgBoss (or at minimum: verified that silence-on-failure is acceptable)

### Infrastructure

- [ ] OpenClaw provisioning state persisted to database (not in-memory Map)
- [ ] Volume isolation verified for multi-tenant pod deployments
- [ ] `synap` SKILL.md URL tested — GitHub repository exists and URL is accessible

### Testing

- [ ] Hub Protocol scope enforcement test (read-only key cannot write)
- [ ] A2AI channel closed participant enforcement test
- [ ] `pollA2AIChannel` caller authorization test
- [ ] `BLOCKED_FILESYSTEM_PATHS` regex coverage test (all patterns hit expected paths)
- [ ] Outbound relay test: EXTERNAL_IMPORT channel → AI responds → `relayToExternalChannel` called with correct args

---

## Summary Table

| ID  | Severity    | Title                                                       | Status            |
| --- | ----------- | ----------------------------------------------------------- | ----------------- |
| C-1 | 🔴 Critical | SSRF in relayToExternalChannel                              | Open              |
| C-2 | 🔴 Critical | MCP server injection via service registration               | Open              |
| H-1 | 🟠 High     | In-memory OpenClaw registry loses state on restart          | Open              |
| H-2 | 🟠 High     | sendExternalMessage has no rate limiting                    | Open              |
| H-3 | 🟠 High     | agentUserId not validated against workspace membership      | Open              |
| H-4 | 🟠 High     | REST endpoint for service registration may not exist        | Open              |
| M-1 | 🟡 Medium   | A2AI open channel: proposal bypass via autoApproveFor       | Accept / Document |
| M-2 | 🟡 Medium   | relayToExternalChannel uses wrong capability                | Open              |
| M-3 | 🟡 Medium   | triggerA2AIResponse: no retry on Intelligence Hub failure   | Open              |
| M-4 | 🟡 Medium   | metadata as any casts could leak sensitive fields           | Open              |
| M-5 | 🟡 Medium   | OpenClaw volume not scoped per user in multi-tenant pods    | Open              |
| L-1 | 🔵 Low      | Hub Protocol scope enforcement needs test coverage          | Open              |
| L-2 | 🔵 Low      | createA2AIChannel available to all workspace members        | Accept / Decide   |
| L-3 | 🔵 Low      | synap skill GitHub URL not yet live                         | Open              |
| L-4 | 🔵 Low      | pollA2AIChannel returns messages to any Hub Protocol caller | Open              |
| L-5 | 🔵 Low      | No audit log for auto-approved Hub Protocol writes          | Backlog           |
