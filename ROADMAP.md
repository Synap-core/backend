# 🗺️ Synap Backend - Roadmap

**Version**: 1.0.0  
**Last Updated**: 2025-01-17

---

## 🎯 Current Status (v0.5+)

### ✅ Completed - Event-Driven Architecture Foundation

**Phase 1: Event Store Foundation** ✅
- ✅ SynapEvent schema (Zod v1) with validation
- ✅ EventRepository with TimescaleDB (hypertable)
- ✅ Performance validated (100K+ events/second)
- ✅ @synap/types package created

**Phase 2: Worker Layer** ✅
- ✅ IEventHandler interface
- ✅ EventDispatcher (central Inngest function)
- ✅ NoteCreationHandler (note.creation.requested)
- ✅ EmbeddingGeneratorHandler (note.creation.completed)

**Phase 3: Projection Layer** ✅
- ✅ Hybrid storage validated (PostgreSQL + R2/MinIO)
- ✅ Schema audit (no large content in DB)
- ✅ Handlers use storage abstraction
- ✅ Content separation (metadata vs files)

**Phase 4: CQRS API Layer** ✅
- ✅ Command API (mutations publish events, return pending)
- ✅ Query API (reads from projections, fast)
- ✅ RLS security (PostgreSQL Row-Level Security)
- ✅ Better Auth integration

**Infrastructure** ✅
- ✅ Multi-dialect database support (SQLite + PostgreSQL)
- ✅ Hybrid storage (R2 + MinIO)
- ✅ Multi-user support (PostgreSQL + Better Auth)
- ✅ Single-user support (SQLite + Simple Auth)
- ✅ Conversational AI interface
- ✅ Semantic search (RAG with pgvector)
- ✅ Type-safe API (tRPC)
- ✅ Background jobs (Inngest)
- ✅ Code consolidation
- ✅ Documentation consolidation

---

## 🚀 Phase 1: Dual-Access Foundation (Q1 2025)

### Goal
Enable users to access both local and company/community content simultaneously.

### Tasks

#### 1.1 Schema Updates
- [ ] Add `context` column to PostgreSQL entities table
- [ ] Add `context` column to PostgreSQL events table
- [ ] Add `company_id` column for company context
- [ ] Create migration scripts
- [ ] Update TypeScript types

**Estimated**: 2-3 days

#### 1.2 Context Management
- [ ] Create `ContextManager` service
- [ ] Implement context detection from headers
- [ ] Add context validation
- [ ] Update API context creation

**Estimated**: 2-3 days

#### 1.3 Storage Path Updates
- [ ] Update storage path builder for context
- [ ] Add context prefix to storage paths
- [ ] Update R2/MinIO providers
- [ ] Test path isolation

**Estimated**: 1-2 days

#### 1.4 API Updates
- [ ] Add `X-Context` header support
- [ ] Update all endpoints to handle context
- [ ] Add context to response metadata
- [ ] Update tRPC procedures

**Estimated**: 3-4 days

#### 1.5 Testing
- [ ] Unit tests for context switching
- [ ] Integration tests for dual-access
- [ ] E2E tests for unified operations
- [ ] Isolation tests

**Estimated**: 2-3 days

**Total Phase 1**: ~2-3 weeks

---

## 🚀 Phase 2: Unified Operations (Q2 2025)

### Goal
Enable seamless cross-context operations (search, sync, etc.)

### Tasks

#### 2.1 Cross-Context Search
- [ ] Unified search endpoint
- [ ] Merge results from both contexts
- [ ] Context-aware ranking
- [ ] Performance optimization

**Estimated**: 3-4 days

#### 2.2 Unified API Responses
- [ ] Standardize response format
- [ ] Add context metadata
- [ ] Update all endpoints
- [ ] Client SDK updates

**Estimated**: 2-3 days

#### 2.3 Context-Aware Permissions
- [ ] Permission system per context
- [ ] Company role management
- [ ] Sharing permissions
- [ ] Access control

**Estimated**: 4-5 days

#### 2.4 Sync Capabilities
- [ ] Local → Company sync (optional)
- [ ] Company → Local export
- [ ] Conflict resolution
- [ ] Sync status tracking

**Estimated**: 5-7 days

**Total Phase 2**: ~3-4 weeks

---

## 🚀 Phase 3: Advanced Features (Q3 2025)

