#!/usr/bin/env bash
# The host resources sample (plan P3, G10 resource alerts): every `synap heal`
# tick writes state/resources.json, the RESOURCES CONTRACT
# (deploy/schemas/host-resources.v1.schema.json) the backend reads.
#
# The REAL `synap heal` against a fake /proc (SYNAP_PROC_ROOT), a fake `df`, a
# fake `docker` (no containers: heal itself has nothing to restart), a fake
# `curl` that answers the Docker API's /system/df, a fake `systemd-detect-virt`
# and a `du` that must never run.
#   V. the validator (json-schema-lite.jq) sees a violation: never vacuous.
#   A. a full host: every value read, exact, and the file valid against the schema.
#   B. an unreadable value is null, never 0: no PSI, an unreadable PSI file, no
#      swap, no meminfo, no loadavg, a disk df cannot read; still valid.
#   C. Docker's disk usage is asked at most once per interval, through the
#      API's type filter (no volume walk), never the CLI's `system df` nor `du`;
#      between two asks the last answer is kept with its time; a failed ask
#      keeps the last answer, and none yet is null.
#   D. hostKind: lxc, vm, baremetal, unknown (another container kind).
#   E. read-only, and it never fails heal: no docker call that changes
#      anything; a sample that cannot be written leaves heal's exit 0.
# NOT covered: the fallback without systemd-detect-virt (/proc/1/environ,
# the cpuinfo hypervisor flag): the CI host has the real one in /usr/bin; the
# real Docker API (the fixture follows the API's SystemDataUsageResponse).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'chmod -R u+rwx "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }
SCHEMA="$HERE/deploy/schemas/host-resources.v1.schema.json"
VALIDATE="$HERE/deploy/__tests__/fixtures/json-schema-lite.jq"
violations() { jq -rn --slurpfile s "$1" --slurpfile d "$2" -f "$VALIDATE"; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE/docker.log"
case "$*" in
  "info --format {{.DockerRootDir}}") [ -n "${FAKE_NO_DOCKER_ROOT:-}" ] && exit 1; echo "$FAKE/docker-root"; exit 0 ;;
  "compose ps"*) exit 0 ;;
esac
exit 0
D
cat > "$TMP/bin/df" <<'D'
#!/usr/bin/env bash
# df -B1 -P <path>: the numbers of $FAKE/df.<basename of path>
p="${@: -1}"; f="$FAKE/df.$(basename "$p")"
[ -f "$f" ] || { echo "df: $p: No such file or directory" >&2; exit 1; }
echo "Filesystem 1-blocks Used Available Capacity Mounted on"
echo "/dev/fake $(cat "$f") /"
D
cat > "$TMP/bin/curl" <<'D'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE/curl.log"
[ -n "${FAKE_CURL_FAIL:-}" ] && { echo "curl: (7) Couldn't connect to server" >&2; exit 7; }
cat "$FAKE/system-df.json"
D
cat > "$TMP/bin/systemd-detect-virt" <<'D'
#!/usr/bin/env bash
case "$1" in
  --container) v="${FAKE_VIRT_C:-none}" ;;
  --vm) v="${FAKE_VIRT_V:-none}" ;;
  *) v=none ;;
esac
echo "$v"; [ "$v" != none ]
D
printf '#!/usr/bin/env bash\necho "$*" >> "$FAKE/du.log"\nexit 0\n' > "$TMP/bin/du"
chmod +x "$TMP/bin/"*

