# Install & scaffold commands

## Start a fresh app

> **No public starter yet.** A public starter is decided but not published. The
> older scaffolder (`@synap-core/create-synap-app`, a Next.js + HeroUI base
> template) was never published and is retired, so `npx` returns 404. Start a
> Next.js app on shadcn + Tailwind v4 and add the SDK (below).

## Register an app on your pod

```bash
synap app init      # writes synap.app.json (name, pod, what the app asks for) and registers the app on your pod
synap app connect   # files ONE proposal for the app's access; once you approve it, writes the app's key into the deploy target (Vercel, or .env.local)
```

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

The SDK ships its own `AGENTS.md` (`node_modules/@synap-core/sdk/AGENTS.md`):
point your AI coding tool at it, or link it from your project's own `AGENTS.md`.

## Verify an install actually works

Publishing bugs have shipped uninstallable Synap packages before. After adding a
package, confirm it resolves in a clean directory:

```bash
mkdir /tmp/synap-check && cd /tmp/synap-check && npm init -y
npm install @synap-core/sdk@^1.0.0
node -e "console.log(typeof require('@synap-core/sdk').createSynapClient)"  # → function
```
