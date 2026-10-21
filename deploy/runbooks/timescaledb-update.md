# Update the TimescaleDB extension after a postgres image update

`synap update` moves the postgres image forward (the release pins
`SYNAP_IMAGE_POSTGRES` by digest), but it never runs `ALTER EXTENSION timescaledb
UPDATE`. Each database keeps the extension version it was created or last updated
at, and keeps working on the newer image. `synap doctor` and the end of
`synap update` say when a database lags the image:

```
· timescaledb: database 'synap' runs TimescaleDB 2.26.4; the postgres image ships up to 2.28.3. …
```

Updating the extension is a person's step, in a maintenance window, because:

- **It cannot be undone by an image swap.** After it, a postgres image that lacks
  the new version cannot start the database. A failed update rolls back by
  swapping images only, so the engine never runs it during an update, and refuses
  any later release whose postgres image cannot load the version a database runs.
- **Open sessions keep the old library.** TimescaleDB must be updated in a session
  that has not loaded it yet (`psql -X`, the `ALTER` as the first command), and the
  backend's pooled sessions loaded the old one. So the services that connect are
  stopped first.

## What was verified, and where

| Fact                                                                   | Source                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timescale/timescaledb-ha` images ship the libraries of older versions | Tiger Data docs, "Upgrade TimescaleDB running in Docker": "The `timescale/timescaledb-ha*` images have the files necessary to run previous versions." Measured: the `pg15` image of 2026-10-20 (`sha256:1c96441b…`, PG 15.18) carries `timescaledb-2.13.0.so` … `timescaledb-2.28.3.so` |
| `ALTER EXTENSION timescaledb UPDATE;` per database, with `psql -X`     | same page: "If you have multiple databases, update each database separately"; every example uses `psql -X`                                                                                                                                                                              |

## Procedure

Run on the pod host, from the deploy directory, in a maintenance window.

```bash
cd /opt/synap-backend/deploy            # your deploy directory
synap backup                            # a fresh, verified dump first
synap doctor | grep timescaledb         # which database lags, and to what

# Stop everything that holds a database session; postgres keeps running.
svcs="$(docker compose ps --services --status running | grep -vx postgres)"
docker compose stop $svcs

# Every database that has the extension, each in a fresh session.
for db in $(docker compose exec -T postgres psql -U synap -d synap -Atc \
    "select datname from pg_database where datallowconn and not datistemplate"); do
  if [ -n "$(docker compose exec -T postgres psql -U synap -d "$db" -Atc \
      "select 1 from pg_extension where extname = 'timescaledb'")" ]; then
    docker compose exec -T postgres psql -X -U synap -d "$db" -v ON_ERROR_STOP=1 \
      -c "ALTER EXTENSION timescaledb UPDATE"
  fi
done

docker compose start $svcs              # exactly the services stopped above
synap doctor                            # timescaledb: ok
```

If an `ALTER` fails, nothing in that database changed (it is one transaction):
start the services again and keep running the old version. The other databases
are independent.

**Not run on a pod yet.** Run it once on the lab pod before any other pod.