### Goal
Enhanced features for SaaS and enterprise use

### Tasks

#### 3.1 Team Workspaces
- [ ] Workspace management
- [ ] Team member roles
- [ ] Workspace-level permissions
- [ ] Workspace search

**Estimated**: 2-3 weeks

#### 3.2 Real-Time Features
- [ ] WebSocket support
- [ ] Real-time updates
- [ ] Collaborative editing
- [ ] Presence indicators

**Estimated**: 2-3 weeks

#### 3.3 Advanced Search
- [ ] Multi-context filters
- [ ] Advanced query syntax
- [ ] Search analytics
- [ ] Saved searches

**Estimated**: 1-2 weeks

#### 3.4 Mobile Optimizations
- [ ] Mobile API endpoints
- [ ] Offline support
- [ ] Sync strategies
- [ ] Performance tuning

**Estimated**: 2-3 weeks

**Total Phase 3**: ~8-12 weeks

---

## 🚀 Phase 4: Enterprise Features (Q4 2025)

### Goal
Enterprise-grade features for large organizations

### Tasks

#### 4.1 SSO Integration
- [ ] SAML support
- [ ] OIDC support
- [ ] LDAP integration
- [ ] SSO configuration UI

**Estimated**: 3-4 weeks

#### 4.2 Audit & Compliance
- [ ] Audit logging
- [ ] Compliance reports
- [ ] Data retention policies
- [ ] GDPR compliance

**Estimated**: 2-3 weeks

#### 4.3 Advanced Analytics
- [ ] Usage analytics
- [ ] Content analytics
- [ ] User behavior tracking
- [ ] Custom dashboards

**Estimated**: 2-3 weeks

#### 4.4 Enterprise Admin
- [ ] Admin dashboard
- [ ] User management
- [ ] Content moderation
- [ ] System configuration

**Estimated**: 3-4 weeks

**Total Phase 4**: ~10-14 weeks

---

## 📊 Priority Matrix

### High Priority (Must Have)
1. ✅ Dual-access foundation (Phase 1)
2. ⏳ Unified search (Phase 2.1)
3. ⏳ Context-aware permissions (Phase 2.3)

### Medium Priority (Should Have)
1. ⏳ Cross-context sync (Phase 2.4)
2. ⏳ Team workspaces (Phase 3.1)
3. ⏳ Real-time features (Phase 3.2)

### Low Priority (Nice to Have)
1. ⏳ Advanced analytics (Phase 4.3)
2. ⏳ Enterprise admin (Phase 4.4)
3. ⏳ Mobile optimizations (Phase 3.4)

---

## 🎯 Success Criteria

### Phase 1 Success
- ✅ Users can switch between local and company contexts
- ✅ Data isolation verified (no leakage)
- ✅ All existing features work with context switching
- ✅ Performance: <200ms context switch latency

### Phase 2 Success
- ✅ Unified search works across contexts
- ✅ Response format standardized
- ✅ Sync capabilities functional
- ✅ Performance: <500ms cross-context search

### Phase 3 Success
- ✅ Team workspaces operational
- ✅ Real-time updates working
- ✅ Mobile apps functional
- ✅ User satisfaction: >80% positive feedback

### Phase 4 Success
- ✅ Enterprise features deployed
- ✅ Compliance requirements met
- ✅ Admin tools functional
- ✅ Enterprise customers onboarded

---

## 🔄 Release Schedule

### v0.5.0 - Dual-Access Foundation (Q1 2025)
- Phase 1 complete
- Basic context switching
- Schema updates

### v0.6.0 - Unified Operations (Q2 2025)
- Phase 2 complete
- Cross-context search
- Unified API

### v1.0.0 - Production Ready (Q3 2025)
- Phase 3 complete
- Team workspaces
- Real-time features

### v1.5.0 - Enterprise (Q4 2025)
- Phase 4 complete
- Enterprise features
- SSO integration

---

## 📝 Notes

### Technical Debt
- [ ] Migrate from application-level filtering to database RLS (Supabase)
- [ ] Optimize vector search performance
- [ ] Improve error handling consistency
- [ ] Expand test coverage

### Research Areas
- [ ] GraphQL API option
- [ ] Edge computing support
- [ ] Blockchain for audit trail
- [ ] Federated search

---

**Questions?** Open an issue or contact the team.

**Next**: See [PRD.md](./PRD.md) for detailed requirements.

