# Incident Response Runbook

## Overview

This runbook provides step-by-step procedures for responding to common production incidents.

## Incident Severity Levels

- **P0 (Critical)**: Complete service outage, data loss risk
- **P1 (High)**: Partial outage, significant degradation
- **P2 (Medium)**: Minor degradation, workaround available
- **P3 (Low)**: Cosmetic issues, no user impact

## General Incident Response Process

1. **Acknowledge** the alert
2. **Assess** severity and impact
3. **Communicate** to stakeholders
4. **Mitigate** immediate impact
5. **Investigate** root cause
6. **Resolve** permanently
7. **Document** in post-mortem

---

## Scenario 1: High Error Rate

### Symptoms
- Alert: `HighErrorRate` triggered
- Dashboard shows error rate > 5%
- User reports of failures

### Diagnosis Steps

```bash
# 1. Check recent deployments
git log --oneline -10

# 2. Check API logs for errors
docker compose logs api --tail=100 | grep ERROR

# 3. Check database connectivity
psql $DATABASE_URL -c "SELECT 1;"

# 4. Check Inngest worker status
curl http://localhost:8288/api/health
```

### Mitigation

**If recent deployment:**
```bash
# Rollback to previous version
git revert HEAD
docker compose down api
docker compose up -d api
```

**If database issue:**
```bash
# Check connection pool
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"

# Restart API to reset connections
docker compose restart api
```

**If external service issue:**
- Check Hub Protocol external services
- Temporarily disable non-critical integrations

### Resolution
1. Fix root cause in code
2. Deploy fix through normal CI/CD
3. Monitor error rate returns to < 1%

---

## Scenario 2: Worker Queue Backup

### Symptoms
- Alert: `WorkerQueueBackup` triggered
- Inngest dashboard shows queue depth > 100
- Delayed event processing

### Diagnosis Steps

```bash
# 1. Check Inngest dashboard
open http://localhost:8288

# 2. Check for stuck jobs
# Look for jobs in "running" state for > 5 minutes

# 3. Check worker logs
docker compose logs jobs --tail=100

# 4. Check database load
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"
```

### Mitigation

**If workers are stuck:**
```bash
# Restart worker service
docker compose restart jobs

# Cancel stuck jobs via Inngest UI
# Navigate to http://localhost:8288 → Functions → Cancel
```

**If database is slow:**
```bash
# Check for long-running queries
psql $DATABASE_URL -c "
  SELECT pid, now() - query_start as duration, query 
  FROM pg_stat_activity 
  WHERE state = 'active' 
  ORDER BY duration DESC;
"

# Kill long-running queries if needed
psql $DATABASE_URL -c "SELECT pg_terminate_backend(<pid>);"
```

**If event storm:**
- Identify source of excessive events
- Temporarily rate-limit event emission
- Scale up worker instances

### Resolution
1. Optimize slow worker functions
2. Add database indexes if needed
3. Implement event batching/throttling
4. Scale worker capacity

---

## Scenario 3: Database Connection Failure

### Symptoms
- Alert: `DatabaseConnectionFailure` triggered
- API returns 500 errors
- Logs show "connection refused" or "too many connections"

### Diagnosis Steps

```bash
# 1. Check PostgreSQL is running
docker compose ps postgres

# 2. Check connection count
psql $DATABASE_URL -c "
  SELECT count(*) as connections, 
         max_connections 
  FROM pg_stat_activity, 
       (SELECT setting::int as max_connections FROM pg_settings WHERE name='max_connections') s;
"

# 3. Check for connection leaks
psql $DATABASE_URL -c "
  SELECT application_name, count(*) 
  FROM pg_stat_activity 
  GROUP BY application_name;
"
```

### Mitigation

**If PostgreSQL is down:**
```bash
# Restart PostgreSQL
docker compose restart postgres

# Wait for health check
docker compose ps postgres
```

**If connection pool exhausted:**
```bash
# Restart API to release connections
docker compose restart api

# Increase max_connections (temporary)
psql $DATABASE_URL -c "ALTER SYSTEM SET max_connections = 200;"
docker compose restart postgres
```

**If connection leak:**
```bash
# Kill idle connections
psql $DATABASE_URL -c "
  SELECT pg_terminate_backend(pid) 
  FROM pg_stat_activity 
  WHERE state = 'idle' 
    AND state_change < now() - interval '10 minutes';
"
```

