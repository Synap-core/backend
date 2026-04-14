# RSS Feed Provider Setup Guide

This guide explains how to configure RSS feed aggregation in Synap using different provider options.

## Overview

Synap supports multiple RSS feed provider backends:

| Provider  | Description                           | Best For                                      |
| --------- | ------------------------------------- | --------------------------------------------- |
| `direct`  | Fetch RSS feeds directly from sources | Simple setups, few feeds                      |
| `rsshub`  | Self-hosted RSSHub instance           | Full control, many feeds, rate limit handling |
| `cpproxy` | Control Plane RSSHub proxy            | Managed pods (default)                        |
| `custom`  | External RSSHub instance              | Using existing RSSHub deployment              |

## Quick Start

### Default Configuration (Control Plane Proxy)

For Synap-managed pods, the default `cpproxy` provider works out of the box:

```bash
# In your .env file (already set by default)
RSS_PROVIDER_TYPE=cpproxy
CP_RSSHUB_PROXY_URL=https://api.synap.live/api/rsshub-proxy
```

### Self-Hosted RSSHub (Optional)

To run your own RSSHub instance for better rate limit handling and custom routes:

```bash
# 1. Start RSSHub with Docker profile
cd synap-backend/deploy
docker compose --profile rsshub up -d

# 2. Update your .env file
RSS_PROVIDER_TYPE=rsshub
RSSHUB_URL=http://rsshub:1200
RSSHUB_ACCESS_KEY=$(openssl rand -hex 16)
```

## Provider Configuration

### 1. Direct Fetch (`direct`)

Fetches RSS feeds directly from source URLs without aggregation.

**Pros:**

- No additional services required
- Simple setup

**Cons:**

- Subject to source rate limits
- No caching
- No content transformation

```bash
RSS_PROVIDER_TYPE=direct
RSS_FETCH_TIMEOUT_MS=30000
RSS_FETCH_RETRIES=3
```

### 2. Self-Hosted RSSHub (`rsshub`)

Runs RSSHub as a Docker service alongside the backend.

**Pros:**

- Full control over instance
- Built-in caching (Redis)
- 1000+ supported routes (Twitter, YouTube, etc.)
- Rate limit handling
- Content transformation

**Cons:**

- Requires additional resources (~500MB RAM)
- Need to manage updates

**Setup:**

```bash
# Start RSSHub services
docker compose --profile rsshub up -d

# Generate access key
export RSSHUB_ACCESS_KEY=$(openssl rand -hex 16)

# Configure .env
RSS_PROVIDER_TYPE=rsshub
RSSHUB_URL=http://rsshub:1200
RSSHUB_ACCESS_KEY=${RSSHUB_ACCESS_KEY}
```

**Services started:**

- `rsshub` — RSS aggregation service (port 1200)
- `browserless` — Chrome headless for Puppeteer (port 3000)
- `redis` — Cache for RSSHub (shared with main app)

### 3. Control Plane Proxy (`cpproxy`)

Uses the Synap Control Plane's managed RSSHub proxy.

**Pros:**

- No additional resources needed
- Managed and monitored by Synap
- Automatic failover

**Cons:**

- Requires Control Plane connectivity
- Subject to fair usage limits

```bash
RSS_PROVIDER_TYPE=cpproxy
CP_RSSHUB_PROXY_URL=https://api.synap.live/api/rsshub-proxy
```

### 4. Custom RSSHub (`custom`)

Connect to an existing RSSHub instance.

```bash
RSS_PROVIDER_TYPE=custom
RSSHUB_URL=https://rsshub.yourdomain.com
RSSHUB_ACCESS_KEY=your-access-key
```

## Environment Variables

| Variable               | Default              | Description                                            |
| ---------------------- | -------------------- | ------------------------------------------------------ |
| `RSS_PROVIDER_TYPE`    | `cpproxy`            | Provider type: `direct`, `rsshub`, `cpproxy`, `custom` |
| `RSSHUB_URL`           | `http://rsshub:1200` | URL of RSSHub instance                                 |
| `RSSHUB_ACCESS_KEY`    | —                    | Access key for RSSHub authentication                   |
| `CP_RSSHUB_PROXY_URL`  | —                    | Control Plane proxy endpoint                           |
| `RSS_FETCH_TIMEOUT_MS` | `30000`              | Request timeout in milliseconds                        |
| `RSS_FETCH_RETRIES`    | `3`                  | Number of retry attempts                               |

