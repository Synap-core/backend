#!/usr/bin/env bash
# Tripwire: the release manifest contract (update-door plan P1).
#
#  1. make-manifest.py builds a manifest the ENGINE accepts (validated with the
#     engine's own jq rules via deploy/release/validate-manifest.sh), covering
#     every SYNAP_IMAGE_* the compose file consumes — derived, not hand-listed.
#  2. The validator rejects each way a manifest can lie (unpinned image, missing
#     image, bad commit, local id on a registry release, ghcr-less local build…).
#  1b. minFrom is derived from the `synap:contract-of` markers (in a shallow,
#     tagless clone like CI's), never names the release being built, and an
#     expand no release shipped refuses the manifest.
#  3. The publish workflow keeps the P1 promises: pod-admin is published, no
#     `latest` tag, no unused backend-realtime image, images by digest into a
#     validated release.json, CP notified only after the release exists.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }
VALIDATE="$HERE/deploy/release/validate-manifest.sh"
D() { printf "$1%.0s" $(seq 1 64); }

KEYS="$(grep -oE '\$\{SYNAP_IMAGE_[A-Z0-9_]+' "$HERE/deploy/docker-compose.yml" | sed 's/^\${//' | sort -u)"
n=$(echo "$KEYS" | grep -c .)
[ "$n" -ge 8 ] && ok "compose consumes $n SYNAP_IMAGE_* (contract derived from the file)" || bad "only $n image keys found"
for must in SYNAP_IMAGE_BACKEND SYNAP_IMAGE_POD_ADMIN SYNAP_IMAGE_POD_AGENT SYNAP_IMAGE_POSTGRES SYNAP_IMAGE_MINIO SYNAP_IMAGE_KRATOS SYNAP_IMAGE_CADDY SYNAP_IMAGE_REDIS SYNAP_IMAGE_TYPESENSE; do
  grep -qx "$must" <<<"$KEYS" || bad "compose does not pin $must"
done

# Every third-party default must be pinnable: a release writes `<default>@sha256:…`
# and both make-manifest's DIGEST rule and the pods' `synap` engine accept only a
# LOWERCASE reference. An uppercase tag (MinIO's RELEASE.…T…Z) passed every
# gate and failed the v1.1.1 publish at its last step.
bad_refs="$(grep -oE '\$\{SYNAP_IMAGE_[A-Z0-9_]+:-[^}$]+\}' "$HERE/deploy/docker-compose.yml" | sed -E 's/^\$\{[A-Z0-9_]+:-//; s/\}$//' | grep -vE '^[a-z0-9][a-z0-9._/:-]*$' || true)"
[ "$(grep -cE '\$\{SYNAP_IMAGE_[A-Z0-9_]+:-[^}$]+\}' "$HERE/deploy/docker-compose.yml")" -ge 5 ] || bad "third-party image defaults: scan found too few"
[ -z "$bad_refs" ] && ok "every third-party image default is a lowercase, pinnable reference" || bad "image defaults the release cannot pin: $bad_refs"
# ── 1. generate (all digests given → no registry access) and validate ─────────
args=()
for k in $KEYS; do args+=(--image "$k=example.org/$(echo "$k" | tr 'A-Z_' 'a-z-'):t@sha256:$(D a)"); done
echo "bundle" > "$TMP/synap-deploy-main-abc1234.tar.gz"
python3 "$HERE/deploy/release/make-manifest.py" --repo-root "$HERE" --id main-abc1234 --channel fast \
  --git-sha "$(printf 'c%.0s' $(seq 1 40))" "${args[@]}" --bundle "$TMP/synap-deploy-main-abc1234.tar.gz" > "$TMP/good.json" 2>"$TMP/err" \
  && ok "make-manifest.py produced a manifest" || bad "make-manifest.py failed: $(cat "$TMP/err")"
