# Real-Time Features - Needs Analysis

> **Status:** Draft - Requires Validation  
> **Created:** 2025-12-03  
> **Purpose:** Define real-time feature requirements before implementation

---

## 🎯 Goal

Determine the actual real-time requirements for Synap to make informed architectural decisions before implementing WebSocket/SSE/polling solutions.

---

## 📋 Core Questions to Answer

### 1. **Who needs real-time updates?**

- [ ] **Web Applications** (Browser-based clients)
  - What: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Why: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Critical or nice-to-have? **\*\***\_\_\_**\*\***

- [ ] **Background Workers** (Inside pods)
  - What: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Why: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Critical or nice-to-have? **\*\***\_\_\_**\*\***

- [ ] **Pod-to-Pod Communication**
  - What: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Why: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Critical or nice-to-have? **\*\***\_\_\_**\*\***

- [ ] **External Systems** (IoT devices, integrations)
  - What: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Why: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Critical or nice-to-have? **\*\***\_\_\_**\*\***

- [ ] **Multi-User Collaboration**
  - What: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Why: **\*\*\*\***\*\***\*\*\*\***\_**\*\*\*\***\*\***\*\*\*\***
  - Critical or nice-to-have? **\*\***\_\_\_**\*\***

### 2. **What data needs to be real-time?**

- [ ] **Event Notifications**
  - Examples: **\*\***\*\*\*\***\*\***\_**\*\***\*\*\*\***\*\***
  - Latency requirement: < **\_** ms/seconds

- [ ] **State Synchronization**
  - Examples: **\*\***\*\*\*\***\*\***\_**\*\***\*\*\*\***\*\***
  - Latency requirement: < **\_** ms/seconds

- [ ] **Live Collaboration**
  - Examples: **\*\***\*\*\*\***\*\***\_**\*\***\*\*\*\***\*\***
  - Latency requirement: < **\_** ms/seconds

- [ ] **Progress Updates**
  - Examples: **\*\***\*\*\*\***\*\***\_**\*\***\*\*\*\***\*\***
  - Latency requirement: < **\_** ms/seconds

- [ ] **Alerts/Notifications**
  - Examples: **\*\***\*\*\*\***\*\***\_**\*\***\*\*\*\***\*\***
  - Latency requirement: < **\_** ms/seconds

### 3. **Communication Patterns**

- [ ] **Server → Client** (One-way broadcast)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

- [ ] **Client → Server** (One-way submission)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

- [ ] **Bidirectional** (Request/Response + Push)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

- [ ] **Multi-User Broadcast** (Server → Many Clients)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

### 4. **Scale and Volume**

**Current Expected Volume:**

- Concurrent connections per user: \***\*\_\*\***
- Concurrent users: \***\*\_\*\***
- Messages per second (peak): \***\*\_\*\***
- Message size (average): \***\*\_\*\*** KB

**Future Expected Volume (12 months):**

- Concurrent connections per user: \***\*\_\*\***
- Concurrent users: \***\*\_\*\***
- Messages per second (peak): \***\*\_\*\***
- Message size (average): \***\*\_\*\*** KB

### 5. **Reliability Requirements**

- [ ] **Guaranteed Delivery** (Messages must not be lost)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

- [ ] **Best Effort** (OK to lose some messages)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

- [ ] **Ordered Delivery** (Messages must arrive in order)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

- [ ] **Replay/History** (Need to catch up missed messages)
  - Use cases: **\*\***\*\***\*\***\_\_\_\_**\*\***\*\***\*\***

---

## 🔍 Current Architecture Context

**Deployment Model:** Pod-per-user (single isolated pod per user)

**Current Components:**

- PostgreSQL + TimescaleDB (events, time-series)
- Inngest (background jobs, async processing)
- MinIO (file storage)
- Ory (authentication)

**Question:** Do we already have implicit real-time via:

- [ ] Polling (client periodically checks for updates)
- [ ] Inngest job completion callbacks
- [ ] Other mechanism: \***\*\*\*\*\*\*\***\_\_\_\***\*\*\*\*\*\*\***

---

## 💡 Specific Use Case Analysis

