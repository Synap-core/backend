#!/usr/bin/env bash
# The update's one pruner + self-heal (W7-HOST, 2026-10-15): `_ue_prune_images`
# at the START of every update (before the disk check) and via `synap clean`,
# the disk refusal, `synap heal`, `synap update --unattended`, `synap units`.
#
# Daemon-free: the REAL `synap` against a fake `docker` (images, containers and
# the build cache as state files; every call logged), a fake `df` whose free
# space grows by what the fake docker frees, a fake `du`, a fake `curl` serving
# release manifests, and a fake `systemctl`. The host it plays runs Synap BESIDE
# another stack (an Eve-like `eve` project: open-webui, hermes, a shared
# postgres image, a stopped container, a one-off), exactly like perso.
#
# Proves, behaviourally:
#   (a) a non-Synap image is never removed — not by ref, not by id, not via a
#       second tag on a Synap image; unlabeled dangling images are never removed
#   (b) the current + previous release images are kept, older first-party ones
#       (backend, pod-admin, pod-agent, synap-dev, adopted) removed; in-use kept
#   (c) volumes are never touched; no global prune, no rmi -f, no rm -v
#   (d) the prune runs at the START of an update, before the disk check, and a
#       refusal names the 3 biggest consumers that are not this pod's
#   (e) heal: budget 3 per window, then stops (+ doctor marker); postgres is
#       never restarted (alert once); skips while the update lock is held;
#       restores kratos.yml.good on a crash-looping Kratos
#   + pre-update dumps (newest 2 + every dump an update record names), the unattended update path
#     (request contract, policy, window, enforce), units install/status/remove,
#     `synap clean` scoped to this pod, and a static no-global-prune scan.
#
# NOT covered (measured, not implied): the real Docker semantics of `rmi` on a
# multi-tag image (the fake implements Docker's documented behaviour); systemd
# itself (the fake systemctl records calls).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }

D64() { printf "$1%.0s" $(seq 1 64); }
GB=1000000000

mkdir -p "$TMP/bin" "$TMP/rel"
# ── fake docker ───────────────────────────────────────────────────────────────
# images.tsv:     id|repo|tag|digest|size|labeled(0/1)      (repo <none> = dangling)
# containers.tsv: cid|name|project|service|oneoff|status|imageid|health
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
F="$FAKE"; IM="$F/images.tsv"; CT="$F/containers.tsv"
printf '%s\n' "$*" >> "$F/log"
addfree() { echo $(( $(cat "$F/free_kb") + $1 / 1024 )) > "$F/free_kb"; }
ref_id() { awk -F'|' -v r="$1" '($2 ":" $3 == r) || ($2 "@" $4 == r) || ($1 == r) { print $1; exit }' "$IM"; }
size_of() { awk -F'|' -v i="$1" '$1 == i { print $5; exit }' "$IM"; }
human() { awk -v b="$1" 'BEGIN { printf "%.1fGB", b / 1e9 }'; }
violation() { echo "$*" >> "$F/violations"; }
case "$*" in
  *" prune"*|"system prune"*|"image prune"*|"container prune"*|"network prune"*|"volume prune"*)
    case "$*" in "builder prune"*) ;; *) violation "$*" ;; esac ;;
