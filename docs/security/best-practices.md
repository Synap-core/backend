# Security Best Practices

## Secrets Management

### Environment Variables

Never commit secrets to git. Use environment variables or secret management services.

```bash
# .env.example (commit this)
DATABASE_URL=postgresql://user:password@localhost:5432/synap
ANTHROPIC_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here

# .env (DO NOT commit)
DATABASE_URL=postgresql://prod_user:actual_password@prod-db:5432/synap
ANTHROPIC_API_KEY=sk-ant-actual-key
OPENAI_API_KEY=sk-actual-key
```

### Recommended Solutions

**Option A: HashiCorp Vault**

```bash
# Store secrets
vault kv put secret/synap/production \
  database_url="postgresql://..." \
  anthropic_key="sk-ant-..."

# Retrieve in application
export DATABASE_URL=$(vault kv get -field=database_url secret/synap/production)
```

**Option B: AWS Secrets Manager**

```bash
# Store secret
aws secretsmanager create-secret \
  --name synap/production/database \
  --secret-string '{"url":"postgresql://..."}'

# Retrieve in application
aws secretsmanager get-secret-value \
  --secret-id synap/production/database \
  --query SecretString \
  --output text
```

**Option C: Docker Secrets** (for Docker Swarm/Compose)

```yaml
# docker-compose.yml
services:
  api:
    secrets:
      - database_url
      - anthropic_key

secrets:
  database_url:
    external: true
  anthropic_key:
    external: true
```

## Authentication & Authorization

### API Key Security

```typescript
// Hash API keys before storing
import { createHash } from "crypto";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Store only hashed version
await db.insert(apiKeys).values({
  keyHash: hashApiKey(plainKey),
  // Never store plainKey
});
```

### JWT Token Security

```typescript
// Use short expiration times
const token = jwt.sign(payload, secret, {
  expiresIn: "15m", // 15 minutes
  algorithm: "HS256",
  issuer: "synap-api",
  audience: "synap-client",
});

// Implement token rotation
const refreshToken = jwt.sign(payload, refreshSecret, {
  expiresIn: "7d", // 7 days
});
```

### Row-Level Security (RLS)

```sql
-- Enable RLS on tables
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their workspace data
CREATE POLICY workspace_isolation ON entities
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace')::uuid);

-- Set workspace context in application
SET app.current_workspace = '<workspace_id>';
```

## Input Validation

### SQL Injection Prevention

```typescript
// ✅ GOOD: Use parameterized queries
const result = await db.select().from(entities).where(eq(entities.id, userId)); // Safe

// ❌ BAD: String concatenation
const result = await db.execute(
  `SELECT * FROM entities WHERE id = '${userId}'` // Vulnerable!
);
```

### XSS Prevention

```typescript
// Sanitize user input before storing
import DOMPurify from "isomorphic-dompurify";

const sanitized = DOMPurify.sanitize(userInput, {
  ALLOWED_TAGS: ["p", "br", "strong", "em"],
  ALLOWED_ATTR: [],
});
```

## Network Security

### HTTPS Only

```typescript
// Redirect HTTP to HTTPS
app.use((req, res, next) => {
  if (req.header("x-forwarded-proto") !== "https") {
    res.redirect(`https://${req.header("host")}${req.url}`);
  } else {
    next();
  }
});
```

### CORS Configuration

```typescript
import { cors } from "hono/cors";

app.use(
  "/*",
  cors({
    origin: ["https://app.synap.io", "https://staging.synap.io"],
    credentials: true,
    maxAge: 86400,
  })
);
```

### Rate Limiting

```typescript
import { rateLimiter } from "hono-rate-limiter";

app.use(
  "/*",
  rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP",
  })
);
```

## Data Encryption

### At Rest

```sql
-- Enable PostgreSQL encryption
ALTER TABLE entities
  ALTER COLUMN sensitive_data
  TYPE bytea
  USING pgp_sym_encrypt(sensitive_data, 'encryption_key');
