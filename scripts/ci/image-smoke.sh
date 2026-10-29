#!/usr/bin/env bash
# image-smoke.sh <image> — what must hold INSIDE a built backend image, one
# door for every job that builds one: ci.yml "Release gate: Docker image"
# (every push to main, and a PR or queue entry touching
# scripts/ci-changes.mjs IMAGE_INPUTS) and docker-publish.yml
# build-and-push-backend-api (every release, after its local build and
# before its push).
#
# In the BUILT image the code-skill sandbox's native addon loads and runs an
# isolate. isolated-vm is resolved from @synap/api (the package that imports
# it), with the flag its README requires on Node >= 20, and the image's CMD
# must carry that flag too. The runner the API's pool starts carries the Node
# permission model, runs a skill under it, and is refused a file write, a
# process and the API's environ (review F12; no suite runs the BUILT runner).
# Run from the repo root: the sandbox smoke script is mounted from it.
set -euo pipefail

image="${1:?usage: image-smoke.sh <image>}"
docker run --rm "$image" node --version
docker run --rm "$image" node --no-node-snapshot -e '
  const { realpathSync } = require("node:fs");
  const { createRequire } = require("node:module");
  const req = createRequire(realpathSync("node_modules/@synap/api/package.json"));
  const ivm = req("isolated-vm");
  const isolate = new ivm.Isolate({ memoryLimit: 16 });
  const out = isolate.compileScriptSync("6 * 7").runSync(isolate.createContextSync());
  if (out !== 42) throw new Error("isolate returned " + out);
  console.log("isolated-vm " + req("isolated-vm/package.json").version + " ran an isolate on node " + process.version);
'
cmd=$(docker inspect --format '{{json .Config.Cmd}}' "$image")
echo "CMD: $cmd"
echo "$cmd" | grep -q -- '--no-node-snapshot' || {
  echo "::error::deploy/Dockerfile CMD lacks --no-node-snapshot (isolated-vm requires it on Node >= 20)"
  exit 1
}
docker run --rm -v "$PWD/scripts/skill-runner-sandbox-smoke.mjs:/smoke/skill-runner-sandbox-smoke.mjs:ro" \
  "$image" node --no-node-snapshot /smoke/skill-runner-sandbox-smoke.mjs
echo "image smoke: $image passed"