esac
case "$1" in
  info) [ "$2" = --format ] && echo "$F/root"; exit 0 ;;
  df) exit 0 ;;
  pull) exit 1 ;;
  system)
    if [ "$2" = df ]; then echo "Images|3.0GB"; echo "Build Cache|$(human "$(cat "$F/cache")")"; fi; exit 0 ;;
  builder)
    c="$(cat "$F/cache")"
    if [ "$c" -gt 2000000000 ]; then addfree $(( c - 2000000000 )); echo 2000000000 > "$F/cache"; fi; exit 0 ;;
  volume)
    case "$2" in
      ls) printf '%s\n' synap-backend_postgres_data eve_openwebui_data ;;
      inspect)
        v="${*: -1}"; mkdir -p "$F/vol/$v"
        case "$4" in *Mountpoint*) echo "$F/vol/$v" ;; *Labels*) echo "${v%%_*}" ;; esac ;;
      *) violation "volume $*" ;;
    esac; exit 0 ;;
  network)
    case "$2" in ls) echo net-synap ;; inspect) echo synap-backend_default ;; rm) echo "$3" >> "$F/networks_removed" ;; *) violation "$*" ;; esac; exit 0 ;;
  rm)
    shift; for a in "$@"; do case "$a" in -v|--volumes|-fv|-vf) violation "rm $*";; esac; done
    grep -v "^${*: -1}|" "$CT" > "$CT.n"; mv "$CT.n" "$CT"; exit 0 ;;
  rmi)
    shift; for a in "$@"; do case "$a" in -f|--force) violation "rmi -f $*";; esac; done
    r="${*: -1}"; id="$(ref_id "$r")"; [ -n "$id" ] || { echo "No such image: $r" >&2; exit 1; }
    if cut -d'|' -f7 "$CT" | grep -qxF "$id"; then echo "conflict: image is being used" >&2; exit 1; fi
    sz="$(size_of "$id")"
    if [ "$r" = "$id" ]; then awk -F'|' -v i="$id" '$1 != i' "$IM" > "$IM.n"
    else awk -F'|' -v r="$r" '!(($2 ":" $3 == r) || ($2 "@" $4 == r))' "$IM" > "$IM.n"; fi
    mv "$IM.n" "$IM"; awk -F'|' -v i="$id" '$1 == i { f = 1 } END { exit !f }' "$IM" || addfree "$sz"
    exit 0 ;;
  images)
    case "$*" in
      *"dangling=true -f label=io.synap.first-party=true"*) awk -F'|' '$2 == "<none>" && $6 == 1 { print $1 }' "$IM" ;;
      *"dangling=true"*) awk -F'|' '$2 == "<none>" { print $1 }' "$IM" ;;
      *"--digests"*) awk -F'|' '$2 != "<none>" { print $1 "|" $2 "|" $3 "|" $4 }' "$IM" ;;
      *"{{.Size}}|image {{.Repository}}:{{.Tag}}"*) awk -F'|' '$2 != "<none>" { printf "%.1fGB|image %s:%s\n", $5 / 1e9, $2, $3 }' "$IM" ;;
    esac; exit 0 ;;
  image)
    [ "$2" = inspect ] || exit 0
    if [ "$3" != -f ]; then [ -n "$(ref_id "$4")" ]; exit $?; fi
    id="$(ref_id "$5")"; [ -n "$id" ] || exit 1
    case "$4" in
      "{{.Id}}") echo "$id" ;;
      "{{.Size}}") size_of "$id" ;;
      *RepoTags*) awk -F'|' -v i="$id" '$1 == i { if ($3 != "<none>") print $2 ":" $3; if ($4 != "<none>" && $4 != "") print $2 "@" $4 }' "$IM" ;;
    esac; exit 0 ;;
  ps)
    case "$*" in
      "ps -aq") cut -d'|' -f1 "$CT" ;;
      "ps -a --filter label=com.docker.compose.project="*)
        p="${4#label=com.docker.compose.project=}"
        awk -F'|' -v p="$p" '$3 == p && $6 == "exited" { print $1 "|" $2 "|" $4 "|" $5 }' "$CT" ;;
    esac; exit 0 ;;
  inspect)
    fmt="$3"; shift 3
    for c in "$@"; do
      case "$fmt" in
        "{{.Image}}") awk -F'|' -v c="$c" '$1 == c { print $7 }' "$CT" ;;
        *State.Status*) awk -F'|' -v c="$c" '$1 == c { print $4 "|" $6 "|" $8 }' "$CT" ;;
      esac
    done; exit 0 ;;
  compose)
    case "$*" in
      "compose ps -a -q postgres"*|"compose ps -q postgres"*|"compose ps -a -q --status running postgres"*) exit 0 ;;
      "compose ps -a -q") awk -F'|' -v p="$COMPOSE_PROJECT_NAME" '$3 == p { print $1 }' "$CT" ;;
      "compose restart "*) echo "${*: -1}" >> "$F/restarted" ;;
    esac; exit 0 ;;
esac
exit 0
D
cat > "$TMP/bin/df" <<'D'
#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
for a in "$@"; do case "$a" in -*) ;; *) echo "fakefs 100000000 50000000 $(cat "$FAKE/free_kb") 50% /" ;; esac; done
D
cat > "$TMP/bin/du" <<'U'
#!/usr/bin/env bash
case "${*: -1}" in */vol/eve_*) printf '5000000\t%s\n' "${*: -1}" ;; *) exec /usr/bin/du "$@" ;; esac
U
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H|--max-time|--retry) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
echo "$url" >> "$FAKE/curl_log"
src="$FAKE_REL/${url#https://rel.test/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
C
cat > "$TMP/bin/cosign" <<'C'
#!/usr/bin/env bash
echo "error: none of the expected identities matched" >&2; exit 1
C
cat > "$TMP/bin/systemctl" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/systemctl_log"
case "$1" in is-enabled) echo disabled; exit 1 ;; is-active) echo inactive; exit 3 ;; esac
exit 0
S
chmod +x "$TMP/bin/"*
export FAKE_REL="$TMP/rel"

KEYS="$(grep -oE '\$\{SYNAP_IMAGE_[A-Z0-9_]+' "$HERE/deploy/docker-compose.yml" | sed 's/^\${//' | sort -u)"
images_json() { # <digest-char> — every compose key pinned by digest
  local k out="{}" repo d
  for k in $KEYS; do
    repo="$(echo "${k#SYNAP_IMAGE_}" | tr 'A-Z_' 'a-z-')"; d="$(D64 c)"
    case "$k" in SYNAP_IMAGE_BACKEND|SYNAP_IMAGE_POD_ADMIN|SYNAP_IMAGE_POD_AGENT) repo="ghcr.io/synap-core/$repo"; d="$(D64 "$1")" ;; esac
    out="$(jq -c --arg k "$k" --arg v "$repo@sha256:$d" '. + {($k): $v}' <<<"$out")"
  done
  echo "$out"
}
manifest() { # <id> <digest-char>
  jq -n --arg id "$1" --argjson images "$(images_json "$2")" --arg sha "$(printf 'b%.0s' $(seq 1 40))" --arg compose "sha256:$(D64 e)" \
    '{schema:1, id:$id, channel:"fast", gitSha:$sha, createdAt:"2026-10-04T00:00:00Z", images:$images,
      migrations:{last:"0012_new.sql", count:12}, composeSha:$compose, envSchemaVersion:null, minFrom:null, bundle:null}'
}

