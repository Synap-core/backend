#!/usr/bin/env bash
# The Kratos lists that decide who may sign in through a pod come from ONE
# place: the kratos.yml the installer renders (generate_kratos_config in
# `synap`). An environment variable for the same key REPLACES the file's value
# (Ory reads env over file), so a list set in docker-compose.yml silently wins.
# `SELFSERVICE_ALLOWED_RETURN_URLS` did exactly that: it held only the pod and
# its console, so a federated sign-in returning to a Synap app
# (https://crm.synap.live/…) or to the relay app (synap://auth/callback) was
# refused at login-flow init on every pod.
#
# Asserts, on the parsed compose file, that the Kratos service sets none of the
# allow-lists kratos.yml owns.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${KRATOS_COMPOSE_FILE:-$SCRIPT_DIR/../docker-compose.yml}"

python3 - "$COMPOSE_FILE" <<'PY'
import sys, yaml

OWNED_BY_KRATOS_YML = (
    "SELFSERVICE_ALLOWED_RETURN_URLS",
    "SERVE_PUBLIC_CORS_ALLOWED_ORIGINS",
    "SERVE_PUBLIC_CORS_ENABLED",
    "SERVE_PUBLIC_CORS_ALLOW_CREDENTIALS",
    "COOKIES_DOMAIN",
    "SESSION_COOKIE_DOMAIN",
)

with open(sys.argv[1]) as f:
    compose = yaml.safe_load(f)

kratos = (compose.get("services") or {}).get("kratos")
if not kratos:
    print("FAIL - no kratos service in the compose file")
    sys.exit(1)
env = kratos.get("environment") or {}
if isinstance(env, list):
    env = dict(item.split("=", 1) if "=" in item else (item, "") for item in env)
if "SERVE_PUBLIC_BASE_URL" not in env:
    print("FAIL - the kratos environment was not read (SERVE_PUBLIC_BASE_URL missing)")
    sys.exit(1)

fail = False
for key in OWNED_BY_KRATOS_YML:
    if key in env:
        print(f"FAIL - kratos sets {key} in compose; it would replace kratos.yml's list")
        fail = True
    else:
        print(f"ok   - kratos leaves {key} to kratos.yml")
sys.exit(1 if fail else 0)
PY