setup() {
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"; FAKE="$S/fake"; P="$S/proc"
  mkdir -p "$DEPLOY/state" "$REPO/kratos" "$FAKE/docker-root" "$P/pressure"
  cp "$HERE/synap" "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
  cp -R "$HERE/deploy/systemd" "$DEPLOY/systemd"
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\n' > "$DEPLOY/.env"
  export FAKE
  cat > "$P/meminfo" <<'M'
MemTotal:        8000000 kB
MemFree:          500000 kB
MemAvailable:    2000000 kB
Buffers:          100000 kB
SwapTotal:       1048576 kB
SwapFree:         524288 kB
M
  echo "1.50 2.25 3.00 2/389 12345" > "$P/loadavg"
  printf 'processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\nprocessor\t: 3\n' > "$P/cpuinfo"
  printf 'some avg10=12.50 avg60=8.25 avg300=3.00 total=123\nfull avg10=4.00 avg60=2.50 avg300=1.00 total=45\n' > "$P/pressure/memory"
  printf 'some avg10=30.00 avg60=20.00 avg300=10.00 total=999\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' > "$P/pressure/cpu"
  printf 'some avg10=1.00 avg60=0.50 avg300=0.25 total=7\nfull avg10=0.75 avg60=0.25 avg300=0.10 total=3\n' > "$P/pressure/io"
  echo "100000000000 60000000000 40000000000" > "$FAKE/df.deploy"           # data: 60 %
  echo "200000000000 150000000000 30000000000" > "$FAKE/df.docker-root"     # docker: 83.3 % (df's used/(used+avail))
  # The Docker API's /system/df (SystemDataUsageResponse), images + build cache:
  # one image a container uses holds 2.0 GB, 0.5 GB of it shared → used 1.5 GB of 5 GB
  # of layers; build cache 3 GB of own records (+1 GB shared, not counted).
  cat > "$FAKE/system-df.json" <<'J'
{"LayersSize":5000000000,"Images":[{"Id":"sha256:a","Containers":1,"Size":2000000000,"SharedSize":500000000},{"Id":"sha256:b","Containers":0,"Size":1000000000,"SharedSize":0}],"Containers":null,"Volumes":null,"BuildCache":[{"ID":"c1","Size":3000000000,"Shared":false,"InUse":false},{"ID":"c2","Size":1000000000,"Shared":true,"InUse":false}]}
J
  : > "$FAKE/docker.log"; : > "$FAKE/curl.log"; : > "$FAKE/du.log"
}
heal() {
  ( cd "$S" || exit 1; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_PROC_ROOT="$P" SYNAP_LOCK_IMPL=mkdir \
      SYNAP_SYSTEMD_RUN_DIR="$TMP/no-systemd" DOCKER_HOST="unix://$FAKE/docker.sock" bash "$REPO/synap" heal ) >"$S/out" 2>&1 </dev/null
}
R() { jq -c "$1" "$DEPLOY/state/resources.json" 2>/dev/null; }

# ── V. the validator is not vacuous ──────────────────────────────────────────
setup v
echo '{"version":2,"hostKind":"lxc","memory":{"totalBytes":0},"extra":1}' > "$S/bad.json"
n="$(violations "$SCHEMA" "$S/bad.json" | grep -c .)"
violations "$SCHEMA" "$S/bad.json" | grep -q 'version' && violations "$SCHEMA" "$S/bad.json" | grep -q 'unexpected property extra' \
  && violations "$SCHEMA" "$S/bad.json" | grep -q 'missing sampledAt' && violations "$SCHEMA" "$S/bad.json" | grep -q 'memory.totalBytes' \
  && ok "validator: a wrong document gets $n violations (const, extra, missing, minimum)" || bad "validator: blind: $(violations "$SCHEMA" "$S/bad.json")"
jq '.properties.version.oneOf = [1]' "$SCHEMA" > "$S/schema-x.json"; echo '{"version":1}' > "$S/e.json"
violations "$S/schema-x.json" "$S/e.json" | grep -q 'oneOf is not supported' \
  && ok "validator: a schema keyword it does not know fails loudly" || bad "validator: an unknown keyword was ignored"

# ── A. a full host ───────────────────────────────────────────────────────────
setup full
FAKE_VIRT_C=lxc heal; rc=$?
[ "$rc" = 0 ] && [ -s "$DEPLOY/state/resources.json" ] && ok "full: heal exits 0 and writes state/resources.json" || { bad "full: rc=$rc"; tail -5 "$S/out"; }
v="$(violations "$SCHEMA" "$DEPLOY/state/resources.json")"
[ -z "$v" ] && ok "full: valid against host-resources.v1.schema.json" || bad "full: schema violations: $v"
[ "$(R '[.version, .hostKind]')" = '[1,"lxc"]' ] && R .sampledAt | grep -qE '^"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z"$' \
  && ok "full: version 1, hostKind lxc, sampledAt ISO" || bad "full: $(R '[.version,.hostKind,.sampledAt]')"
[ "$(R .memory)" = '{"totalBytes":8192000000,"availableBytes":2048000000,"usedPct":75}' ] \
  && ok "full: memory from MemTotal/MemAvailable (kB × 1024), 75 % used" || bad "full: memory $(R .memory)"
