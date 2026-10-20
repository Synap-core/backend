#!/usr/bin/env bash
# Tripwire: release.json signature verification (D12, WARN mode first).
#
# The REAL `_ue_verify_manifest_sig` (+ the helpers it calls) is cut out of
# `synap` and run against a stub `cosign` and a stub `curl` on PATH — never the
# network, never a real cosign. Covers:
#   1. warn (default): no cosign / no bundle / a bad signature each WARN, exit 0
#   2. enforce: each of those refuses (exit 1); `off` skips cosign entirely
#   3. the verify call carries the identity regexp + GitHub OIDC issuer, and the
#      regexp accepts only docker-publish.yml on main or a v* tag of this repo
#   4. the REAL `synap update` and `synap install` (their own test harnesses):
#      enforce aborts before any pull, warn warns and carries on; CI signs +
#      publishes the bundle on the release AND the pointer
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""'
  grep -E '^_ue_(log|ok|warn|err)\(\) +\{.*\}$' "$HERE/synap"   # one-line loggers
  for fn in _ue_env_get _ue_manifest_url _ue_fetch _ue_cosign_via _ue_cosign_verify _ue_verify_manifest_sig; do
    extract "$fn"
  done
  grep -E '^(SYNAP_RELEASE_BASE_URL_DEFAULT|SYNAP_RELEASE_SIGNER_RE|SYNAP_RELEASE_OIDC_ISSUER|SYNAP_COSIGN_IMAGE)=' "$HERE/synap"
} > "$TMP/lib.sh"
grep -q '^_ue_verify_manifest_sig() {' "$TMP/lib.sh" && grep -q '^SYNAP_RELEASE_SIGNER_RE=' "$TMP/lib.sh" \
  && ok "extracted _ue_verify_manifest_sig + identity constants from synap" \
  || { bad "could not extract the verifier from synap — the scan is blind"; exit 1; }

# ── stubs ─────────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin" "$TMP/rel/channel-fast"
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H|--max-time|--retry) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
src="$STUB_REL/${url#https://rel.test/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
C
cat > "$TMP/bin/cosign" <<'C'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_COSIGN_ARGS"
[ "${STUB_COSIGN_RESULT:-ok}" = ok ] && { echo "Verified OK" >&2; exit 0; }
echo "Error: none of the expected identities matched what was in the certificate" >&2
exit 1
C
# A docker that stands in for sigstore's image: records its args (in its OWN
# file, so which of the two ran is observable), answers like cosign — or, with
# STUB_DOCKER_RC, like a docker that could not run the container at all.
cat > "$TMP/bin/docker" <<'C'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_DOCKER_ARGS"
if [ -n "${STUB_DOCKER_RC:-}" ]; then
  echo "docker: Error response from daemon: Head \"https://ghcr.io/v2/sigstore/cosign/cosign/manifests/sha256:f194\": dial tcp: lookup ghcr.io: no such host." >&2
  exit "$STUB_DOCKER_RC"
fi
[ "${STUB_COSIGN_RESULT:-ok}" = ok ] && { echo "Verified OK" >&2; exit 0; }
echo "Error: none of the expected identities matched what was in the certificate" >&2
exit 1
C
chmod +x "$TMP/bin/curl" "$TMP/bin/cosign" "$TMP/bin/docker"
mkdir -p "$TMP/nocosign" "$TMP/dockeronly"; cp "$TMP/bin/curl" "$TMP/nocosign/curl"
cp "$TMP/bin/curl" "$TMP/bin/docker" "$TMP/dockeronly/"
# The system tools, minus any real cosign/docker (a CI runner has /usr/bin/docker),
# so "neither installed" and "docker only" can be staged anywhere.
mkdir -p "$TMP/sys"
for d in /usr/bin /bin; do for f in "$d"/*; do
  b="${f##*/}"; case "$b" in cosign|docker) continue;; esac
  [ -e "$TMP/sys/$b" ] || ln -s "$f" "$TMP/sys/$b"
done; done
SYS_PATH="$TMP/sys"
for t in cosign docker; do
  PATH="$TMP/nocosign:$SYS_PATH" command -v "$t" >/dev/null 2>&1 \
    && { bad "a real $t is still on the staged PATH — the 'not installed' case cannot be staged"; exit 1; }
