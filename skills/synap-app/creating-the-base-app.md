# Creating the base app

The base app is an opinionated, batteries-included starter: **Next.js 16 (App
Router) + React 19 + HeroUI + Tailwind**, with auth (incl. TOTP), an app shell
(tabs + slide-in right panel), a Cmd+K command palette, a realtime bridge, and a
mock mode — all pre-wired. You add your screens; the plumbing is done.

## Scaffold it

```bash
npx create-synap-app my-app
cd my-app
cp .env.example .env.local   # fill in your pod / control-plane URLs
pnpm dev                     # http://localhost:3010
```

Develop with **no pod** by setting `NEXT_PUBLIC_BASE_MOCK_MODE=true`.

## What's where

```
app/
  layout.tsx        Root layout → ClientProviders (client-only, see below)
  ClientProviders   Loads the provider tree with { ssr: false } (REQUIRED — see rule 1)
  providers.tsx     The real provider stack (auth, tRPC, realtime, palette)
  (app)/home        Your home screen — replace this
  login/ onboarding First-run + auth screens
lib/
  registerAll.ts    Boot hook — registers cells/views (override in your app)
  auth.ts mockMode  Session + mock helpers
components/layout/
  AppShell          Root layout primitive — pass your sidebar as `leftNav`
```

## Four rules that keep the build green (all Next 16 / Turbopack specifics)

1. **The provider tree must load client-only.** `app/ClientProviders.tsx` does
   `dynamic(() => import("./providers"), { ssr: false })`. base's provider tree
   pulls a dep that touches `window` at module scope, which crashes a server
   render. base is a client app shell — there is nothing to server-render — so
   this is correct, not a hack. Keep it.
2. **`config.matcher` in `middleware.ts` must be an inline literal**, not a value
   read from a helper — Next's static analyzer can't parse an expression there.
3. **In `globals.css`, `@import` must come before the `@tailwind` directives.**
   Turbopack enforces the CSS spec strictly.
4. **Build with Turbopack (the default) — do NOT pass `--webpack`.** In Next 16
   the legacy `--webpack` flag silently produces nothing (exit 0, no output). If
   you add a webpack alias, port it to `turbopack.resolveAlias` in `next.config.ts`.

## Deriving your own app

1. Rename the namespaced storage keys (`base:session`, `base-workspace`, …) so
   two Synap apps don't share state in one browser. The README lists every key.
2. Replace `app/(app)/home/page.tsx` with your dashboard.
3. Pass your sidebar: `<AppShell leftNav={<MySidebar />}>`.
4. Register app-specific Cmd+K commands with `useRegisterCommand([...])`.
5. Register only the cells you need in `lib/registerAll.ts` (a lean template
   registers fewer than the full set).

## Auth flow (already wired)

`/login` → Synap Cloud sign-in (email + password or magic link) → optional TOTP →
pod picker → handshake → session stored → `/home`. Self-hosted pods fall back to
the pod's own Kratos at `/login?mode=kratos`. You don't build this; you theme it.
