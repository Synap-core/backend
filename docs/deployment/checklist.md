# Production Deployment Checklist

## Pre-Deployment

### Code Quality
- [ ] All tests passing (unit, integration, E2E)
- [ ] Code review completed and approved
- [ ] No linting errors
- [ ] Type checking passed
- [ ] Security scan completed (no critical/high vulnerabilities)
- [ ] Performance benchmarks met

### Database
- [ ] Migration scripts reviewed
- [ ] Backward compatibility verified
- [ ] Database backup created
- [ ] Migration tested in staging
- [ ] Rollback plan documented
- [ ] Index performance analyzed

### Configuration
- [ ] Environment variables documented
- [ ] Secrets rotated (if needed)
- [ ] Feature flags configured
- [ ] Rate limits reviewed
- [ ] CORS origins updated
- [ ] Logging levels set appropriately

### Infrastructure
- [ ] Resource limits configured (CPU, memory)
- [ ] Auto-scaling policies reviewed
- [ ] Load balancer health checks configured
- [ ] SSL certificates valid
- [ ] DNS records verified
- [ ] CDN cache invalidation planned

### Monitoring
- [ ] Dashboards updated
- [ ] Alerts configured
- [ ] On-call rotation scheduled
- [ ] Runbooks reviewed
- [ ] Synthetic monitoring configured
- [ ] Log aggregation working

## Deployment

### Preparation
- [ ] Announce deployment window to team
- [ ] Notify users (if downtime expected)
- [ ] Freeze non-critical deployments
- [ ] Prepare rollback commands
- [ ] Have incident response team on standby

### Execution
- [ ] Create git tag for release
- [ ] Build and tag Docker images
- [ ] Push images to registry
- [ ] Run database migrations (if any)
- [ ] Deploy to canary environment (10% traffic)
- [ ] Monitor canary for 15 minutes
- [ ] Deploy to production (rolling update)
- [ ] Verify health checks passing
- [ ] Run smoke tests

### Verification
- [ ] API health endpoint responding
- [ ] Database connections healthy
- [ ] Worker jobs processing
- [ ] Error rate < 1%
- [ ] Latency within SLO (p95 < 500ms)
- [ ] No spike in alerts
- [ ] User-facing features working

## Post-Deployment

### Monitoring (First Hour)
- [ ] Watch error rates
- [ ] Monitor latency metrics
- [ ] Check worker queue depth
- [ ] Review application logs
- [ ] Verify real-time events flowing
- [ ] Check database performance

### Validation (First 24 Hours)
- [ ] Run full E2E test suite
- [ ] Verify critical user journeys
- [ ] Check data integrity
- [ ] Review user feedback/support tickets
- [ ] Analyze performance trends
- [ ] Verify backup jobs running

### Documentation
- [ ] Update CHANGELOG.md
- [ ] Document any manual steps taken
- [ ] Update deployment runbook (if needed)
- [ ] Share deployment summary with team
- [ ] Create post-mortem (if issues occurred)

## Rollback Procedure

### When to Rollback
- Error rate > 5% for > 5 minutes
- Critical feature broken
- Data corruption detected
- Security vulnerability introduced
- Performance degradation > 50%

### Rollback Steps
```bash
# 1. Stop current deployment
kubectl rollout pause deployment/synap-api

# 2. Rollback to previous version
kubectl rollout undo deployment/synap-api

# 3. Verify rollback
kubectl rollout status deployment/synap-api

# 4. Check health
curl https://api.synap.io/health

# 5. Rollback database (if needed)
./scripts/rollback-migration.sh

# 6. Notify team
# Post in #incidents channel
```

## Emergency Hotfix Process

### Criteria
- Critical bug in production
- Security vulnerability
- Data loss risk
- Complete service outage

### Fast-Track Deployment
1. Create hotfix branch from production tag
2. Make minimal fix
3. Fast-track code review (1 approver)
4. Run critical tests only
5. Deploy directly to production
6. Monitor closely for 1 hour
7. Backport to main branch

## Release Notes Template

```markdown
# Release v1.2.3 - 2026-01-14

## 🚀 New Features
- Added proposal approval workflow
- Implemented Hub Protocol v2

## 🐛 Bug Fixes
- Fixed validation race condition
- Resolved memory leak in worker

## 🔧 Improvements
- Optimized database queries (30% faster)
- Reduced Docker image size

## ⚠️ Breaking Changes
- None

## 📊 Metrics
- Deployment time: 12 minutes
- Rollback time: N/A
- Error rate: 0.1%
- P95 latency: 320ms

## 🔗 Links
- [Full Changelog](CHANGELOG.md)
- [Migration Guide](docs/migrations/v1.2.3.md)
```

## Deployment Metrics to Track

| Metric | Target | Actual |
|--------|--------|--------|
| Deployment frequency | Daily | - |
| Lead time for changes | < 1 day | - |
| Mean time to recovery | < 1 hour | - |
| Change failure rate | < 15% | - |
| Deployment duration | < 15 min | - |
| Rollback success rate | > 95% | - |

## Sign-Off

- [ ] **Engineering Lead**: Deployment approved
- [ ] **DevOps**: Infrastructure ready
- [ ] **QA**: Testing completed
- [ ] **Product**: Features verified
- [ ] **Security**: No vulnerabilities
- [ ] **On-Call**: Ready to respond

**Deployed by**: _____________  
**Date**: _____________  
**Time**: _____________  
**Version**: _____________