```

### In Transit

```nginx
# nginx.conf
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers HIGH:!aNULL:!MD5;
ssl_prefer_server_ciphers on;
```

## Dependency Security

### Automated Scanning

```yaml
# .github/workflows/security.yml
- name: Run npm audit
  run: npm audit --audit-level=high

- name: Run Snyk
  uses: snyk/actions/node@master
  env:
    SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
```

### Update Policy

- **Critical vulnerabilities**: Patch within 24 hours
- **High vulnerabilities**: Patch within 7 days
- **Medium vulnerabilities**: Patch within 30 days
- **Low vulnerabilities**: Patch in next release

## Logging & Monitoring

### Sensitive Data Redaction

```typescript
import { createLogger } from "@synap-core/core";

const logger = createLogger({
  redact: ["password", "apiKey", "token", "secret"],
});

// This will automatically redact sensitive fields
logger.info({ user: { email: "user@example.com", password: "secret123" } });
// Output: { user: { email: 'user@example.com', password: '[REDACTED]' } }
```

### Audit Logging

```typescript
// Log all sensitive operations
async function deleteEntity(id: string, userId: string) {
  await auditLog.create({
    action: "entity.delete",
    userId,
    entityId: id,
    timestamp: new Date(),
    ipAddress: req.ip,
  });

  await db.delete(entities).where(eq(entities.id, id));
}
```

## Backup & Recovery

### Automated Backups

```bash
#!/bin/bash
# Daily backup script

BACKUP_DIR="/backups/synap"
DATE=$(date +%Y%m%d_%H%M%S)

# Backup database
pg_dump $DATABASE_URL | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"

# Backup to S3
aws s3 cp "$BACKUP_DIR/db_$DATE.sql.gz" \
  s3://synap-backups/production/

# Retain only last 30 days
find $BACKUP_DIR -name "db_*.sql.gz" -mtime +30 -delete
```

### Disaster Recovery Plan

**RPO (Recovery Point Objective)**: 1 hour  
**RTO (Recovery Time Objective)**: 4 hours

**Recovery Steps**:

1. Provision new infrastructure
2. Restore latest database backup
3. Replay WAL logs for point-in-time recovery
4. Restore application code from git
5. Verify data integrity
6. Switch DNS to new infrastructure

## Compliance

### GDPR Compliance

```typescript
// Right to be forgotten
async function deleteUserData(userId: string) {
  await db.transaction(async (tx) => {
    // Delete user entities
    await tx.delete(entities).where(eq(entities.userId, userId));

    // Anonymize audit logs (keep for compliance)
    await tx
      .update(auditLogs)
      .set({ userId: "ANONYMIZED" })
      .where(eq(auditLogs.userId, userId));

    // Delete user account
    await tx.delete(users).where(eq(users.id, userId));
  });
}

// Data export
async function exportUserData(userId: string) {
  const data = {
    profile: await db.select().from(users).where(eq(users.id, userId)),
    entities: await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userId)),
    // ... other data
  };

  return JSON.stringify(data, null, 2);
}
```

### Data Retention

```sql
-- Auto-delete old events (after 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_events()
RETURNS void AS $$
BEGIN
  DELETE FROM events
  WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup
SELECT cron.schedule('cleanup-events', '0 2 * * *', 'SELECT cleanup_old_events()');
```

## Security Checklist

### Pre-Production

- [ ] All secrets in environment variables/vault
- [ ] API keys hashed before storage
- [ ] HTTPS enforced
- [ ] CORS properly configured
- [ ] Rate limiting enabled
- [ ] Input validation on all endpoints
- [ ] SQL injection prevention verified
- [ ] XSS prevention verified
- [ ] Dependency vulnerabilities scanned
- [ ] Audit logging implemented

### Production

- [ ] Automated backups configured
- [ ] Disaster recovery plan tested
- [ ] Security monitoring alerts set up
- [ ] Incident response plan documented
- [ ] Regular security audits scheduled
- [ ] Penetration testing completed
- [ ] Compliance requirements met
- [ ] Security training for team completed