# setup <name> — a pod (release R2 current, R1 previous) beside an `eve` stack
setup() {
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"; FAKE="$S/fake"
  mkdir -p "$DEPLOY/state" "$DEPLOY/backups/postgres" "$FAKE/root" "$REPO/kratos"
  cp "$HERE/synap" "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
  cp -R "$HERE/deploy/systemd" "$DEPLOY/systemd"
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nKRATOS_SECRETS_COOKIE=x\nSYNAP_SERVICE_ENCRYPTION_KEY=x\nPROVISIONING_TOKEN=x\nADMIN_BOOTSTRAP_MODE=token\nPUBLIC_URL=https://pod.example.com\nPOD_ADMIN_URL=https://pod-admin.example.com\nPOD_ADMIN_DOMAIN=pod-admin.example.com\nBACKEND_VERSION=main-2222222\n' > "$DEPLOY/.env"
  manifest main-2222222 2 | jq --arg b "$DEPLOY/backups/postgres/20261001T000000Z-pre-update" '. + {preUpdateBackup: $b}' > "$DEPLOY/state/current-release.json"
  manifest main-1111111 1 > "$DEPLOY/state/previous-release.json"
  : > "$FAKE/log"; : > "$FAKE/violations"; : > "$FAKE/containers.tsv"
  echo 10240000 > "$FAKE/free_kb"            # 10 GB free
  echo $(( 5 * GB )) > "$FAKE/cache"         # 5 GB build cache
  {
    for c in 2 1; do   # current (2) and previous (1) releases, every first-party image
      for r in backend pod-admin pod-agent; do echo "sha256:rel$c-$r|ghcr.io/synap-core/$r|<none>|sha256:$(D64 "$c")|$GB|1"; done
    done
    echo "sha256:old-backend|ghcr.io/synap-core/backend|<none>|sha256:$(D64 0)|$(( 3 * GB / 2 ))|1"
    echo "sha256:old-agent|ghcr.io/synap-core/pod-agent|<none>|sha256:$(D64 9)|$(( GB / 10 ))|1"
    echo "sha256:dev-old|synap-dev/backend|aaaaaaaaaaaa|<none>|$GB|1"
    echo "sha256:adopted-old|synap-adopted/backend|0123456789ab|<none>|$GB|0"
    echo "sha256:dev-used|synap-dev/pod-admin|usedusedused|<none>|$GB|1"
    echo "sha256:shared|synap-dev/backend|shared|<none>|$GB|1"
    echo "sha256:shared|myorg/custom|1|<none>|$GB|0"
    echo "sha256:dangling-ours|<none>|<none>|<none>|$GB|1"
    echo "sha256:dangling-unlabeled|<none>|<none>|<none>|$(( 2 * GB ))|0"
    echo "sha256:webui|ghcr.io/open-webui/open-webui|main|<none>|$(( 4 * GB ))|0"
    echo "sha256:hermes|hermes-agent|latest|<none>|$(( 3 * GB ))|0"
    echo "sha256:tsdb|timescale/timescaledb-ha|pg15|<none>|$(( 2 * GB ))|0"
    echo "sha256:idle-tool|ghcr.io/eve-stack/remotion-renderer|latest|<none>|$(( 3 * GB ))|0"   # no container uses it
  } > "$FAKE/images.tsv"
  cat > "$FAKE/containers.tsv" <<C
c-backend|synap-backend-backend-1|synap-backend|backend|False|running|sha256:rel2-backend|healthy
c-postgres|synap-backend-postgres-1|synap-backend|postgres|False|running|sha256:tsdb|healthy
c-realtime|synap-backend-realtime-1|synap-backend|realtime|False|running|sha256:rel2-backend|healthy
c-kratos|synap-backend-kratos-1|synap-backend|kratos|False|running|sha256:tsdb|healthy
c-migrate|synap-backend-backend-migrate-run-1a2b|synap-backend|backend-migrate|True|exited|sha256:rel1-backend|none
c-canary|synap-backend-canary|synap-backend|backend-canary|False|exited|sha256:rel1-backend|none
c-minio|synap-backend-minio-1|synap-backend|minio|False|exited|sha256:dev-used|none
c-webui|eve-openwebui-1|eve|openwebui|False|exited|sha256:webui|none
c-evejob|eve-run-77|eve|job|True|exited|sha256:hermes|none
C
  export FAKE
}
run_synap() { # <args...>
  ( cd "$S"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_LOCK_IMPL=mkdir SYNAP_ASSUME_YES=1 \
    SYNAP_SYSTEMD_RUN_DIR="${SYSD_RUN:-$TMP/no-systemd}" SYNAP_SYSTEMD_DIR="$TMP/units-$(basename "$S")" \
    SYNAP_RELEASE_BASE_URL=https://rel.test bash "$REPO/synap" "$@" ) >"$S/out" 2>&1 <"${RUN_STDIN:-/dev/null}"
}
img()   { grep -q "^$1|" "$FAKE/images.tsv"; }
imgref() { awk -F'|' -v r="$1" '($2 ":" $3 == r) || ($2 "@" $4 == r) { f = 1 } END { exit !f }' "$FAKE/images.tsv"; }
ctr()   { grep -q "^$1|" "$FAKE/containers.tsv"; }
show()  { echo "      --- tail of output ---"; tail -12 "$S/out" | sed 's/^/      /'; }
mkdump() { mkdir -p "$DEPLOY/backups/postgres/$1"; head -c 102400 /dev/zero > "$DEPLOY/backups/postgres/$1/synap.dump"; }
dump()  { [ -d "$DEPLOY/backups/postgres/$1" ]; }

# ── dumps fixture ──────────────────────────────────────────────────────────────
dumps_fixture() {
  for d in 20261001T000000Z-pre-update 20261005T000000Z-pre-update 20261010T000000Z-pre-update 20261012T000000Z-pre-update \
           20260901T000000Z-manual 20261014T090000Z-auto; do mkdump "$d"; done
}

# ═══ 1. the pruner (through `synap clean images`): (a) (b) (c) + dumps ════════
setup prune; dumps_fixture
run_synap clean images; rc=$?
[ "$rc" = 0 ] && ok "clean images: exit 0" || { bad "clean images rc=$rc"; show; }
for i in webui hermes tsdb idle-tool; do img "sha256:$i" || bad "(a) non-Synap image sha256:$i was removed"; done
img "sha256:webui" && img "sha256:hermes" && img "sha256:tsdb" && img "sha256:idle-tool" && ok "(a) non-Synap images kept — in use (open-webui, hermes, timescaledb) AND unused (remotion-renderer)"
! grep -qE "^rmi .*(open-webui|hermes|timescale|remotion|myorg|sha256:webui|sha256:hermes|sha256:tsdb|sha256:idle-tool|sha256:shared)" "$FAKE/log" \
  && ok "(a) no rmi ever named a non-Synap image, its id, or a shared image's id" || bad "(a) rmi of non-Synap: $(grep '^rmi' "$FAKE/log")"
imgref "myorg/custom:1" && ! imgref "synap-dev/backend:shared" && ok "(a) a Synap tag on another stack's image is only UNTAGGED — myorg/custom:1 survives" || bad "(a) shared image: $(grep shared "$FAKE/images.tsv")"
img "sha256:dangling-unlabeled" && ! img "sha256:dangling-ours" && ok "(a) dangling: labeled io.synap.first-party removed, unlabeled kept" || bad "(a) dangling handling"
[ ! -s "$FAKE/violations" ] && ok "(a)(c) no rmi -f, no global/volume prune, no rm -v (violations log empty)" || bad "violations: $(cat "$FAKE/violations")"
keep=1; for c in 1 2; do for r in backend pod-admin pod-agent; do img "sha256:rel$c-$r" || { keep=0; bad "(b) release $c $r image removed"; }; done; done
[ "$keep" = 1 ] && ok "(b) current + previous release images (backend, pod-admin, pod-agent) kept"
! img "sha256:old-backend" && ! img "sha256:old-agent" && ! img "sha256:dev-old" && ! img "sha256:adopted-old" \
  && ok "(b) older first-party images removed (ghcr backend + pod-agent, synap-dev, an adopted one no release names)" || bad "(b) old images left: $(cut -d'|' -f1,2 "$FAKE/images.tsv" | tr '\n' ' ')"
img "sha256:dev-used" && ok "(b) a first-party image used by a (stopped) container is kept" || bad "(b) in-use image removed"
grep -q "^builder prune -f --max-used-space 2gb" "$FAKE/log" && [ "$(cat "$FAKE/cache")" = 2000000000 ] && ok "build cache capped at 2 GB" || bad "cache not capped"
! grep -qE "^volume|^rm |down .*(-v|--volumes)" "$FAKE/log" && ctr c-webui && ctr c-evejob && ok "(c) no volume command, no container removed by the image pruner" || bad "(c) $(grep -E '^volume|^rm' "$FAKE/log")"
dump 20261012T000000Z-pre-update && dump 20261010T000000Z-pre-update && ! dump 20261005T000000Z-pre-update \
  && ok "dumps: the newest 2 pre-update dumps kept, an older one removed" || bad "dumps: pre-update $(ls "$DEPLOY/backups/postgres" | tr '\n' ' ')"
dump 20261001T000000Z-pre-update && ok "dumps: the pre-update dump the current release names is kept (pinned)" || bad "dumps: pinned dump removed"
dump 20260901T000000Z-manual && dump 20261014T090000Z-auto && ok "dumps: manual and scheduled dumps never touched" || bad "dumps: manual/auto removed"
# A dump an update record names is never pruned (_bk_pinned_dumps): the newest
# rolled-back update whose schema MOVED (its `synap restore` command is the one
# still worth running), the latest outcome, the running release's dump.
setup pinned; dumps_fixture; mkdump 20261003T000000Z-pre-update; mkdump 20261008T000000Z-pre-update
P="$DEPLOY/backups/postgres"
{ ev() { jq -cn --arg s "$1" --arg sc "$2" --arg b "$P/$3" '{kind:"pod.update", status:$s, schema:$sc, backup:$b}'; }
  ev rolled_back migrated 20261003T000000Z-pre-update       # superseded by the next one
  ev rolled_back unknown 20261005T000000Z-pre-update        # newest whose schema moved → kept
  printf '{"kind":"pod.update","status":"rolled_b\n'        # a torn append never hides the rest
  ev rolled_back unchanged 20260901T000000Z-manual          # a canary rollback offers no restore
  jq -cn '{kind:"heal", status:"rolled_back", schema:"migrated", backup:"x/20261003T000000Z-pre-update"}'
} > "$DEPLOY/state/events.jsonl"
jq -cn --arg b "$P/20261008T000000Z-pre-update" '{kind:"pod.update", status:"aborted", backup:$b}' > "$DEPLOY/state/last-update.json"
run_synap clean images
dump 20261005T000000Z-pre-update && dump 20261008T000000Z-pre-update && dump 20261001T000000Z-pre-update \
  && dump 20261012T000000Z-pre-update && dump 20261010T000000Z-pre-update && ! dump 20261003T000000Z-pre-update \
  && ok "dumps: kept = newest 2 + the newest schema-moving rollback's (events.jsonl) + last-update's + the current release's; an older rollback's pruned" \
  || { bad "dumps (pinned): $(ls "$P" | tr '\n' ' ')"; show; }
# Records that exist but cannot be read (jq fails) → nothing pruned, said so.
mkdir -p "$S/badjq"; printf '#!/bin/sh\necho "jq: error" >&2; exit 2\n' > "$S/badjq/jq"; chmod +x "$S/badjq/jq"
for d in 20261003T000000Z-pre-update 20260920T000000Z-pre-update; do mkdump "$d"; done
before="$(ls "$P" | grep -c -- '-pre-update$')"
out="$( PATH="$S/badjq:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash -c 'source "$1/pgdata-safety.sh"; _bk_prune_label pre-update 2' _ "$DEPLOY" 2>&1 )"
[ "$(ls "$P" | grep -c -- '-pre-update$')" = "$before" ] && [ "$before" -gt 2 ] && grep -q "no pre-update dump pruned this time" <<<"$out" \
  && ok "dumps: unreadable update records prune nothing (an unreadable keep-list is not an empty one)" || bad "dumps (unreadable): before=$before now=$(ls "$P" | tr '\n' ' ') out=$out"
