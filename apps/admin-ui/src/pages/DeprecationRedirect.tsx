/**
 * DEPRECATED — this app is being replaced by `synap-backend/apps/pod-admin`.
 *
 * The Vite SPA mounted at `/admin/*` is kept alive for ONE release so that
 * three legacy entry points keep working:
 *
 *   • `/admin/kratos`    — Ory Kratos self-service browser flows (login,
 *                          recovery, settings). Kratos's
 *                          SELFSERVICE_DEFAULT_BROWSER_RETURN_URL points at
 *                          `/admin/`, and the inline UI is rendered here.
 *   • `/admin/bootstrap` — first-admin claim screen for fresh self-hosted
 *                          installs (one-time token bootstrap).
 *   • `/admin/connect`   — OAuth-style deeplink callback used by
 *                          `@synap-core/external-connect-client`.
 *
 * Every other route below `/admin/*` (the dashboard root, /workspaces,
 * /users, /audit, etc.) renders this component, which immediately
 * window-replaces to the new Pod Admin app. We use `window.location.replace`
 * so the deprecated URL doesn't pollute browser history.
 *
 * The redirect target is `VITE_POD_ADMIN_URL` if set, otherwise
 * `http://localhost:4040` (Pod Admin's default dev port).
 *
 * Once Pod Admin owns the auth/bootstrap/connect surfaces too, this whole
 * app can be deleted.
 */

import { useEffect } from "react";

const TARGET =
  (import.meta.env.VITE_POD_ADMIN_URL as string | undefined) ||
  "http://localhost:4040";

export default function DeprecationRedirect() {
  useEffect(() => {
    // Carry pathname + search through so e.g. `/admin/workspaces/:id` ends
    // up at `<pod-admin>/workspaces/:id` if Pod Admin happens to have a
    // matching route. Routes that don't match cleanly land on the root,
    // which is fine — operator continues from there.
    const path = window.location.pathname.replace(/^\/admin/, "") || "/";
    const search = window.location.search;
    const target = TARGET.replace(/\/$/, "") + path + search;
    window.location.replace(target);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        background: "var(--color-background, #f4f4f5)",
        color: "var(--color-foreground, #18181b)",
      }}
    >
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            margin: "0 0 8px",
          }}
        >
          The legacy admin console moved.
        </h1>
        <p style={{ fontSize: 14, opacity: 0.7, margin: "0 0 16px" }}>
          Redirecting you to <code>Pod Admin</code>…
        </p>
        <p style={{ fontSize: 13, opacity: 0.5 }}>
          If you aren't redirected,{" "}
          <a href={TARGET} style={{ color: "currentColor" }}>
            click here
          </a>
          .
        </p>
      </div>
    </div>
  );
}