bash "$VALIDATE" "$TMP/good.json" >"$TMP/v" 2>&1 && ok "engine rules accept it: $(cat "$TMP/v")" || bad "engine rules reject the generated manifest: $(cat "$TMP/v")"
newest="$(ls "$HERE"/packages/database/migrations/*.sql | sort | tail -1 | xargs basename)"
[ "$(jq -r .migrations.last "$TMP/good.json")" = "$newest" ] && ok "migrations.last = newest migration file ($newest)" || bad "migrations.last=$(jq -r .migrations.last "$TMP/good.json")"
want="sha256:$(shasum -a 256 "$HERE/deploy/docker-compose.yml" 2>/dev/null | cut -d' ' -f1 || sha256sum "$HERE/deploy/docker-compose.yml" | cut -d' ' -f1)"
[ "$(jq -r .composeSha "$TMP/good.json")" = "$want" ] && ok "composeSha = sha256 of deploy/docker-compose.yml" || bad "composeSha mismatch"
jq -e '.envSchemaVersion | test("^sha256:[0-9a-f]{64}$")' "$TMP/good.json" >/dev/null && ok "envSchemaVersion derived from deploy/.env.example" || bad "envSchemaVersion: $(jq .envSchemaVersion "$TMP/good.json")"
jq -e '.bundle.asset == "synap-deploy-main-abc1234.tar.gz" and (.bundle.sha256|length) == 64' "$TMP/good.json" >/dev/null && ok "bundle asset + sha256 recorded" || bad "bundle: $(jq -c .bundle "$TMP/good.json")"
[ "$(jq '.images|length' "$TMP/good.json")" = "$n" ] && ok "one image per compose key" || bad "images: $(jq -c '.images|keys' "$TMP/good.json")"

# make-manifest refuses to emit a lie
python3 "$HERE/deploy/release/make-manifest.py" --repo-root "$HERE" --id x --channel fast --git-sha "$(printf 'c%.0s' $(seq 1 40))" \
  $(for k in $KEYS; do [ "$k" = SYNAP_IMAGE_BACKEND ] || echo "--image $k=r@sha256:$(D a)"; done) >/dev/null 2>"$TMP/err" \
  && bad "make-manifest.py accepted a missing first-party digest" || { grep -q "SYNAP_IMAGE_BACKEND is a first-party image" "$TMP/err" && ok "make-manifest refuses a missing first-party digest" || bad "wrong refusal: $(cat "$TMP/err")"; }
python3 "$HERE/deploy/release/make-manifest.py" --repo-root "$HERE" --id x --channel fast --git-sha "$(printf 'c%.0s' $(seq 1 40))" \
  $(for k in $KEYS; do [ "$k" = SYNAP_IMAGE_REDIS ] && echo "--image $k=redis:7-alpine" || echo "--image $k=r@sha256:$(D a)"; done) >/dev/null 2>"$TMP/err" \
  && bad "make-manifest.py accepted an unpinned image" || ok "make-manifest refuses an unpinned image"

# ── 1b. minFrom is DERIVED from the contract-of markers (never hand-set) ──────
# Rollback swaps images only, so a release carrying a CONTRACT migration may
# only be applied by a pod that already ran the release shipping its EXPAND.
MF="$(cat "$HERE"/packages/database/migrations/*.sql | grep -cE '^[[:space:]]*--[[:space:]]*synap:contract-of[[:space:]]' || true)"
if [ "$MF" = 0 ]; then
  jq -e '.minFrom == null and .minFromRelease == null' "$TMP/good.json" >/dev/null \
    && ok "this tree has no contract-of marker → minFrom null" || bad "no marker, yet minFrom=$(jq -c '[.minFrom,.minFromRelease]' "$TMP/good.json")"
else
  jq -e '(.minFrom|type) == "string" and (.minFromRelease|type) == "string"' "$TMP/good.json" >/dev/null \
    && ok "this tree has $MF contract-of marker(s) → minFrom $(jq -r .minFrom "$TMP/good.json") (take $(jq -r .minFromRelease "$TMP/good.json") first)" \
    || bad "$MF contract-of marker(s) but minFrom=$(jq -c '[.minFrom,.minFromRelease]' "$TMP/good.json")"
fi
command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || { echo "FAIL - git and node are required"; exit 1; }
G() { git -c user.email=t@t -c user.name=t -c init.defaultBranch=main "$@"; }
M=packages/database/migrations
# origin: v0.9.0 predates the migrations dir (like the real v1.0.x); v1.0.0
# ships 0001_init; v1.1.0 ships 0002_expand + 0003_other; main adds
# 0004_contract (contract-of 0002_expand.sql AND of 0001_init.sql).
O="$TMP/mf-src"; mkdir -p "$O/deploy" "$O/scripts"
cp "$HERE/deploy/docker-compose.yml" "$HERE/deploy/.env.example" "$O/deploy/"
cp "$HERE/scripts/release-min-from.mjs" "$HERE/scripts/check-migrations-forward-only.mjs" "$O/scripts/"
( cd "$O" && G init -q && G add -A && G commit -qm v0.9 && G tag v0.9.0 && mkdir -p "$M" \
  && printf 'CREATE TABLE t (id int, old_col text);\n' > "$M/0001_init.sql" && G add -A && G commit -qm v1.0 && G tag v1.0.0 \
  && printf 'ALTER TABLE t ADD COLUMN new_col text;\n' > "$M/0002_expand.sql" && printf 'SELECT 1;\n' > "$M/0003_other.sql" \
  && G add -A && G commit -qm v1.1 && G tag v1.1.0 \
  && printf -- '-- synap:contract-of 0002_expand.sql\n-- synap:contract-of 0001_init.sql\nALTER TABLE t DROP COLUMN old_col;\n' > "$M/0004_contract.sql" \
  && G add -A && G commit -qm main )