setup norecord; rm -f "$DEPLOY/state/current-release.json"
run_synap clean images
! grep -q "^rmi" "$FAKE/log" && ok "(b) no release record: no image is removed" || bad "norecord: $(grep '^rmi' "$FAKE/log")"

# ═══ 2. (d) the update prunes FIRST, then checks the disk ═════════════════════
publish() { mkdir -p "$TMP/rel/$1"; manifest "$1" 3 > "$TMP/rel/$1/release.json"; }
publish main-3333333
setup preflight
echo 512000 > "$FAKE/free_kb"; echo 0 > "$FAKE/cache"   # 500 MB free; the prune frees ≥ 1.5 GB (old release images)
UE_REQUEST_ID=stale-env SYNAP_UPDATE_MIN_FREE_MB=1500 SYNAP_RELEASE_VERIFY=off run_synap update --release main-3333333; rc=$?
r="$(grep -n "^rmi " "$FAKE/log" | head -1 | cut -d: -f1)"; p="$(grep -n "^pull " "$FAKE/log" | head -1 | cut -d: -f1)"
[ -n "$r" ] && [ -n "$p" ] && [ "$r" -lt "$p" ] && ok "(d) the update pruned before anything else (rmi before the first pull)" || { bad "(d) order rmi=$r pull=$p"; show; }
[ "$(jq -r 'has("request")' "$DEPLOY/state/last-update.json")" = false ] && ok "a person's update answers no request (no request field)" || bad "manual record carries a request: $(cat "$DEPLOY/state/last-update.json")"
[ "$(jq -r .reason "$DEPLOY/state/last-update.json")" = "image pull failed" ] && ! grep -q "MB free on" "$S/out" \
  && ok "(d) 500 MB free + an old release to prune ⇒ the disk check passed (stopped later at the injected pull failure)" || { bad "(d) record: $(cat "$DEPLOY/state/last-update.json")"; show; }