done

echo '{"schema":1,"id":"main-abc1234"}' > "$TMP/rel/channel-fast/release.json"

# run <path-dir> <mode|""> [with-bundle 0|1] [cosign-result] [manifest subdir] — prints rc + output
# The manifest lives in <work>/<subdir> while the cwd is <work>, so the docker
# path must mount the manifest's OWN directory, not the cwd.
run() {
  local dir="$1" mode="$2" with_bundle="${3:-1}" res="${4:-ok}" w="$TMP/work" md="$TMP/work${5:+/$5}"
  rm -rf "$w" "$TMP/args" "$TMP/dargs"; mkdir -p "$md"
  rm -f "$TMP/rel/channel-fast/release.json.sigstore.json"
  [ "$with_bundle" = 1 ] && echo '{"bundle":"fake"}' > "$TMP/rel/channel-fast/release.json.sigstore.json"
  cp "$TMP/rel/channel-fast/release.json" "$md/manifest.json"
  ( cd "$w" && export PATH="$TMP/$dir:$SYS_PATH" STUB_REL="$TMP/rel" STUB_COSIGN_ARGS="$TMP/args" STUB_DOCKER_ARGS="$TMP/dargs" \
      STUB_COSIGN_RESULT="$res" SYNAP_RELEASE_BASE_URL="https://rel.test" STUB_DOCKER_RC="${STUB_DOCKER_RC:-}"
    [ -n "$mode" ] && export SYNAP_RELEASE_VERIFY="$mode"
    set +u -e   # synap's own options (set -e, no -u)
    # shellcheck source=/dev/null
    . "$TMP/lib.sh"
    rc=0; _ue_verify_manifest_sig fast "$md/manifest.json" > "$TMP/out" 2>&1 || rc=$?; echo "rc=$rc" >> "$TMP/out" )
}
expect() { # <label> <want-rc> <want-substring>
  if grep -q "rc=$2" "$TMP/out" && grep -qF -- "$3" "$TMP/out"; then ok "$1"
  else bad "$1 — got: $(tr '\n' ' ' < "$TMP/out")"; fi
}

# ── 1. warn mode (the default) never blocks ──────────────────────────────────
run nocosign ""            ; expect "warn: no cosign binary → warning, continues"      0 "cosign is not installed"
run bin ""      0          ; expect "warn: no published bundle → warning, continues"  0 "no signature (release.json.sigstore.json)"
run bin ""      1 fail     ; expect "warn: bad signature → warning, continues"        0 "does not verify as Synap CI"
grep -qF "none of the expected identities" "$TMP/out" && ok "warn: cosign's own reason is surfaced" || bad "cosign reason not surfaced"
run bin ""      1 ok       ; expect "a good signature → verified"                      0 "signature verified"
run bin bogus   1 fail     ; expect "an unknown mode falls back to warn"               0 "using warn"

# ── 2. enforce refuses, off skips ────────────────────────────────────────────
run nocosign enforce       ; expect "enforce: no cosign → refused"                     1 "refused: cosign is not installed"
run bin enforce 0          ; expect "enforce: no bundle → refused"                     1 "refused: no signature"
run bin enforce 1 fail     ; expect "enforce: bad signature → refused"                 1 "refused: the signature does not verify"
run bin enforce 1 ok       ; expect "enforce: good signature → accepted"               0 "signature verified"
# No host cosign (nothing installs one on a pod host): sigstore's image through docker.
# The manifest sits in a SUBDIRECTORY of the cwd whose name holds a ':' (which
# `-v src:dst` would split): the mount must name that directory, whole.
run dockeronly enforce 1 ok "sub:dir" ; expect "enforce: no cosign, docker → verified through the pinned image" 0 "signature verified"
dargs="$(tr '\n' ' ' < "$TMP/dargs" 2>/dev/null)"
for want in "run --rm" "--read-only" "--cap-drop ALL" "--security-opt no-new-privileges" \
            "--tmpfs /home/nonroot:uid=65532,gid=65532" \
            "--mount type=bind,src=$TMP/work/sub:dir,dst=/release,readonly" \
            "ghcr.io/sigstore/cosign/cosign:" "verify-blob" "--certificate-identity-regexp" \
            "--certificate-oidc-issuer https://token.actions.githubusercontent.com" \
            "--bundle /release/manifest.json.sigstore.json /release/manifest.json"; do
  grep -qF -- "$want" <<<"$dargs" && ok "docker cosign called with $want" || bad "docker cosign args lack '$want': $dargs"