G clone -q --bare "$O" "$TMP/mf-origin.git"
G clone -q --depth=1 --no-tags "file://$TMP/mf-origin.git" "$TMP/mf-ci"
[ -z "$(git -C "$TMP/mf-ci" tag -l)" ] && ok "fixture: the CI-shaped clone (shallow, no tags) has no tags" || bad "fixture: the CI-shaped clone has tags"
mm() { # <repo-root> <id> [extra args] → $TMP/mf.json, rc
  python3 "$HERE/deploy/release/make-manifest.py" --repo-root "$1" --id "$2" --channel fast --git-sha "$(printf 'c%.0s' $(seq 1 40))" \
    $(for k in $KEYS; do echo "--image $k=r@sha256:$(D a)"; done) "${@:3}" > "$TMP/mf.json" 2>"$TMP/mf.err"
}
mm "$TMP/mf-ci" main-abc1234; rc=$?
[ "$rc" = 0 ] && jq -e '.minFrom == "0003_other.sql" and .minFromRelease == "v1.1.0"' "$TMP/mf.json" >/dev/null \
  && ok "derived in the CI shape: minFrom = the newest migration of the newest release that first shipped a marked expand (0003_other.sql, v1.1.0)" \
  || bad "derived minFrom: rc=$rc $(jq -c '[.minFrom,.minFromRelease]' "$TMP/mf.json" 2>/dev/null) $(cat "$TMP/mf.err")"
bash "$VALIDATE" "$TMP/mf.json" >"$TMP/v" 2>&1 && ok "engine rules accept the derived floor" || bad "engine rules reject the derived floor: $(cat "$TMP/v")"
# the release being built never counts as having shipped its own expand
( cd "$O" && G tag v1.2.0 && G tag -d v1.1.0 >/dev/null && G tag v1.1.0 HEAD~1 )
mm "$O" v1.2.0; rc=$?
[ "$rc" = 0 ] && [ "$(jq -r .minFromRelease "$TMP/mf.json")" = v1.1.0 ] && ok "building v1.2.0 (tagged too): the floor stays v1.1.0" || bad "exclude: rc=$rc $(cat "$TMP/mf.err")"
( cd "$O" && G tag -d v1.1.0 >/dev/null )
mm "$O" v1.2.0; rc=$?
[ "$rc" != 0 ] && grep -q "cannot derive minFrom: contract-of names 0002_expand.sql, which no release" "$TMP/mf.err" \
  && ok "an expand only the release being built ships → no manifest (never a wrong floor)" || bad "unshipped expand: rc=$rc $(cat "$TMP/mf.err")"
mm "$O" main-abc1234 --min-from 0003_other.sql; rc=$?
[ "$rc" != 0 ] && grep -q "needs --min-from-release" "$TMP/mf.err" && ok "an explicit --min-from must name the release to take first" || bad "explicit floor without release: rc=$rc"
mm "$O" main-abc1234 --min-from ../x --min-from-release v1.1.0; rc=$?
[ "$rc" != 0 ] && grep -q "expected auto or a migration file name" "$TMP/mf.err" && ok "an explicit --min-from must be a migration file name" || bad "bad explicit floor: rc=$rc"