### Use Case 1: **\*\***\*\***\*\***\_**\*\***\*\***\*\***

**Description:**

---

---

**Real-time requirement:** [ ] Critical [ ] Nice-to-have [ ] Not needed

**Acceptable latency:** \_\_\_\_ ms/seconds

**Communication pattern:** [ ] Server→Client [ ] Client→Server [ ] Bidirectional

**Reliability:** [ ] Guaranteed [ ] Best effort

**Current workaround (if any):**

---

---

### Use Case 2: **\*\***\*\***\*\***\_**\*\***\*\***\*\***

**Description:**

---

---

**Real-time requirement:** [ ] Critical [ ] Nice-to-have [ ] Not needed

**Acceptable latency:** \_\_\_\_ ms/seconds

**Communication pattern:** [ ] Server→Client [ ] Client→Server [ ] Bidirectional

**Reliability:** [ ] Guaranteed [ ] Best effort

**Current workaround (if any):**

---

---

### Use Case 3: **\*\***\*\***\*\***\_**\*\***\*\***\*\***

**Description:**

---

---

**Real-time requirement:** [ ] Critical [ ] Nice-to-have [ ] Not needed

**Acceptable latency:** \_\_\_\_ ms/seconds

**Communication pattern:** [ ] Server→Client [ ] Client→Server [ ] Bidirectional

**Reliability:** [ ] Guaranteed [ ] Best effort

**Current workaround (if any):**

---

---

## 🚀 Recommended Solutions (Based on Research)

### If Real-Time is **Nice-to-Have** or **Low Volume**

**Recommendation:** Server-Sent Events (SSE)

**Why:**

- ✅ Simple HTTP-based (no WebSocket complexity)
- ✅ Auto-reconnection built-in
- ✅ Perfect for server→client notifications
- ✅ Works with pod-per-user architecture
- ✅ ~100KB/sec throughput sufficient for most cases

**When to use:**

- Notifications, status updates, progress bars
- < 100 messages/second
- Unidirectional (server→client)

---

### If Real-Time is **Critical** and **High Volume**

**Recommendation:** WebSocket (`ws` library)

**Why:**

- ✅ Lowest latency (<20ms)
- ✅ Bidirectional communication
- ✅ 50,000+ concurrent connections/pod
- ✅ Perfect for collaboration, chat, live updates
- ✅ Full control over implementation

**When to use:**

- Chat, collaboration, real-time dashboards
- > 100 messages/second
- Bidirectional or high-frequency updates

---

### If Real-Time is **Not Needed**

**Recommendation:** Smart Polling or Webhook Events

**Why:**

- ✅ Simplest implementation
- ✅ No persistent connections
- ✅ Works everywhere
- ✅ Leverage existing Inngest jobs

**When to use:**

- Background processing results
- Occasional status checks
- Non-time-critical updates

---

## 📊 Decision Matrix

| Requirement                      | Solution                  | Complexity | Latency | Cost   |
| -------------------------------- | ------------------------- | ---------- | ------- | ------ |
| Server→Client notifications      | SSE                       | Low        | Medium  | Low    |
| Bidirectional chat/collaboration | WebSocket                 | Medium     | Lowest  | Medium |
| Background job updates           | Polling + Inngest         | Lowest     | High    | Lowest |
| Real-time analytics              | WebSocket + LISTEN/NOTIFY | High       | Lowest  | Medium |

---

## ✅ Action Items

1. [ ] Fill out "Core Questions" section above
2. [ ] Document 3-5 specific use cases
3. [ ] Validate requirements with team/stakeholders
4. [ ] Choose solution based on decision matrix
5. [ ] Create implementation plan (if needed)
6. [ ] Update architecture diagrams

---

## 📝 Notes & Observations

_Add any additional context, constraints, or observations here:_

---

---

---

---

## 🔗 Related Documents

- [Real-Time WebSocket Research](/.gemini/antigravity/brain/.../realtime_websocket_research.md) - Technical deep dive
- [Pure PostgreSQL Migration](/.gemini/antigravity/brain/.../walkthrough.md) - Current database setup
- _Add other relevant docs here_
