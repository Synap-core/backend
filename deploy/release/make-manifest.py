#!/usr/bin/env python3
"""Build a pod release manifest (release.json) — update-door plan P1.

The manifest is THE input of `synap update --release <id>`: an immutable
description of one release. It is published as a GitHub Release asset
(.github/workflows/docker-publish.yml, job publish-release):

  releases/download/<id>/release.json            the release itself
  releases/download/<id>/synap-deploy-<id>.tar.gz  its deploy bundle
  releases/download/channel-<fast|stable>/release.json   the channel pointer

Format (schema 1) — validated by the ENGINE's own rules
(`synap` _ue_manifest_errors, run in CI via deploy/release/validate-manifest.sh):

  {
    "schema": 1,
    "id": "main-<sha7>" | "vX.Y.Z",          # = the GitHub release tag = what CP sends
    "channel": "fast" | "stable",
    "gitSha": "<40 hex>",                     # images report it as /status/release buildStamp
    "createdAt": "<iso8601>",
    "images": { "SYNAP_IMAGE_<X>": "<repo>[:tag]@sha256:<64 hex>", ... },
                                              # one entry per SYNAP_IMAGE_* the compose file
                                              # consumes — DERIVED from deploy/docker-compose.yml
    "migrations": { "last": "<file>.sql", "count": <n> },
    "composeSha": "sha256:<64 hex>",          # deploy/docker-compose.yml of this release
    "envSchemaVersion": "sha256:<64 hex>",    # sorted keys of deploy/.env.example
    "minFrom": null | "<migration file>",     # a pod below this level must step through
    "bundle": { "asset": "synap-deploy-<id>.tar.gz", "sha256": "<64 hex>" } | null
  }

First-party digests come from the build jobs (--image KEY=ref@sha256:...).
Third-party images are resolved from the compose default tag to a digest at
release time (`docker buildx imagetools inspect`) unless given with --image.

Usage:
  make-manifest.py --id main-abc1234 --channel fast --git-sha <sha> \
      --image SYNAP_IMAGE_BACKEND=ghcr.io/synap-core/backend@sha256:... \
      [--image KEY=REF ...] [--bundle path/to/synap-deploy-<id>.tar.gz] [--min-from <file>.sql] \
      [--repo-root .] > release.json
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

DIGEST = re.compile(r"^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$")
IMAGE_VAR = re.compile(r"\$\{(SYNAP_IMAGE_[A-Z0-9_]+):-([^}$]*)(\$\{)?")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def compose_image_defaults(compose_text):
    """{SYNAP_IMAGE_X: default-tag or None when the default is first-party (nested ${...})}."""
    out = {}
    for key, default, nested in IMAGE_VAR.findall(compose_text):
        out[key] = None if nested else default
    return out


def resolve_digest(ref):
    out = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"],
        check=True, capture_output=True, text=True,
    ).stdout
    digest = json.loads(out)["digest"]
    return f"{ref}@{digest}"


def env_schema_version(example_path):
    keys = set()
    with open(example_path) as f:
        for line in f:
            m = re.match(r"^\s*#?\s*([A-Z][A-Z0-9_]*)=", line)
            if m:
                keys.add(m.group(1))
    return "sha256:" + hashlib.sha256("\n".join(sorted(keys)).encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", required=True)
    ap.add_argument("--channel", required=True, choices=["fast", "stable"])
    ap.add_argument("--git-sha", required=True)
    ap.add_argument("--image", action="append", default=[], help="KEY=REF@sha256:...")
    ap.add_argument("--bundle")
    ap.add_argument("--min-from")
    ap.add_argument("--repo-root", default=".")
    a = ap.parse_args()

    root = a.repo_root
    compose_path = os.path.join(root, "deploy", "docker-compose.yml")
    with open(compose_path) as f:
        defaults = compose_image_defaults(f.read())
    if not defaults:
        sys.exit("no SYNAP_IMAGE_* variables found in deploy/docker-compose.yml — refusing an empty contract")

    given = {}
    for item in a.image:
        key, _, ref = item.partition("=")
        if not ref:
            sys.exit(f"--image {item!r}: expected KEY=REF")
        given[key] = ref

    images = {}
    for key, default in sorted(defaults.items()):
        if key in given:
            images[key] = given.pop(key)
        elif default is None:
            sys.exit(f"{key} is a first-party image — pass --image {key}=<repo>@sha256:<digest>")
        else:
            images[key] = resolve_digest(default)
    if given:
        sys.exit(f"--image for keys the compose file does not use: {sorted(given)}")
    for key, ref in images.items():
        if not DIGEST.match(ref):
            sys.exit(f"{key}={ref} is not pinned by digest")

    mig_dir = os.path.join(root, "packages", "database", "migrations")
    migrations = sorted(f for f in os.listdir(mig_dir) if f.endswith(".sql"))
    if not migrations:
        sys.exit(f"no migrations in {mig_dir}")

    bundle = None
    if a.bundle:
        bundle = {"asset": os.path.basename(a.bundle), "sha256": sha256_file(a.bundle)}

    manifest = {
        "schema": 1,
        "id": a.id,
        "channel": a.channel,
        "gitSha": a.git_sha,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "images": images,
        "migrations": {"last": migrations[-1], "count": len(migrations)},
        "composeSha": "sha256:" + sha256_file(compose_path),
        "envSchemaVersion": env_schema_version(os.path.join(root, "deploy", ".env.example")),
        "minFrom": a.min_from or None,
        "bundle": bundle,
    }
    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
