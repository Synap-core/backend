# Deploy hygiene (pod backend)

Hard rules for CT102 / any host running `synap-backend` compose.  
Learned 2026-07-28: an `rsync --delete` without env excludes **wiped** `/opt/synap-backend/deploy/.env`.

## Never

1. **`rsync --delete` without excluding secrets**
   - Always exclude at least: `deploy/.env`, `.env`, and any other host-local secret files.
   - Prefer image pull / `update-pod.sh` over full-tree rsync for production pods.
2. **`docker compose down -v`**
   - Destroys named volumes (Postgres, Kratos, Hydra data). Never on a live pod.
   - Use `docker compose -p synap-backend stop` / recreate a single service if needed.
3. **Bare `docker compose` without project name**
   - Wrong project name orphans volumes and can look like “empty DB” after “fix”.

## Always

1. **`docker compose -p synap-backend`**
   - Canonical project name (matches `synap` CLI and `deploy/update-pod.sh`).
   - Example:
     ```bash
     cd /opt/synap-backend/deploy
     docker compose -p synap-backend ps
     docker compose -p synap-backend logs backend --tail 100
     ```
2. **Rsync excludes when you must sync source**
   ```bash
   rsync -az --delete \
     --exclude deploy/.env \
     --exclude .env \
     --exclude .git \
     --exclude node_modules \
     --exclude dist \
     --exclude .turbo \
     ./ root@HOST:/opt/synap-backend/
   ```
   Still prefer not using `--delete` against a live pod tree unless you know every host-only file.
3. **Backup `deploy/.env` after restore or any secret surgery**
   ```bash
   cp /opt/synap-backend/deploy/.env \
     /root/backups/synap-backend-deploy.env.$(date -u +%Y%m%dT%H%M%SZ)
   ```

## Safe recovery notes

- If `deploy/.env` is missing: restore from backup, or reconstruct from **running container env** + known derived fields (`POSTGRES_PASSWORD`, `DOMAIN`) — then **backup immediately**.
- Preferred update path: `deploy/update-pod.sh <tag>` (canary-first; no volume wipe).
- See also: `deploy/DEPLOY-INTEGRITY.md`, root `DEPLOY-AND-TEST-GUIDE-2026-07-28.md`.