setup refuse
awk -F'|' '$1 ~ /^sha256:rel[12]-/ || $2 !~ /^(ghcr\.io\/synap-core|synap-)/' "$FAKE/images.tsv" | grep -v dangling-ours > "$FAKE/i" && mv "$FAKE/i" "$FAKE/images.tsv"
echo 512000 > "$FAKE/free_kb"; echo 0 > "$FAKE/cache"
SYNAP_UPDATE_MIN_FREE_MB=1500 SYNAP_RELEASE_VERIFY=off run_synap update --release main-3333333; rc=$?
[ "$rc" != 0 ] && [ "$(jq -r .reason "$DEPLOY/state/last-update.json")" = "not enough disk" ] && ok "(d) still short after the prune: refused, recorded 'not enough disk'" || { bad "(d) refuse rc=$rc"; show; }
b="$(grep -n "^builder prune" "$FAKE/log" | head -1 | cut -d: -f1)"
[ -n "$b" ] && ok "(d) the refusal came after the prune ran" || bad "(d) refused without pruning"
n="$(sed -n '/not this pod/,$p' "$S/out" | grep -cE '^ +[0-9.]+ GB  (image|volume) ')"
[ "$n" = 3 ] && grep -q "volume eve_openwebui_data" "$S/out" && grep -q "image ghcr.io/open-webui/open-webui:main" "$S/out" \
  && ! sed -n '/not this pod/,$p' "$S/out" | grep -qE "synap-backend_postgres_data|synap-core|synap-dev" \
  && ok "(d) the refusal names the 3 biggest consumers that are not this pod's (never its own volume or images)" || { bad "(d) consumers n=$n"; show; }
! grep -q "^pull " "$FAKE/log" && [ ! -s "$FAKE/violations" ] && img "sha256:webui" && ok "(d) nothing pulled; nothing of another stack removed" || bad "(d) pulled or violated"

