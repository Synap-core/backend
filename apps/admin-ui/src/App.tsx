import { Routes, Route, Navigate } from "react-router-dom";
import MainLayout from "./components/layout/MainLayout";

import DashboardPage from "./pages/(v2)/DashboardPage";
import UsersPage from "./pages/(v2)/UsersPage";
import InvestigatePage from "./pages/(v2)/InvestigatePage";
import ApiKeysPage from "./pages/(v2)/ApiKeysPage";

import WorkspaceDashboardPage from "./pages/(v2)/WorkspaceDashboardPage";
import WorkspacesPage from "./pages/(v2)/WorkspacesPage";
import WorkspaceDetailPage from "./pages/(v2)/WorkspaceDetailPage";
import ProposalsPage from "./pages/(v2)/ProposalsPage";
import IntelligencePage from "./pages/(v2)/IntelligencePage";
import SecretsPage from "./pages/(v2)/SecretsPage";
import DocumentsPage from "./pages/(v2)/DocumentsPage";
import PodServicesPage from "./pages/(v2)/PodServicesPage";
import ConnectionsPage from "./pages/(v2)/ConnectionsPage";
import ExternalSourcesPage from "./pages/(v2)/ExternalSourcesPage";
import ConnectionDetailPage from "./pages/(v2)/ConnectionDetailPage";

import TrustedIssuersPage from "./pages/(v2)/TrustedIssuersPage";
import ConnectPage from "./pages/ConnectPage";
import KratosSelfServicePage from "./pages/KratosSelfServicePage";
import BootstrapAdminPage from "./pages/BootstrapAdminPage";

import "./App.css";

function App() {
  return (
    <Routes>
      {/* Standalone — no nav/sidebar, used for OAuth-style deeplink callbacks */}
      <Route path="connect" element={<ConnectPage />} />
      {/* Ory Kratos browser flows land here (see deploy kratos.yml ui_url) */}
      <Route path="kratos" element={<KratosSelfServicePage />} />
      {/* One-time token bootstrap for first self-hosted admin */}
      <Route path="bootstrap" element={<BootstrapAdminPage />} />

      <Route path="/" element={<MainLayout />}>
        {/* Data Pod Routes */}
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="events" element={<InvestigatePage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="pod-services" element={<PodServicesPage />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route
          path="connections/:integrationId"
          element={<ConnectionDetailPage />}
        />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="documents/:documentId?" element={<DocumentsPage />} />

        <Route path="workspace" element={<WorkspaceDashboardPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />
        <Route path="proposals" element={<ProposalsPage />} />
        <Route path="intelligence" element={<IntelligencePage />} />
        <Route
          path="external-sources"
          element={<Navigate to="/connections?tab=advanced-sources" replace />}
        />
        <Route path="services" element={<ExternalSourcesPage />} />
        <Route path="trusted-issuers" element={<TrustedIssuersPage />} />
      </Route>
    </Routes>
  );
}

export default App;
