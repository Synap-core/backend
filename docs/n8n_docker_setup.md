procee# n8n Integration - Getting Started

## Start n8n

```bash
# Start n8n with automation profile
docker compose --profile automation up -d n8n

# Check status
docker compose ps n8n

# View logs
docker compose logs -f n8n
```

## Access n8n UI

Open: http://localhost:5678

**First time setup:**

1. Create admin account
2. Skip tutorial (or complete it)
3. You're ready to create workflows!

## Test Webhook Connectivity

### From n8n → Synap Backend

Create a test workflow in n8n:

1. Add **HTTP Request** node
2. URL: `http://host.docker.internal:3000/healthz`
3. Method: GET
4. Execute → Should return `{"error":"Not found"}` (health endpoint doesn't exist, but connection works!)

### From Synap → n8n Webhook

Will be tested after creating the first workflow (Step 3 in main guide).

## Network Configuration

n8n runs in the `synap-network` Docker network:

- **n8n → Synap API:** Use `http://host.docker.internal:3000`
- **Synap → n8n:** Use `http://n8n:5678` (internal) or `http://localhost:5678` (external)

## Stopping n8n

```bash
# Stop n8n
docker compose stop n8n

# Remove n8n (keeps data)
docker compose down n8n

# Remove n8n AND data
docker compose down n8n && docker volume rm synap-n8n-data
```

## Troubleshooting

### Port 5678 already in use

```bash
# Find what's using it
lsof -i :5678

# Change port in docker-compose.yml
# ports:
#   - "5679:5678"  # Use 5679 instead
```

### Can't reach Synap backend from n8n

Make sure to use `host.docker.internal` instead of `localhost` in n8n HTTP nodes.

### n8n UI not loading

```bash
# Check if container is running
docker compose ps n8n

# Check logs for errors
docker compose logs n8n
```

## Next Steps

Continue with the **n8n_quickstart.md** guide:

- Step 2: Create webhook in Synap
- Step 3: Create n8n workflow
- Step 4: Test end-to-end
