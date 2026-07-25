# Install & scaffold commands

## Scaffold a full app (recommended for a fresh start)

```bash
npx create-synap-app my-app
```

Creates a Next.js + HeroUI project from the base template, with the SDK, auth,
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

# auth (browser sign-in) or auth-bootstrap (server credential bootstrap)
npm install @synap-core/auth        # or @synap-core/auth-bootstrap
```

Pin `@^1.0.0` on `sdk`/`react`. **Do not** install unpinned `@synap-core/sdk` —
older `0.x` versions on the registry are a different, abandoned package.

## Get this knowledge into your AI coding tool

```bash
# add the app-creation skill (this skill) to a connected AI tool
synap skills get synap-app

# or wire a tool end-to-end (skills + MCP), any target
synap connect --target=cursor        # or claude, openclaw, …
```

Alternatively, the scaffolded project ships an `AGENTS.md` at its root — most AI
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
