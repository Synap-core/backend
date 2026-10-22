#!/usr/bin/env bash
# ============================================================================
# Tripwire: every compose image is pinned — no `:latest`, no bare tag.
# ============================================================================
# A floating tag means two pods installed a week apart run different code
# under the same release, and nothing in the release names what they run.
#
# Asserts, on the PARSED compose YAML (service set derived, never hand-listed),
# that every service's `image` has exactly one of two shapes:
#   1. `${SYNAP_IMAGE_<X>:-<default>}` — the update engine pins it: the release
#      manifest carries its digest and `synap update` writes it into .env. The
#      default (used only before a pod has a release) must itself name a tag
#      that is not `latest`, or be first-party (a nested `${...}`).
#   2. a literal pinned by digest: `repo[:tag]@sha256:<64 hex>`, the tag (when
#      present) not `latest`. An optional add-on stays out of the manifest (a
#      manifest image is pulled on EVERY pod at every update), so the signed
#      compose file is what pins it.
# Positive control: the same classifier is run on literal samples of each
# accepted and each refused shape before the compose file is judged.
# Non-vacuity: >= 15 services with an image, >= 1 of each shape.
#
# NOT covered: docker-compose.override.yml files on a pod; images a script
# runs with `docker run` (cosign, mc, the archive helpers); whether a digest
# still resolves in its registry (the release workflow checks the manifest's).
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${IMAGE_PINS_COMPOSE_FILE:-$SCRIPT_DIR/../docker-compose.yml}"

python3 - "$COMPOSE_FILE" <<'PY'
import re, sys, yaml

DIGEST = re.compile(r"^(?P<repo>[a-z0-9][a-z0-9._/-]*)(?::(?P<tag>[A-Za-z0-9._-]+))?@sha256:[0-9a-f]{64}$")
VAR = re.compile(r"^\$\{SYNAP_IMAGE_[A-Z0-9_]+:-(?P<default>.*)\}$")
TAGGED = re.compile(r"^[a-z0-9][a-z0-9._/-]*:(?P<tag>[A-Za-z0-9._-]+)$")

def classify(image):
    """('var' | 'digest', None) when accepted, (None, reason) when refused."""
    m = VAR.match(image)
    if m:
        default = m.group("default")
        if default.startswith("ghcr.io/") and "${" in default:
            return "var", None                      # first-party: the release names its digest
        t = TAGGED.match(default)
        if not t:
            return None, f"SYNAP_IMAGE_* default {default!r} names no tag"
        if t.group("tag") == "latest":
            return None, f"SYNAP_IMAGE_* default {default!r} is :latest"
        return "var", None
    m = DIGEST.match(image)
    if m:
        if m.group("tag") == "latest":
            return None, "a digest pin must not be labelled :latest"
        return "digest", None
    t = TAGGED.match(image)
    if t and t.group("tag") == "latest":
        return None, ":latest (pin repo:<version>@sha256:<digest>)"
    if image.startswith("${"):
        return None, "only a SYNAP_IMAGE_* variable pins an image through the release"
    return None, "not pinned by digest (literal images need repo[:tag]@sha256:<digest>)"

D = "@sha256:" + "a" * 64
SAMPLES = {
    "${SYNAP_IMAGE_REDIS:-redis:7-alpine}": "var",
    "${SYNAP_IMAGE_BACKEND:-ghcr.io/${GITHUB_REPOSITORY:-x/backend}:${BACKEND_VERSION:?set}}": "var",
    "cloudflare/cloudflared:2026.10.3" + D: "digest",
    "browserless/chrome" + D: "digest",
    "cloudflare/cloudflared:latest": None,
    "cloudflare/cloudflared": None,
    "prom/prometheus:v2.51.0": None,
    "cloudflare/cloudflared:latest" + D: None,
    "${SYNAP_IMAGE_REDIS:-redis:latest}": None,
    "${SYNAP_IMAGE_REDIS:-redis}": None,
    "${OTHER_IMAGE:-redis:7-alpine}": None,
}
bad = [f"{s!r}: got {classify(s)[0]}, want {want}" for s, want in SAMPLES.items() if classify(s)[0] != want]
for b in bad: print("  ✗ positive control: " + b)
if not bad: print(f"  ✓ positive control: the classifier sorts {len(SAMPLES)} samples of each shape")

svcs = (yaml.safe_load(open(sys.argv[1])) or {}).get("services") or {}
fails, shapes = [], {"var": 0, "digest": 0}
for name, s in svcs.items():
    image = (s or {}).get("image")
    if image is None:
        fails.append(f"{name}: no image (a build-only service would run whatever the host built)")
        continue
    shape, why = classify(str(image))
    if shape:
        shapes[shape] += 1
    else:
        fails.append(f"{name}: {image!r} — {why}")
for f in fails: print("  ✗ " + f)
if not fails: print(f"  ✓ every image is pinned ({shapes['var']} through SYNAP_IMAGE_*, {shapes['digest']} by digest)")
n = shapes["var"] + shapes["digest"]
nv = n >= 15 and shapes["var"] >= 1 and shapes["digest"] >= 1
print(("  ✓ " if nv else "  ✗ ") + f"non-vacuity: {len(svcs)} services, {n} pinned images")
sys.exit(1 if bad or fails or not nv else 0)
PY
