# Production SLOs and SLIs

## Service Level Objectives

### API Service

| SLI | Target | Measurement Window |
|-----|--------|-------------------|
| **Availability** | 99.9% | 30 days |
| **Request Latency (p95)** | < 500ms | 5 minutes |
| **Request Latency (p99)** | < 1000ms | 5 minutes |
| **Error Rate** | < 1% | 5 minutes |

### Worker Service (Inngest)

| SLI | Target | Measurement Window |
|-----|--------|-------------------|
| **Job Success Rate** | > 99% | 1 hour |
| **Job Processing Time (p95)** | < 5s | 5 minutes |
| **Queue Depth** | < 100 | 1 minute |

### Database

| SLI | Target | Measurement Window |
|-----|--------|-------------------|
| **Query Latency (p95)** | < 100ms | 5 minutes |
| **Connection Pool Utilization** | < 80% | 1 minute |
| **Replication Lag** | < 1s | 1 minute |

### Hub Protocol

| SLI | Target | Measurement Window |
|-----|--------|-------------------|
| **Token Generation** | < 200ms | 5 minutes |
| **Data Query Latency (p95)** | < 1s | 5 minutes |

## Alert Definitions

### Critical Alerts (Page immediately)

```yaml
# High Error Rate
- alert: HighErrorRate
  expr: rate(synap_api_error_total[5m]) > 0.05
  for: 2m
  severity: critical
  message: "API error rate above 5% for 2 minutes"

# Service Down
- alert: ServiceDown
  expr: up{job="synap-api"} == 0
  for: 1m
  severity: critical
  message: "API service is down"

# Database Connection Failure
- alert: DatabaseConnectionFailure
  expr: synap_db_connection_pool_size == 0
  for: 1m
  severity: critical
  message: "No database connections available"
```

### Warning Alerts (Investigate within 15 min)

```yaml
# Elevated Latency
- alert: ElevatedLatency
  expr: histogram_quantile(0.95, synap_api_request_duration_ms) > 500
  for: 5m
  severity: warning
  message: "API p95 latency above 500ms"

# Worker Queue Backup
- alert: WorkerQueueBackup
  expr: synap_worker_queue_depth > 100
  for: 5m
  severity: warning
  message: "Worker queue depth above 100"

# High Memory Usage
- alert: HighMemoryUsage
  expr: process_resident_memory_bytes / 1024 / 1024 > 1024
  for: 5m
  severity: warning
  message: "Process memory usage above 1GB"
```

## Dashboards

### Main Overview Dashboard

**Panels:**
1. **Request Rate** (requests/sec)
2. **Error Rate** (%)
3. **Latency Distribution** (p50, p95, p99)
4. **Active Connections**
5. **Worker Queue Depth**
6. **Database Query Performance**

### Validation Flow Dashboard

**Panels:**
1. **Validation Results** (approved/denied/proposal)
2. **Validation Duration**
3. **Proposal Approval Rate**
4. **Permission Denials**

### Hub Protocol Dashboard

**Panels:**
1. **Token Generation Rate**
2. **External Service Requests**
3. **Hub Protocol Latency**
4. **Proposal Creation from External Services**

## Metrics Collection

### API Instrumentation

```typescript
// In tRPC middleware
import { metrics, MetricNames } from '@synap-core/core';

export const metricsMiddleware = t.middleware(async ({ path, type, next }) => {
  const start = Date.now();
  
  try {
    const result = await next();
    const duration = Date.now() - start;
    
    metrics.histogram(MetricNames.API_REQUEST_DURATION, duration, {
      path,
      type,
      status: 'success'
    });
    
    metrics.increment(MetricNames.API_REQUEST_COUNT, 1, {
      path,
      type,
      status: 'success'
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    
    metrics.histogram(MetricNames.API_REQUEST_DURATION, duration, {
      path,
      type,
      status: 'error'
    });
    
    metrics.increment(MetricNames.API_ERROR_COUNT, 1, {
      path,
      type
    });
    
    throw error;
  }
});
```

### Worker Instrumentation

```typescript
// In Inngest functions
import { metrics, MetricNames } from '@synap-core/core';

export const globalValidator = inngest.createFunction(
  { id: 'global-validator' },
  { event: '*.*.requested' },
  async ({ event, step }) => {
    const start = Date.now();
    
    try {
      // ... validation logic
      
      const duration = Date.now() - start;
      metrics.histogram(MetricNames.VALIDATION_DURATION, duration);
      metrics.increment(MetricNames.VALIDATION_RESULT, 1, {
        result: 'approved' // or 'denied', 'proposal'
      });
      
      return result;
    } catch (error) {
      metrics.increment(MetricNames.WORKER_ERROR_RATE, 1, {
        function: 'global-validator'
      });
      throw error;
    }
  }
);
```

## Monitoring Best Practices

1. **Use RED Method** (Rate, Errors, Duration) for services
2. **Use USE Method** (Utilization, Saturation, Errors) for resources
3. **Set up synthetic monitoring** for critical user journeys
4. **Track business metrics** alongside technical metrics
5. **Review and adjust SLOs quarterly** based on actual performance