done
grep -qE '(^| )-v ' <<<"$dargs" && bad "docker cosign still uses -v (a ':' in the path breaks it): $dargs" || ok "docker cosign uses --mount, never -v"
run dockeronly enforce 1 fail; expect "enforce: no cosign, docker, bad signature → refused" 1 "refused: the signature does not verify"
# docker could not run the container (daemon down, pull failed: 125/126/127):
# still fails closed, but it is NOT a bad signature and must not read as one.
for drc in 125 126 127; do
  STUB_DOCKER_RC=$drc run dockeronly enforce 1 ok
  expect "enforce: docker exits $drc → refused as 'could not run the signature check'" 1 "refused: could not run the signature check (docker exited $drc"
  grep -q "does not verify" "$TMP/out" && bad "docker $drc reported as a bad signature" || ok "docker $drc is not called a bad signature"
done
STUB_DOCKER_RC=125 run dockeronly "" 1 ok; expect "warn: docker exits 125 → warning, continues" 0 "NOT signature-verified: could not run the signature check"
# A host cosign wins over docker: only cosign runs.
run bin enforce 1 ok
[ -s "$TMP/args" ] && [ ! -e "$TMP/dargs" ] && ok "a host cosign is used, docker run is never called" || bad "precedence: cosign args=$([ -s "$TMP/args" ] && echo y || echo n), docker called=$([ -e "$TMP/dargs" ] && echo y || echo n)"
# The image CI signs with and the image pods verify with are the same cosign.
ci_ver="$(sed -n 's/^[[:space:]]*cosign-release:[[:space:]]*"\{0,1\}\(v[0-9][0-9.]*\)"\{0,1\}.*/\1/p' "$HERE/.github/workflows/docker-publish.yml" | head -1)"
img_ver="$(sed -n 's/^SYNAP_COSIGN_IMAGE="ghcr\.io\/sigstore\/cosign\/cosign:\(v[0-9][0-9.]*\)@.*/\1/p' "$HERE/synap")"
[ -n "$ci_ver" ] && [ "$ci_ver" = "$img_ver" ] && ok "CI cosign-release ($ci_ver) = SYNAP_COSIGN_IMAGE tag ($img_ver)" || bad "CI cosign-release '$ci_ver' != SYNAP_COSIGN_IMAGE tag '$img_ver'"
grep -qE '^SYNAP_COSIGN_IMAGE="ghcr\.io/sigstore/cosign/cosign:v[0-9.]+@sha256:[0-9a-f]{64}"$' "$HERE/synap" \
  && ok "the cosign image is pinned by digest" || bad "SYNAP_COSIGN_IMAGE is not pinned by a sha256 digest"
run bin off     1 fail     ; expect "off: skipped"                                     0 "rc=0"
[ ! -e "$TMP/args" ] && ok "off: cosign is never called" || bad "off still ran cosign"
# deploy/.env is the founder's switch, like SYNAP_EDGE
( w="$TMP/work"; rm -rf "$w"; mkdir -p "$w"; echo "SYNAP_RELEASE_VERIFY=enforce" > "$w/.env"
  cp "$TMP/rel/channel-fast/release.json" "$w/manifest.json"; rm -f "$TMP/rel/channel-fast/release.json.sigstore.json"
  cd "$w" && export PATH="$TMP/bin:$SYS_PATH" STUB_REL="$TMP/rel" STUB_COSIGN_ARGS="$TMP/args" SYNAP_RELEASE_BASE_URL="https://rel.test"
  unset SYNAP_RELEASE_VERIFY; set +u -e; . "$TMP/lib.sh"
  rc=0; _ue_verify_manifest_sig fast "$w/manifest.json" > "$TMP/out" 2>&1 || rc=$?; echo "rc=$rc" >> "$TMP/out" )