# ── 2. the validator rejects each lie ─────────────────────────────────────────
reject() { # <label> <jq-mutation> <expected-reason-substring> [base]
  jq "$2" "${4:-$TMP/good.json}" > "$TMP/m.json"
  if bash "$VALIDATE" "$TMP/m.json" >/dev/null 2>"$TMP/err"; then bad "accepted: $1"
  elif grep -q -- "$3" "$TMP/err"; then ok "rejects $1"
  else bad "rejected $1 for the wrong reason: $(cat "$TMP/err")"; fi
}
reject "an image pinned by tag only"         '.images.SYNAP_IMAGE_REDIS = "redis:7-alpine"'                  "SYNAP_IMAGE_REDIS is not pinned by digest"
reject "an image the compose file needs"     'del(.images.SYNAP_IMAGE_MINIO)'                                 "SYNAP_IMAGE_MINIO (used by docker-compose.yml) is missing"
reject "a short commit"                      '.gitSha = "abc1234"'                                            "gitSha must be a full 40-hex commit"
reject "a local-* id on a registry release"  '.id = "local-abc"'                                              "reserved for --from-source"
reject "a synap-dev image on a registry release" '.images.SYNAP_IMAGE_BACKEND = "synap-dev/backend:abc"' "SYNAP_IMAGE_BACKEND is not pinned by digest"
reject "an unknown schema"                   '.schema = 2'                                                    "schema must be 1"
reject "a missing migration level"           'del(.migrations)'                                               "migrations.last"
reject "a malformed compose sha"             '.composeSha = "abc"'                                            "composeSha"
reject "a path in the id"                    '.id = "../../etc"'                                              "id is missing or malformed"
reject "a minFrom that is not a migration file" '.minFrom = "../x"'                                         "minFrom must be null or a migration filename"
reject "a malformed minFromRelease"          '.minFrom = "0001_a.sql" | .minFromRelease = "../v1"'           "minFromRelease must be null or a release id"
reject "a minFromRelease without minFrom"    '.minFrom = null | .minFromRelease = "v1.1.0"'                  "minFromRelease is set without minFrom"
# a from-source manifest: synap-dev allowed for the two built images only
jq '.source = true | .id = "local-abc123" | .images = {SYNAP_IMAGE_BACKEND:"synap-dev/backend:abc123", SYNAP_IMAGE_POD_ADMIN:"synap-dev/pod-admin:abc123"}' "$TMP/good.json" > "$TMP/src.json"
bash "$VALIDATE" "$TMP/src.json" >/dev/null 2>"$TMP/err" && ok "accepts a from-source manifest (synap-dev for backend + pod-admin)" || bad "from-source manifest rejected: $(cat "$TMP/err")"
reject "a synap-dev third-party image" '.images.SYNAP_IMAGE_REDIS = "synap-dev/redis:abc"' "SYNAP_IMAGE_REDIS may not be a synap-dev build" "$TMP/src.json"

# ── 3. the publish workflow keeps the P1 promises ────────────────────────────
python3 - "$HERE/.github/workflows/docker-publish.yml" <<'PY' && ok "docker-publish.yml: pod-admin published, no :latest, no backend-realtime, digests → validated release.json, CP after release" || { bad "docker-publish.yml broke a P1 promise (see above)"; }
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
jobs = wf["jobs"]; text = open(sys.argv[1]).read(); fails = []
def need(c, m):
    if not c: fails.append(m); print("   ✗", m)
need("build-and-push-pod-admin" in jobs, "no pod-admin publish job")
need("value=latest" not in text, "a :latest tag is still pushed")
need("backend-realtime" not in text, "the unused backend-realtime image is still built")
for j in ("build-and-push-backend-api", "build-and-push-pod-agent", "build-and-push-pod-admin"):
    need("digest" in (jobs.get(j, {}).get("outputs") or {}), f"{j} does not output its digest")
    need("sha-${{ steps.resolve.outputs.sha }}" in str(jobs.get(j, {})), f"{j} does not push the immutable sha-<full> tag")
pr = jobs.get("publish-release", {}); steps = " ".join(str(s.get("run", "")) for s in pr.get("steps", []))
need("make-manifest.py" in steps and "validate-manifest.sh release.json" in steps, "publish-release does not build + validate release.json")
import re
need(re.search(r"--min-from\s+(?!auto\b)", steps) is None, "publish-release hand-sets --min-from (it must be derived: --min-from auto)")
need(all(f"needs.{j}.outputs.digest" in steps for j in ("build-and-push-backend-api", "build-and-push-pod-admin", "build-and-push-pod-agent")), "release.json is not fed the build digests")
need(steps.index("gh release upload \"$POINTER\"") > steps.index("gh release create \"$ID\"") if "gh release upload \"$POINTER\"" in steps and "gh release create \"$ID\"" in steps else False, "the channel pointer is not moved after the release exists")
need("publish-release" in (jobs.get("notify-control-plane", {}).get("needs") or []), "CP is notified before the release manifest exists")
on = wf.get("on", wf.get(True, {}))
need("branches" not in (on.get("push") or {}), "branch pushes still build images before CI is green (sha-<full> written twice)")
backend_push = [s for s in jobs["build-and-push-backend-api"]["steps"] if s.get("id") == "push"]
need(backend_push and "GIT_SHA" in str(backend_push[0].get("with", {}).get("build-args", "")), "backend image is not stamped with GIT_SHA (verify would fail every release)")
sys.exit(1 if fails else 0)
PY
exit $fail