# ═══ 4. (e) heal ═════════════════════════════════════════════════════════════
setup heal
sed -i.x 's/^c-backend|\(.*\)|healthy$/c-backend|\1|unhealthy/; s/^c-postgres|\(.*\)|healthy$/c-postgres|\1|unhealthy/' "$FAKE/containers.tsv"; rm -f "$FAKE/containers.tsv.x"
grep -q "^c-backend|.*|unhealthy$" "$FAKE/containers.tsv" && grep -q "^c-postgres|.*|unhealthy$" "$FAKE/containers.tsv" && ok "heal fixture: backend + postgres unhealthy" || bad "heal fixture mutation did not land"
for i in 1 2 3 4 5; do run_synap heal; done
[ "$(grep -cx backend "$FAKE/restarted" 2>/dev/null)" = 3 ] && ok "(e) backend restarted exactly 3 times over 5 runs (budget)" || bad "(e) backend restarts: $(grep -cx backend "$FAKE/restarted" 2>/dev/null)"
! grep -qx postgres "$FAKE/restarted" 2>/dev/null && ok "(e) postgres never restarted" || bad "(e) postgres restarted"
[ -e "$DEPLOY/state/heal/exhausted-backend" ] && [ "$(grep -c '"status":"budget_exhausted","service":"backend"' "$DEPLOY/state/events.jsonl")" = 1 ] \
  && ok "(e) budget used up: heal stopped, marker written, ONE budget_exhausted event" || bad "(e) exhausted: $(grep budget "$DEPLOY/state/events.jsonl")"
[ "$(grep -c '"status":"alert","service":"postgres"' "$DEPLOY/state/events.jsonl")" = 1 ] && [ -e "$DEPLOY/state/heal/alert-postgres" ] \
  && ok "(e) postgres: one alert event across 5 runs, never a restart" || bad "(e) postgres alerts: $(grep -c alert "$DEPLOY/state/events.jsonl")"
[ ! -e "$DEPLOY/state/last-update.json" ] && ok "(e) heal never writes last-update.json" || bad "(e) heal wrote last-update.json"
SYNAP_PROC_LOCKS=/dev/null run_synap doctor --json >/dev/null 2>&1
jq -e '[.findings[] | select(.check == "heal")] | length == 2' "$S/out" >/dev/null && ok "(e) doctor reports both (budget used up, postgres alert)" || bad "(e) doctor heal findings: $(jq -c '[.findings[]|select(.check=="heal")]' "$S/out" 2>/dev/null)"
sed -i.x 's/^c-backend|\(.*\)|unhealthy$/c-backend|\1|healthy/' "$FAKE/containers.tsv"; rm -f "$FAKE/containers.tsv.x"
run_synap heal
[ ! -e "$DEPLOY/state/heal/exhausted-backend" ] && grep -q '"status":"recovered","service":"backend"' "$DEPLOY/state/events.jsonl" && ok "(e) a recovered service re-arms heal" || bad "(e) not re-armed"
# lock held by a live operation ⇒ heal does not act
sed -i.x 's/^c-realtime|\(.*\)|healthy$/c-realtime|\1|unhealthy/' "$FAKE/containers.tsv"; rm -f "$FAKE/containers.tsv.x"
mkdir -p "$DEPLOY/state/update.lock.d"; echo "synap update pid=$$ since=2026-10-15T00:00:00Z" > "$DEPLOY/state/update.lock.d/owner"
: > "$FAKE/restarted"; run_synap heal; rc=$?
[ "$rc" = 0 ] && ! grep -qx realtime "$FAKE/restarted" && grep -q "holds the update lock" "$S/out" && ok "(e) the update lock is held: heal skips (exit 0)" || { bad "(e) heal acted under a held lock"; show; }
[ -d "$DEPLOY/state/update.lock.d" ] && grep -q "pid=$$" "$DEPLOY/state/update.lock.d/owner" && ok "(e) and leaves the holder's lock alone" || bad "(e) heal broke the holder's lock"
rm -rf "$DEPLOY/state/update.lock.d"; run_synap heal
grep -qx realtime "$FAKE/restarted" && [ ! -d "$DEPLOY/state/update.lock.d" ] && ok "(e) lock free: heal restarts it and releases its own lock" || bad "(e) realtime not restarted after the lock freed"
# kratos crash-looping on a changed, broken kratos.yml ⇒ the last verified one comes back
GOOD='version: v1.3.1
serve:
  public:
    base_url: https://pod.example.com/.ory/kratos/public/
selfservice:
  methods:
    password:
      enabled: true
      config: {}'
printf '%s\n' "$GOOD" > "$REPO/kratos/kratos.yml.good"; printf '{"level":30,"msg":"loaded config"}\n' > "$REPO/kratos/kratos.yml"
sed -i.x 's/^c-kratos|\(.*\)|running|\(.*\)|healthy$/c-kratos|\1|restarting|\2|unhealthy/' "$FAKE/containers.tsv"; rm -f "$FAKE/containers.tsv.x"
grep -q "^c-kratos|.*|restarting|" "$FAKE/containers.tsv" && ok "kratos fixture: crash-looping" || bad "kratos fixture mutation did not land"
: > "$FAKE/log"; run_synap heal
cmp -s "$REPO/kratos/kratos.yml" "$REPO/kratos/kratos.yml.good" && ls "$REPO/kratos/"kratos.yml.broken-* >/dev/null 2>&1 \
  && ok "(e) kratos: kratos.yml.good restored, the broken file kept as kratos.yml.broken-*" || bad "(e) kratos.yml not restored"
grep -q "^compose up -d --no-deps --force-recreate kratos" "$FAKE/log" && grep -q '"status":"kratos_config_restored"' "$DEPLOY/state/events.jsonl" \
  && ok "(e) kratos recreated on the restored config, event recorded" || bad "(e) kratos not recreated: $(grep kratos "$FAKE/log")"