expect "deploy/.env SYNAP_RELEASE_VERIFY=enforce is honoured" 1 "refused"

# ── 3. what is checked: identity + issuer ────────────────────────────────────
run bin "" 1 ok
args="$(tr '\n' ' ' < "$TMP/args")"
for want in "verify-blob" "--bundle" "--certificate-identity-regexp" "--certificate-oidc-issuer https://token.actions.githubusercontent.com" "manifest.json"; do
  grep -qF -- "$want" <<<"$args" && ok "cosign called with $want" || bad "cosign args lack '$want': $args"
done
RE="$(grep -E '^SYNAP_RELEASE_SIGNER_RE=' "$HERE/synap" | sed -E "s/^[^=]+='(.*)'$/\1/")"
python3 - "$RE" <<'PY' && ok "identity regexp: docker-publish.yml on main or v* only, this repo only" || bad "identity regexp accepts/rejects the wrong identities"
import re, sys
r = re.compile(sys.argv[1]); base = "https://github.com/Synap-core/backend/.github/workflows/"
good = [base + "docker-publish.yml@refs/heads/main", base + "docker-publish.yml@refs/tags/v1.2.3",
        "https://github.com/synap-core/backend/.github/workflows/docker-publish.yml@refs/heads/main"]
badl = [base + "docker-publish.yml@refs/heads/develop", base + "ci.yml@refs/heads/main",
        base + "docker-publish.yml@refs/pull/7/merge", base + "docker-publish.yml@refs/heads/main-evil",
        "https://github.com/evil/backend/.github/workflows/docker-publish.yml@refs/heads/main",
        "https://github.com/Synap-core/backend-fork/.github/workflows/docker-publish.yml@refs/heads/main"]
errs = [g for g in good if not r.search(g)] + [b for b in badl if r.search(b)]
for e in errs: print("   ✗", e)
sys.exit(1 if errs else 0)
PY

# ── 4. wiring, BEHAVIOURAL: the REAL `synap update` / `synap install` ─────────
# Each door runs inside the existing daemon-free harness of its own test
# (update-engine.test.sh / install-register.test.sh, everything up to their first
# scenario), with a stub `cosign` that exits 1 and a published bundle, so the
# door reaches cosign and gets "does not verify". enforce must abort BEFORE any
# image is pulled; warn must warn and carry on to the pull. A door whose verify
# call is skipped or removed fails both (verified: `if false && …` on each door).
harness() { awk -v m="$2" 'index($0, m) == 1 {exit} {print}' "$HERE/deploy/__tests__/$1"; }
stub_cosign() { printf '#!/usr/bin/env bash\necho "$*" >> "%s/cosign.log"\necho "Error: none of the expected identities matched" >&2\nexit 1\n' "$1" > "$1/bin/cosign"; chmod +x "$1/bin/cosign"; }

( eval "$(harness update-engine.test.sh '# ── 1. happy path')"
  declare -F setup publish run_update >/dev/null || { echo "FAIL - update harness not loaded (marker moved?)"; exit 1; }
  stub_cosign "$TMP"
  for mode in enforce warn; do
    setup "sig-$mode" r1; publish "$R2" 0012_new.sql
    echo '{"bundle":"fake"}' > "$TMP/rel/$R2/release.json.sigstore.json"; : > "$TMP/cosign.log"
    SYNAP_RELEASE_VERIFY=$mode run_update --release "$R2"; rc=$?
    reached=$([ -s "$TMP/cosign.log" ] && echo y || echo n)
    pulled=$(grep -q '^pull ' "$FAKE/log" && echo y || echo n)
    if [ "$mode" = enforce ]; then
      [ "$rc" != 0 ] && [ "$reached" = y ] && [ "$pulled" = n ] && grep -q "refused: the signature does not verify" "$S/out" \
        && cmp -s "$DEPLOY/.env" "$S/env.orig" && [ "$(last status)" = aborted ] \
        && ok "update/enforce: cosign rejects → aborted before any pull, .env untouched" \
        || { bad "update/enforce: rc=$rc cosign=$reached pulled=$pulled status=$(last status)"; show; }
    else
      [ "$rc" = 0 ] && [ "$reached" = y ] && [ "$pulled" = y ] && grep -q "NOT signature-verified: the signature does not verify" "$S/out" \
        && ok "update/warn: cosign rejects → warning, update carries on and succeeds" \
        || { bad "update/warn: rc=$rc cosign=$reached pulled=$pulled"; show; }
    fi
  done
  exit $fail ) || fail=1

