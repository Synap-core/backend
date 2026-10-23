# Install & scaffold commands

## Scaffold a full app (recommended for a fresh start)

> **Not published yet.** The scaffolder (`@synap-core/create-synap-app`) is not
> on npm and the base template is not public, so `npx` returns 404 today. Use the
> SDK path below until a release exists.

Once published:

```bash
npx @synap-core/create-synap-app my-app
```

It creates a Next.js + HeroUI project from the base template, with the SDK, auth,
app shell, command palette, realtime, and mock mode pre-wired. It also drops an
`AGENTS.md` into the project so your AI coding tool knows how to work with it.

## Add the SDK to an existing app

```bash
# npm
npm install @synap-core/sdk@^1.0.0

# with React bindings
npm install @synap-core/sdk@^1.0.0 @synap-core/react@^1.0.0

# realtime
npm install @synap-core/sdk-realtime

# REST client for API-key holders (agents, scripts); also has setupAgent()
npm install @synap-core/hub-rest-client
```

Do not install `@synap-core/auth` (retired; its last release calls a removed pod
route) or `@synap-core/auth-bootstrap` (not published).

Pin `@^1.0.0` on `sdk`/`react`. **Do not** install unpinned `@synap-core/sdk` —
older `0.x` versions on the registry are a different, abandoned package.

## Get this knowledge into your AI coding tool

```bash
# print this skill from your pod's skill knowledge base
synap skill get synap-app

# or wire a tool end-to-end (skills + MCP)
synap connect --target=cursor        # or claude-code, claude-desktop, codex, …
```

Once the scaffolder is published, the scaffolded project ships an `AGENTS.md` at its root — most AI
coding tools read it automatically, so a freshly-scaffolded app teaches the AI
how to build on it with zero extra setup.

## Verify an install actually works

Publishing bugs have shipped uninstallable Synap packages before. After adding a
package, confirm it resolves in a clean directory:

```bash
mkdir /tmp/synap-check && cd /tmp/synap-check && npm init -y
npm install @synap-core/sdk@^1.0.0
node -e "console.log(typeof require('@synap-core/sdk').createSynapClient)"  # → function
```