: > "$FAKE/log"; run_synap heal
! grep -qE "^compose (up|restart).*kratos" "$FAKE/log" && ok "(e) kratos on its verified config still crash-looping: heal leaves it to Docker's backoff" || bad "(e) heal kept acting on kratos: $(grep kratos "$FAKE/log")"

# ═══ 5. unattended update: request contract, policy, window, enforce ══════════
setup unattended; publish main-4444444
echo '{"auto": false}' > "$DEPLOY/state/update-policy.json"
: > "$FAKE/curl_log"; run_synap update --unattended; rc=$?
[ "$rc" = 0 ] && [ ! -s "$FAKE/curl_log" ] && grep -q "automatic updates are off" "$S/out" && ok "unattended: auto:false ⇒ exit 0, nothing fetched" || { bad "unattended auto:false rc=$rc"; show; }
h=$(( 10#$(date +%H) )); win="$(printf '%02d:00-%02d:00' $(( (h + 2) % 24 )) $(( (h + 3) % 24 )))"
echo "{\"window\": \"$win\"}" > "$DEPLOY/state/update-policy.json"
run_synap update --unattended; rc=$?
[ "$rc" = 0 ] && [ ! -s "$FAKE/curl_log" ] && grep -q "outside the update window $win" "$S/out" && ok "unattended: outside the window ($win) ⇒ exit 0, nothing fetched" || { bad "unattended window rc=$rc"; show; }
echo '{"auto": false}' > "$DEPLOY/state/update-policy.json"
mkdir -p "$DEPLOY/state/requests"
echo '{"schema":1,"release":"main-4444444","requestedBy":"test","requestedAt":"2026-10-15T00:00:00Z","id":"jti-1"}' > "$DEPLOY/state/requests/update.json"
run_synap update --unattended; rc=$?
[ ! -e "$DEPLOY/state/requests/update.json" ] && [ -s "$DEPLOY/state/requests/update.taken.json" ] && ok "request: taken before running (the .path unit cannot loop)" || bad "request not taken"
grep -q "main-4444444/release.json" "$FAKE/curl_log" && ok "request: honoured even with auto:false (an order already passed its policy)" || { bad "request not fetched"; show; }
[ "$rc" != 0 ] && [ "$(jq -r '.status + "|" + .to + "|" + .reason' "$DEPLOY/state/last-update.json")" = "aborted|main-4444444|manifest signature refused" ] \
  && grep -q "SYNAP_RELEASE_VERIFY=enforce" "$S/out" && ok "request: the unattended path ENFORCES the release signature (unsigned ⇒ refused, recorded)" || { bad "unattended enforce: $(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
! grep -q "SYNAP_RELEASE_VERIFY" "$DEPLOY/.env" && ok "request: enforce comes from the unattended path, not a .env change" || bad ".env carries SYNAP_RELEASE_VERIFY"
[ "$(jq -r .request "$DEPLOY/state/last-update.json")" = jti-1 ] && grep -q '"request":"jti-1"' "$DEPLOY/state/events.jsonl" \
  && ok "request: the outcome names the request it answers (pod-agent reports it back)" || bad "record lacks request jti-1: $(cat "$DEPLOY/state/last-update.json")"
echo '{"schema":1,"release":"latest","id":"jti-2"}' > "$DEPLOY/state/requests/update.json"
: > "$FAKE/curl_log"; run_synap update --unattended; rc=$?
[ "$rc" != 0 ] && [ ! -e "$DEPLOY/state/requests/update.json" ] && [ ! -s "$FAKE/curl_log" ] && jq -e '.status == "aborted" and (.reason | test("invalid update request jti-2"))' "$DEPLOY/state/last-update.json" >/dev/null \
  && ok "request: 'latest' refused (no implicit latest), taken, recorded" || { bad "invalid request rc=$rc"; show; }
[ "$(jq -r .request "$DEPLOY/state/last-update.json")" = jti-2 ] && ok "request: a refused request's record names it too" || bad "invalid record lacks request jti-2"
echo '{"schema":1,"release":"main-4444444","id":"jti-3"}' > "$DEPLOY/state/requests/update.json"
mkdir -p "$DEPLOY/state/update.lock.d"; echo "synap apply pid=$$ since=2026-10-15T00:00:00Z" > "$DEPLOY/state/update.lock.d/owner"
: > "$FAKE/curl_log"; run_synap update --unattended; rc=$?
[ "$rc" != 0 ] && [ ! -e "$DEPLOY/state/requests/update.json" ] && [ ! -s "$FAKE/curl_log" ] && jq -e '.reason | test("held the update lock — request jti-3")' "$DEPLOY/state/last-update.json" >/dev/null \
  && ok "request + busy lock: taken and recorded as not run (no loop, no silent drop)" || { bad "busy request rc=$rc: $(cat "$DEPLOY/state/last-update.json")"; show; }
[ "$(jq -r .request "$DEPLOY/state/last-update.json")" = jti-3 ] && ok "request + busy lock: the record names the request" || bad "busy record lacks request jti-3"
rm -rf "$DEPLOY/state/update.lock.d"

# ═══ 6. units ════════════════════════════════════════════════════════════════
setup units; mkdir -p "$TMP/run-systemd"; U="$TMP/units-units"; mkdir -p "$U"
SYSD_RUN="$TMP/run-systemd" run_synap units install; rc=$?
n_tpl="$(ls "$HERE/deploy/systemd" | grep -cE '\.(service|timer|path)$')"
[ "$rc" = 0 ] && [ "$(ls "$U" | grep -c .)" = "$n_tpl" ] && [ "$n_tpl" -ge 5 ] && ok "units: all $n_tpl templates installed" || { bad "units install rc=$rc: $(ls "$U")"; show; }
! grep -l '@SYNAP@\|@DEPLOY_DIR@' "$U"/* >/dev/null 2>&1 && grep -q "^ExecStart=.*/synap heal$" "$U/synap-heal.service" \
  && grep -q "^Environment=SYNAP_DEPLOY_DIR=$(cd "$DEPLOY" && pwd -P)$" "$U/synap-update.service" && grep -q "^PathExists=$(cd "$DEPLOY" && pwd -P)/state/requests/update.json$" "$U/synap-update.path" \
  && ok "units: rendered with this CLI + deploy dir (no placeholder left)" || bad "units render: $(grep -h 'ExecStart\|DEPLOY\|PathExists' "$U"/* | head -5)"
grep -q "^ExecStart=.* update --unattended$" "$U/synap-update.service" && grep -q "^TimeoutStartSec=90min$" "$U/synap-update.service" && ok "units: synap-update.service = update --unattended, 90 min" || bad "update unit"
grep -q "enable --now synap-heal.timer synap-update.path" "$FAKE/systemctl_log" && ! grep -q "enable.*synap-update.timer" "$FAKE/systemctl_log" \
  && ok "units: the heal timer and the request path enabled; the update TIMER left off" || bad "systemctl: $(cat "$FAKE/systemctl_log")"
: > "$FAKE/systemctl_log"; SYSD_RUN="$TMP/run-systemd" run_synap units install --enable-auto-update
grep -q "enable --now synap-update.timer" "$FAKE/systemctl_log" && ok "units: --enable-auto-update opts in" || { bad "auto-update not enabled: $(cat "$FAKE/systemctl_log")"; show; }
sed -i.x 's#SYNAP_DEPLOY_DIR=.*#SYNAP_DEPLOY_DIR=/srv/other/deploy#' "$U/synap-heal.service"; rm -f "$U/synap-heal.service.x"
SYSD_RUN="$TMP/run-systemd" run_synap units install; rc=$?
[ "$rc" != 0 ] && grep -q "installed for another deploy dir" "$S/out" && ok "units: refuses to repoint another pod's units without --force" || { bad "units foreign rc=$rc"; show; }
SYSD_RUN="$TMP/run-systemd" run_synap units status
grep -q "synap-heal.service .*OUTDATED" "$S/out" && ok "units status: a drifted unit reads OUTDATED" || { bad "status"; show; }
SYSD_RUN="$TMP/run-systemd" run_synap units remove
[ -z "$(ls "$U")" ] && grep -q "disable --now synap-heal.timer" "$FAKE/systemctl_log" && ok "units remove: disabled and deleted" || bad "units remove: $(ls "$U")"
rmdir "$U"; run_synap units install; rc=$?
[ "$rc" = 0 ] && grep -q "^\*/2 \* \* \* \* root SYNAP_DEPLOY_DIR=.* heal" "$S/out" && [ ! -d "$U" ] \
  && ok "units without systemd: prints the cron line, writes nothing" || { bad "no-systemd units"; show; }

# ═══ 7. synap clean is scoped to this pod; a static scan for global prunes ════
setup clean
echo y > "$S.yes"; RUN_STDIN="$S.yes" run_synap clean all; rc=$?
[ "$rc" = 0 ] && [ ! -s "$FAKE/violations" ] && ! img "sha256:old-backend" && img "sha256:webui" && ctr c-webui \
  && ok "clean all: the update's pruner + this project's containers/networks — no global prune, other stacks untouched" || { bad "clean all rc=$rc: $(cat "$FAKE/violations")"; show; }
grep -q "^compose rm -f" "$FAKE/log" && ok "clean all: stopped containers via compose rm (this project only, no -v)" || bad "clean all: no compose rm"
rm -f "$FAKE/networks_removed"; : > "$FAKE/log"; run_synap clean networks
[ "$(cat "$FAKE/networks_removed" 2>/dev/null)" = net-synap ] && grep -q "^network ls -q --filter label=com.docker.compose.project=synap-backend" "$FAKE/log" \
  && ok "clean networks: this project's networks only" || bad "clean networks: $(grep network "$FAKE/log")"
run_synap clean volumes; rc=$?
[ "$rc" != 0 ] && grep -q "never removes Docker volumes" "$S/out" && ok "clean volumes: still refused" || bad "clean volumes not refused"
GLOBAL='docker[[:space:]]+(system|image|container|network|volume)[[:space:]]+prune|docker[[:space:]]+rmi[[:space:]]+-f'
for s in "docker system prune -a -f" "docker image prune -f" "docker container prune -f" "docker network prune -f" "docker rmi -f \"\$id\""; do
  grep -qE "$GLOBAL" <<<"$s" || bad "static self-check: pattern misses '$s'"
done
grep -qE "$GLOBAL" <<<"docker builder prune -f --max-used-space 2gb" && bad "static self-check: flags the capped builder prune"
hits="$(grep -nE "$GLOBAL" "$HERE/synap" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
[ "$(grep -c '' "$HERE/synap")" -gt 5000 ] && [ -z "$hits" ] && ok "static: synap has no global prune and no rmi -f outside comments" || bad "static: $hits"

exit $fail