( eval "$(harness install-register.test.sh '# ── flags:')"
  declare -F setup run_install >/dev/null || { echo "FAIL - install harness not loaded (marker moved?)"; exit 1; }
  stub_cosign "$TMP"
  echo '{"bundle":"fake"}' > "$TMP/srv/rel/$REL/release.json.sigstore.json"
  for mode in enforce warn; do
    setup "sig-$mode"; : > "$FAKE/docker.log"; : > "$TMP/cosign.log"
    SYNAP_RELEASE_VERIFY=$mode run_install --non-interactive --release "$REL" --domain pod.example.org --email ops@example.org; rc=$?
    reached=$([ -s "$TMP/cosign.log" ] && echo y || echo n)
    pulled=$(grep -q '^pull ' "$FAKE/docker.log" && echo y || echo n)
    if [ "$mode" = enforce ]; then
      [ "$rc" != 0 ] && [ "$reached" = y ] && [ "$pulled" = n ] && grep -q "refused: the signature does not verify" "$S/out" \
        && ! grep -qE '^compose .* up ' "$FAKE/docker.log" \
        && ok "install/enforce: cosign rejects → aborted before any pull or start" \
        || { bad "install/enforce: rc=$rc cosign=$reached pulled=$pulled"; show; }
    else
      [ "$rc" = 0 ] && [ "$reached" = y ] && [ "$pulled" = y ] && grep -q "NOT signature-verified: the signature does not verify" "$S/out" \
        && ok "install/warn: cosign rejects → warning, install carries on and succeeds" \
        || { bad "install/warn: rc=$rc cosign=$reached pulled=$pulled"; show; }
    fi
  done
  exit $fail ) || fail=1

# CI side: the workflow signs + publishes the bundle.
python3 - "$HERE/.github/workflows/docker-publish.yml" "$RE" <<'PY' && ok "docker-publish.yml signs release.json keyless and publishes the bundle on release + pointer" || bad "docker-publish.yml signing broke (see above)"
import sys, yaml, re
wf = yaml.safe_load(open(sys.argv[1])); pr = wf["jobs"]["publish-release"]; fails = []
def need(c, m):
    if not c: fails.append(m); print("   ✗", m)
need((pr.get("permissions") or {}).get("id-token") == "write", "publish-release lacks id-token: write")
uses = [s.get("uses", "") for s in pr["steps"]]
need(any(re.match(r"sigstore/cosign-installer@[0-9a-f]{40}$", u.split(" ")[0]) for u in uses), "cosign-installer missing or not SHA-pinned")
runs = [str(s.get("run", "")) for s in pr["steps"]]
sign = next((i for i, r in enumerate(runs) if "cosign sign-blob" in r), None)
pub = next((i for i, r in enumerate(runs) if "gh release upload \"$POINTER\"" in r), None)
need(sign is not None and "--bundle release.json.sigstore.json" in runs[sign], "release.json is not signed into release.json.sigstore.json")
need(sign is not None and pub is not None and sign < pub, "signing does not happen before publishing")
if pub is not None:
    assets = [l.strip() for l in runs[pub].splitlines() if l.strip().startswith("ASSETS=(")]
    need("release.json.sigstore.json" in runs[pub] and assets and "SIG_ASSETS[@]" in assets[0], "bundle not on the release assets")
    need('upload "$POINTER" release.json "${SIG_ASSETS[@]}"' in runs[pub], "bundle not moved with the channel pointer")
# The verifier's identity must name THIS workflow file.
need("docker-publish" in sys.argv[2] and re.search(sys.argv[2], "https://github.com/Synap-core/backend/.github/workflows/docker-publish.yml@refs/heads/main"), "synap's signer identity does not name docker-publish.yml")
sys.exit(1 if fails else 0)
PY
exit $fail
