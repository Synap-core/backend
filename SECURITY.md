# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, pull
request or discussion for them.

- **Preferred:** GitHub private vulnerability reporting. Open the repository's
  **Security** tab and choose **Report a vulnerability**. The report is visible
  only to you and the maintainers.
- **Or by email:** security@synap.live.

Include what you can of:

- the affected component (API route, MCP tool, operator CLI, Compose stack,
  installer) and the release or commit,
- the steps to reproduce, or a proof of concept,
- the impact you expect (data read or written across a workspace or pod
  boundary, authentication bypass, remote code execution, and so on).

We will acknowledge the report, keep you informed while we work on it, and
credit you in the fix unless you ask us not to. Please give us a reasonable
time to release a fix before you disclose the problem publicly.

## Supported versions

Fixes are made on `main` and shipped in the next release. A self-hosted pod
receives them through `synap update` (see [deploy/README.md](deploy/README.md)).
Older releases are not patched separately.

## Scope

This policy covers the code in this repository: the pod's API and workers, the
realtime server, the operator console, the operator CLI (`synap`), `install.sh`
and the deployment files under `deploy/`. Issues in a third-party image the
stack runs (PostgreSQL, Ory Kratos, Typesense, MinIO, Caddy) should go to that
project, though we would like to hear about them if a pod's configuration makes
them exploitable.