[ "$(R .swap)" = '{"totalBytes":1073741824,"usedBytes":536870912,"usedPct":50}' ] && ok "full: swap 50 % used" || bad "full: swap $(R .swap)"
[ "$(R .pressure)" = '{"memory":{"someAvg10":12.5,"someAvg60":8.25,"fullAvg10":4,"fullAvg60":2.5},"cpu":{"someAvg10":30,"someAvg60":20},"io":{"someAvg10":1,"someAvg60":0.5,"fullAvg10":0.75,"fullAvg60":0.25}}' ] \
  && ok "full: pressure some/full avg10/avg60 (cpu: some only)" || bad "full: pressure $(R .pressure)"
[ "$(R .load)" = '{"avg1":1.5,"avg5":2.25,"cores":4}' ] && ok "full: load 1.5 / 2.25 on 4 cores" || bad "full: load $(R .load)"
[ "$(R '[.disks[] | [.label, .totalBytes, .usedBytes, .availBytes, .usedPct]]')" = '[["data",100000000000,60000000000,40000000000,60],["docker",200000000000,150000000000,30000000000,83.3]]' ] \
  && [ "$(R '.disks[0].path')" = "\"$(cd "$DEPLOY" && pwd -P)\"" ] && [ "$(R '.disks[1].path')" = "\"$FAKE/docker-root\"" ] \
  && ok "full: disks of the deploy dir (data) and Docker's root (docker), df's Use%" || bad "full: disks $(R .disks)"
[ "$(R '.docker | [.buildCacheBytes, .imagesReclaimableBytes]')" = '[3000000000,3500000000]' ] && R .docker.sampledAt | grep -q T \
  && ok "full: docker build cache 3 GB (shared not counted), 3.5 GB of images reclaimable (the CLI's formula)" || bad "full: docker $(R .docker)"
[ "$(stat -c %a "$DEPLOY/state/resources.json" 2>/dev/null || stat -f %Lp "$DEPLOY/state/resources.json")" = 644 ] && [ ! -e "$DEPLOY/state/resources.json.tmp" ] \
  && ok "full: written 0644 (the backend's uid reads it) through a tmp + mv" || bad "full: mode/tmp"

# ── B. what cannot be read is null, never 0 ──────────────────────────────────
setup nulls
rm -f "$P/pressure/memory"                                   # no such file (a kernel without PSI for it)
: > "$P/pressure/cpu"                                        # psi=0: the read returns nothing
printf 'some avg10=1.00\n' > "$P/pressure/io"                # a line without avg60
sed -i.x 's/^SwapTotal:.*/SwapTotal:             0 kB/' "$P/meminfo"; rm -f "$P/meminfo.x"
rm -f "$P/loadavg" "$FAKE/df.docker-root"
FAKE_VIRT_C=lxc heal; rc=$?
[ "$rc" = 0 ] && [ -z "$(violations "$SCHEMA" "$DEPLOY/state/resources.json")" ] && ok "nulls: still written, still valid" || bad "nulls: rc=$rc $(violations "$SCHEMA" "$DEPLOY/state/resources.json")"
[ "$(R '[.pressure.memory, .pressure.cpu, .pressure.io, .swap, .load]')" = '[null,null,null,null,null]' ] \
  && ok "nulls: missing / empty / partial PSI, no swap, no loadavg → null (not 0)" || bad "nulls: $(R '[.pressure, .swap, .load]')"
[ "$(R '[.disks[].label]')" = '["data"]' ] && ok "nulls: a disk df cannot read is left out, not 0 %" || bad "nulls: disks $(R .disks)"
setup nomem
rm -f "$P/meminfo"; chmod 000 "$P/pressure/io"
heal
[ "$(R '[.memory, .swap]')" = '[null,null]' ] && ok "nomem: no meminfo → memory and swap null" || bad "nomem: $(R '[.memory,.swap]')"
if [ "$(id -u)" != 0 ]; then
  [ "$(R .pressure.io)" = null ] && ok "nomem: an unreadable PSI file → null" || bad "nomem: io $(R .pressure.io)"
fi

# ── C. Docker's disk usage: hourly, the API's type filter, never du ──────────
setup docker
heal
grep -q -- "--unix-socket $FAKE/docker.sock http://localhost/system/df?type=image&type=build-cache" "$FAKE/curl.log" \
  && ok "docker: asked the API (DOCKER_HOST's socket) for images and build cache only" || bad "docker: curl calls: $(cat "$FAKE/curl.log")"
