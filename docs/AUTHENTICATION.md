# Synap Authentication Architecture

This document outlines the authentication flow, architecture, and security design for Synap.

## 🏗️ Architecture: The "Two-Layer" Design

Synap uses a robust "Two-Layer" authentication strategy to ensure security and performance.

### Layer 1: The Gatekeeper (Hono Middleware)
*   **Component**: `orySessionMiddleware` in `@synap/auth` (Used in `apps/api`).
*   **Role**: Global validation. "Is this request allowed to enter?"
*   **Action**: validates the request *before* it reaches any business logic.
    *   Checks for the **Kratos Session Cookie** (`ory_kratos_session`).
    *   Validates the session against the Ory Kratos Public API (`/sessions/whoami`).
    *   If valid: Attaches the **User Identity** to the request context (`c.set('user', ...)`).
    *   If invalid: Rejects immediately with `401 Unauthorized`.

### Layer 2: The Consumer (tRPC Context)
*   **Component**: `createContext` in `apps/api`.
*   **Role**: Context population. "Who is making this request?"
*   **Action**: Extracts the pre-validated identity from Layer 1.
    *   **Does NOT** re-validate the session (efficiency).
    *   Passes the `userId` and `user` object to tRPC procedures.
*   **Usage**: tRPC procedures (e.g. `workspaces.list`) use `ctx.userId` to filter data securely.

## 🔄 The Authentication Flow

### 1. Login (Frontend)
1.  User enters credentials on Next.js frontend (`/login`).
2.  Frontend calls Ory Kratos (`/self-service/login/browser`).
3.  **Success**: Kratos sets a `ory_kratos_session` cookie.
    *   **Domain**: `localhost` (Development) or `.synap.io` (Production).
    *   **SameSite**: `Lax` (typically).

### 2. API Request (Browser -> API)
1.  Browser sends request to `http://localhost:3000/trpc/workspaces.list`.
2.  **Next.js Proxy** intercept the request (defined in `next.config.ts`).
    *   Relays request to `http://localhost:4000/trpc/workspaces.list`.
    *   **Crucial**: Because the browser talks to Port 3000, it treats this as a **Same-Origin** request. Cookies are ALWAY sent.
3.  **Hono Server (API)** receives request on Port 4000.
4.  **Hono Middleware** validates cookie with Kratos.
5.  **tRPC Context** receives validated User ID.
6.  **Procedure** executes SQL query: `SELECT * FROM workspaces WHERE owner_id = :userId`.

## 🛡️ Security Decisions

### Why Next.js Rewrites?
We use Next.js Rewrites (`/trpc` -> API) instead of CORS for three reasons:
1.  **Cookie Reliability**: Eliminates "Third-Party Cookie" issues. Browsers treat Frontend and API as the same site.
2.  **Security**: Hides the internal API URL (`http://localhost:4000`) from the public internet. The browser only knows about the Frontend URL.
3.  **Simplicity**: No complex CORS preflight (`OPTIONS`) requests or wildcard configurations.

### Why Kratos?
*   **Security**: Proven, audited identity provider.
*   **Features**: Handles Login, Registration, Recovery, Verification, and 2FA out of the box.
*   **Decoupling**: Auth logic is separate from business logic.

## 🐛 Debugging Tips

If you encounter `401 Unauthorized`:

1.  **Check Cookies**: Open DevTools -> Application -> Cookies. Is `ory_kratos_session` present for `localhost`?
2.  **Check Network**: Look at the request to `/trpc/...`.
    *   Is it going to `localhost:3000` (Correct) or `4000` (Incorrect)?
    *   Is the Status `401`?
3.  **Check API Logs**:
    *   `[orySessionMiddleware] No cookie found`: Browser didn't send it (Use Rewrites/Same-Origin).
    *   `[orySessionMiddleware] Invalid session`: Cookie exists but expired or revoked.
    *   `[createContext]`: If Middleware says "Success" but tRPC says "Unauthorized", check Context Propagation in `index.ts`.
