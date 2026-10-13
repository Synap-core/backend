#!/usr/bin/env bash
# The pod startup template (deploy/cloud-init/pod-user-data.yaml.tmpl,
# PODPROV-CONTRACT §5): placeholders → expected bytes.
#
# The Control Plane (managed pods) and the Hetzner Cloud capability (BYO pods)
# both render it by plain substitution of the five placeholders, and must
# produce IDENTICAL bytes. fixtures/pod-user-data.rendered.yaml is that render
# for the values below — a renderer in another repo can be checked against the
# same file.
#
# Asserts: the template's placeholder set is EXACTLY the contract's five
# (derived from the file); the render equals the fixture byte for byte; the
# render is valid YAML with no placeholder left; its runcmd script parses
# (bash -n) and, run with a fake curl/bootstrapper, downloads the bootstrapper
# for that release and calls it with exactly the contract's flags, then deletes
# the code from disk. NOT covered: a real cloud-init run (NEEDS-DOGFOOD on a VM).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPL="$HERE/deploy/cloud-init/pod-user-data.yaml.tmpl"
FIXTURE="$HERE/deploy/__tests__/fixtures/pod-user-data.rendered.yaml"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

RELEASE="v0.1.0"; TOKEN="spr_abcdefghijklmnopqrstuvwxyz234567abcd"; NAME="lab1"
CP="https://api.synap.live"; EDGE="caddy"

render() { # <template> <out>
  python3 - "$1" "$2" "$RELEASE" "$TOKEN" "$NAME" "$CP" "$EDGE" <<'PY'
import sys
src, out, release, token, name, cp, edge = sys.argv[1:]
s = open(src, encoding="utf-8").read()
for k, v in {"RELEASE": release, "REGISTER_TOKEN": token, "NAME": name,
             "CONTROL_PLANE_URL": cp, "EDGE": edge}.items():
    s = s.replace("{{" + k + "}}", v)
open(out, "w", encoding="utf-8").write(s)
PY
}

found="$(grep -oE '\{\{[A-Z_]+\}\}' "$TMPL" | sort -u | tr '\n' ' ')"
want="{{CONTROL_PLANE_URL}} {{EDGE}} {{NAME}} {{REGISTER_TOKEN}} {{RELEASE}} "
[ "$found" = "$want" ] && ok "template placeholders are exactly the contract's five" || bad "placeholders: '$found' (want '$want')"

render "$TMPL" "$TMP/rendered.yaml"
if [ "${UPDATE_FIXTURE:-}" = 1 ]; then cp "$TMP/rendered.yaml" "$FIXTURE"; echo "fixture updated"; fi
cmp -s "$TMP/rendered.yaml" "$FIXTURE" && ok "render equals fixtures/pod-user-data.rendered.yaml byte for byte" \
  || { bad "render differs from the fixture (UPDATE_FIXTURE=1 after a deliberate template change)"; diff "$FIXTURE" "$TMP/rendered.yaml" | head -20; }
grep -q '{{' "$TMP/rendered.yaml" && bad "a placeholder survived the render" || ok "no placeholder left after render"
[ "$(grep -c "$TOKEN" "$TMP/rendered.yaml")" = 1 ] && ok "the code appears exactly once (the 0600 install.env)" || bad "the code appears $(grep -c "$TOKEN" "$TMP/rendered.yaml") times"

python3 - "$TMP/rendered.yaml" "$TMP/runcmd.sh" <<'PY' && ok "render is valid #cloud-config YAML" || bad "render is not valid cloud-config YAML"
import sys, yaml
raw = open(sys.argv[1]).read()
assert raw.startswith("#cloud-config\n")
d = yaml.safe_load(raw)
cmd = d["runcmd"][0]
assert cmd[:2] == ["bash", "-c"], cmd[:2]
wf = [f for f in d["write_files"] if f["path"] == "/etc/synap/install.env"][0]
assert wf["permissions"] == "0600"
open(sys.argv[2], "w").write(cmd[2])
open(sys.argv[2] + ".env", "w").write(wf["content"])
PY
bash -n "$TMP/runcmd.sh" && ok "runcmd script parses (bash -n)" || bad "runcmd script has a syntax error"

# Run it with its host paths moved into $TMP and a fake curl that serves a stub bootstrapper.
mkdir -p "$TMP/bin" "$TMP/etc" "$TMP/root" "$TMP/log"
cp "$TMP/runcmd.sh.env" "$TMP/etc/install.env"
sed -e "s|/etc/synap/install.env|$TMP/etc/install.env|g" -e "s|/root/|$TMP/root/|g" -e "s|/var/log/|$TMP/log/|g" "$TMP/runcmd.sh" > "$TMP/run.sh"
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --retry) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
echo "$url" > "$FAKE_DIR/url"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/args"\n' "$FAKE_DIR" > "$out"
C
chmod +x "$TMP/bin/curl"
FAKE_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$TMP/run.sh"; rc=$?
[ "$rc" = 0 ] && ok "rendered runcmd ran (rc 0)" || bad "rendered runcmd rc=$rc"
[ "$(cat "$TMP/url" 2>/dev/null)" = "https://github.com/synap-core/backend/releases/download/$RELEASE/install.sh" ] \
  && ok "downloads the bootstrapper of release $RELEASE" || bad "bootstrapper URL: $(cat "$TMP/url" 2>/dev/null)"
expected="$(printf '%s\n' --release "$RELEASE" --name "$NAME" --edge "$EDGE" --control-plane "$CP" --register-token "$TOKEN")"
[ "$(cat "$TMP/args" 2>/dev/null)" = "$expected" ] && ok "bootstrapper called with exactly the contract's flags" \
  || { bad "bootstrapper args differ"; diff <(echo "$expected") "$TMP/args"; }
[ ! -e "$TMP/etc/install.env" ] && ok "the code file is deleted after the run" || bad "install.env still on disk"

exit $fail