first="$(R .docker.sampledAt)"
sleep 1; heal; heal
[ "$(grep -c . "$FAKE/curl.log")" = 1 ] && [ "$(R .docker.sampledAt)" = "$first" ] && [ "$(R .docker.buildCacheBytes)" = 3000000000 ] \
  && ok "docker: 2 more ticks within the hour ask nothing; the last answer is kept with its time" || bad "docker: $(grep -c . "$FAKE/curl.log") asks, sampledAt $(R .docker.sampledAt) vs $first"
echo $(( $(date +%s) - 3601 )) > "$DEPLOY/state/heal/docker-df.at"
jq '.BuildCache[0].Size = 1000000000' "$FAKE/system-df.json" > "$FAKE/x" && mv "$FAKE/x" "$FAKE/system-df.json"
heal
[ "$(grep -c . "$FAKE/curl.log")" = 2 ] && [ "$(R .docker.buildCacheBytes)" = 1000000000 ] \
  && ok "docker: an hour later it asks again and takes the new answer" || bad "docker: asks=$(grep -c . "$FAKE/curl.log") cache=$(R .docker.buildCacheBytes)"
echo $(( $(date +%s) - 3601 )) > "$DEPLOY/state/heal/docker-df.at"
FAKE_CURL_FAIL=1 heal
[ "$(R .docker.buildCacheBytes)" = 1000000000 ] && [ "$(grep -c . "$FAKE/curl.log")" = 3 ] \
  && ok "docker: a failed ask keeps the last answer (and its time)" || bad "docker: after a failed ask $(R .docker)"
FAKE_CURL_FAIL=1 heal
[ "$(grep -c . "$FAKE/curl.log")" = 3 ] && ok "docker: a failed ask is not retried on the next tick" || bad "docker: retried every tick"
! grep -qE '^system df|^system prune' "$FAKE/docker.log" && [ ! -s "$FAKE/du.log" ] \
  && ok "docker: never \`docker system df\` (it walks the volumes) and never du" || bad "docker: docker=$(grep system "$FAKE/docker.log") du=$(cat "$FAKE/du.log")"
setup docker-none
FAKE_CURL_FAIL=1 heal
[ "$(R .docker)" = null ] && [ -z "$(violations "$SCHEMA" "$DEPLOY/state/resources.json")" ] \
  && ok "docker-none: no answer yet → docker null" || bad "docker-none: $(R .docker)"
echo '{"message":"page not found"}' > "$FAKE/system-df.json"; rm -f "$DEPLOY/state/heal/docker-df.at"
heal
[ "$(R .docker)" = null ] && ok "docker-none: an answer that is not a disk usage is not taken" || bad "docker-none: took $(R .docker)"

# ── D. hostKind ──────────────────────────────────────────────────────────────
for c in "lxc none lxc" "none kvm vm" "none none baremetal" "docker none unknown"; do
  set -- $c
  setup "kind-$3"; FAKE_VIRT_C="$1" FAKE_VIRT_V="$2" heal
  [ "$(R .hostKind)" = "\"$3\"" ] && ok "hostKind: container=$1 vm=$2 → $3" || bad "hostKind: container=$1 vm=$2 → $(R .hostKind), want $3"
done

# ── E. read-only, and never fails heal ───────────────────────────────────────
setup readonly
heal
grep -qx 'info --format {{.DockerRootDir}}' "$FAKE/docker.log" && ok "readonly: the sample asks \`docker info\` for Docker's root" || bad "readonly: no docker info call"
writes="$(grep -E '(^|[[:space:]])(rm|rmi|restart|stop|kill|prune|up|down|create|run|exec|start|tag|pull)([[:space:]]|$)' "$FAKE/docker.log")"
[ -z "$writes" ] && ok "readonly: no docker call that changes anything ($(grep -c . "$FAKE/docker.log") calls, all reads)" || bad "readonly: docker calls that act: $writes"
setup cannot-write
mkdir -p "$DEPLOY/state/resources.json.tmp"               # the write fails
heal; rc=$?
[ "$rc" = 0 ] && grep -q "could not write state/resources.json" "$S/out" && [ ! -e "$DEPLOY/state/resources.json" ] \
  && ok "cannot-write: the tick still ends 0, with one line saying the sample was not written" || { bad "cannot-write: rc=$rc"; tail -5 "$S/out"; }

exit $fail