### Resolution
1. Fix connection leaks in code
2. Optimize connection pool settings
3. Implement connection retry logic
4. Add connection pool monitoring

---

## Scenario 4: Elevated Latency

### Symptoms
- Alert: `ElevatedLatency` triggered
- Dashboard shows p95 > 500ms
- Users report slow responses

### Diagnosis Steps

```bash
# 1. Check API metrics
curl http://localhost:3000/metrics | grep api_request_duration

# 2. Check database query performance
psql $DATABASE_URL -c "
  SELECT query, calls, mean_exec_time, max_exec_time 
  FROM pg_stat_statements 
  ORDER BY mean_exec_time DESC 
  LIMIT 10;
"

# 3. Check for N+1 queries
# Review recent code changes for missing includes/joins

# 4. Check external service latency
# Review Hub Protocol request logs
```

### Mitigation

**If database slow:**
```bash
# Add missing indexes
psql $DATABASE_URL -c "
  SELECT schemaname, tablename, indexname 
  FROM pg_indexes 
  WHERE tablename = 'entities';
"

# Analyze query plans
psql $DATABASE_URL -c "EXPLAIN ANALYZE <slow_query>;"
```

**If external service slow:**
- Implement request timeouts
- Add circuit breakers
- Cache external responses

**If high load:**
```bash
# Scale API horizontally
docker compose up -d --scale api=3
```

### Resolution
1. Optimize slow queries
2. Add database indexes
3. Implement caching layer
4. Optimize N+1 queries

---

## Scenario 5: Proposal System Failure

### Symptoms
- AI entities not creating proposals
- Proposals stuck in pending state
- Global validator errors

### Diagnosis Steps

```bash
# 1. Check global validator logs
docker compose logs jobs | grep global-validator

# 2. Check proposals table
psql $DATABASE_URL -c "
  SELECT status, count(*) 
  FROM proposals 
  GROUP BY status;
"

# 3. Check Inngest events
# Navigate to http://localhost:8288 → Events
# Look for *.requested events

# 4. Check workspace settings
psql $DATABASE_URL -c "
  SELECT id, settings->>'aiAutoApprove' 
  FROM workspaces 
  LIMIT 10;
"
```

### Mitigation

**If validator not processing:**
```bash
# Restart worker
docker compose restart jobs

# Manually trigger validation
# Use Inngest UI to replay events
```

**If proposals stuck:**
```bash
# Check for database locks
psql $DATABASE_URL -c "
  SELECT * FROM pg_locks 
  WHERE NOT granted;
"

# Manually approve critical proposals
psql $DATABASE_URL -c "
  UPDATE proposals 
  SET status = 'validated' 
  WHERE id = '<proposal_id>';
"
```

### Resolution
1. Fix global validator logic
2. Add proposal timeout handling
3. Implement proposal retry mechanism
4. Add monitoring for proposal lifecycle

---

## Emergency Contacts

- **On-Call Engineer**: Check PagerDuty
- **Database Admin**: [Contact Info]
- **Infrastructure Lead**: [Contact Info]
- **Product Owner**: [Contact Info]

## Escalation Path

1. **0-15 min**: On-call engineer investigates
2. **15-30 min**: Escalate to team lead
3. **30-60 min**: Escalate to engineering manager
4. **60+ min**: Involve CTO/VP Engineering

## Post-Incident Process

1. **Create incident ticket** with timeline
2. **Schedule post-mortem** within 48 hours
3. **Document lessons learned**
4. **Create action items** to prevent recurrence
5. **Update runbook** with new insights

## Useful Commands Reference

```bash
# Check all service health
docker compose ps

# View logs for specific service
docker compose logs -f <service>

# Restart service
docker compose restart <service>

# Check database size
psql $DATABASE_URL -c "
  SELECT pg_size_pretty(pg_database_size('synap'));
"

# Check table sizes
psql $DATABASE_URL -c "
  SELECT schemaname, tablename, 
         pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) 
  FROM pg_tables 
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC 
  LIMIT 10;
"

# Export metrics
curl http://localhost:3000/metrics > metrics.txt

# Check Inngest function status
curl http://localhost:8288/api/functions
```
