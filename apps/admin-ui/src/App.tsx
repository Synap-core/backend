/**
 * DEPRECATED — see `synap-backend/apps/pod-admin`.
 *
 * The legacy admin-ui is now a redirect shell. Three routes are preserved
 * because external systems still link into them:
 *
 *   • `/connect`   — deeplink callback for external-connect-client
 *   • `/kratos`    — Ory Kratos self-service browser flows
 *                    (Kratos config: SELFSERVICE_DEFAULT_BROWSER_RETURN_URL
 *                    → /admin/, and the inline UI lives here)
 *   • `/bootstrap` — first-admin claim screen on fresh installs
 *
 * Every other path below `/admin/*` renders <DeprecationRedirect /> which
 * `window.location.replace`s to Pod Admin (port 4040 in dev,
 * `VITE_POD_ADMIN_URL` in prod).
 *
 * Once Pod Admin owns Kratos rendering + bootstrap + connect, this app
 * can be deleted entirely.
 */

import { Routes, Route } from "react-router-dom";

import ConnectPage from "./pages/ConnectPage";
import KratosSelfServicePage from "./pages/KratosSelfServicePage";
import BootstrapAdminPage from "./pages/BootstrapAdminPage";
import DeprecationRedirect from "./pages/DeprecationRedirect";

import "./App.css";

function App() {
  return (
    <Routes>
      {/* ── Preserved (still served from admin-ui) ─────────────────────── */}
      <Route path="connect" element={<ConnectPage />} />
      <Route path="kratos" element={<KratosSelfServicePage />} />
      <Route path="bootstrap" element={<BootstrapAdminPage />} />

      {/* ── Everything else: redirect to Pod Admin ─────────────────────── */}
      <Route path="*" element={<DeprecationRedirect />} />
    </Routes>
  );
}

export default App;