## Docker Compose Profiles

The RSSHub service is optional and uses Docker Compose profiles:

```bash
# Start with RSSHub
docker compose --profile rsshup up -d

# Stop RSSHub only
docker compose --profile rsshub stop rsshub browserless

# View RSSHub logs
docker compose logs -f rsshub

# Update RSSHub image
docker compose --profile rsshub pull rsshub
docker compose --profile rsshub up -d rsshub
```

## Health Checks

All RSSHub-related services include health checks:

```bash
# Check RSSHub health
docker compose exec rsshub wget -q --spider http://localhost:1200/

# Check Browserless health
docker compose exec browserless curl -f http://localhost:3000/readiness

# View health status
docker compose ps
```

## Troubleshooting

### RSSHub fails to start

```bash
# Check logs
docker compose logs rsshub

# Common issues:
# 1. Port 1200 already in use
sudo lsof -i :1200

# 2. Redis not accessible
docker compose exec rsshub wget redis:6379

# 3. Browserless not ready
docker compose logs browserless
```

### Feeds not updating

```bash
# Check RSSHub is responding
curl http://localhost:1200

# Test a specific route
curl http://localhost:1200/github/trending/daily

# Check Redis cache
docker compose exec redis redis-cli info stats
```

### Rate limiting issues

When using `direct` provider:

- Consider switching to `rsshub` for better rate limit handling
- Increase `RSS_FETCH_TIMEOUT_MS` for slow sources
- Implement exponential backoff in your feed fetching

### Access key errors

```bash
# If you get 403 errors, regenerate the access key
export RSSHUB_ACCESS_KEY=$(openssl rand -hex 16)
echo "RSSHUB_ACCESS_KEY=${RSSHUB_ACCESS_KEY}" >> .env
docker compose --profile rsshub up -d
```

## RSSHub Routes

RSSHub supports 1000+ routes. Common examples:

```
# GitHub
/github/trending/daily
/github/repos/:user

# YouTube
/youtube/channel/:channelId
/youtube/playlist/:playlistId

# Twitter/X
/twitter/user/:username
/twitter/list/:user/:list

# Reddit
/reddit/r/:subreddit
/reddit/user/:username

# News
/nytimes/rss
/bbc/rss
```

Full route documentation: https://docs.rsshub.app

## Migration Between Providers

### From direct to rsshub

1. Start RSSHub: `docker compose --profile rsshub up -d`
2. Update `.env`: Change `RSS_PROVIDER_TYPE=direct` to `RSS_PROVIDER_TYPE=rsshub`
3. Restart backend: `docker compose restart backend`

### From rsshub to cpproxy

1. Update `.env`: Change `RSS_PROVIDER_TYPE=rsshub` to `RSS_PROVIDER_TYPE=cpproxy`
2. Restart backend: `docker compose restart backend`
3. (Optional) Stop RSSHub: `docker compose --profile rsshub stop rsshub browserless`

## Security Considerations

1. **Access Key**: Always set `RSSHUB_ACCESS_KEY` in production to prevent unauthorized access
2. **Network**: RSSHub is exposed on port 1200 — firewall it if not needed externally
3. **Browserless**: Chrome instance can execute arbitrary code — keep it internal only
4. **Redis**: Uses shared Redis instance — RSSHub data is isolated by key prefix

## Resource Requirements

| Service     | CPU | Memory | Notes                         |
| ----------- | --- | ------ | ----------------------------- |
| rsshub      | 0.5 | 256MB  | Scales with feed count        |
| browserless | 0.5 | 512MB  | Required for Puppeteer routes |
| redis       | —   | —      | Shared with main app          |

Total additional resources for RSSHub profile: ~1 CPU core, ~768MB RAM

## Updating RSSHub

```bash
# Update to latest version
cd synap-backend/deploy
docker compose --profile rsshub pull rsshub browserless
docker compose --profile rsshub up -d rsshub browserless

# Check new version
curl http://localhost:1200
```

## Support

For RSSHub-specific issues:

- Documentation: https://docs.rsshub.app
- GitHub: https://github.com/DIYgod/RSSHub
- Routes: https://rsshub.app

For Synap RSS integration issues:

- Check this guide first
- Review backend logs: `docker compose logs backend`
- Open an issue in the Synap repository
