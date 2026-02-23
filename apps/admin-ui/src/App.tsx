import { Routes, Route } from "react-router-dom";
import MainLayout from "./components/layout/MainLayout";

// Data Pod Pages
import DashboardPage from "./pages/(v2)/DashboardPage";
import UsersPage from "./pages/(v2)/UsersPage";
import DatabasePage from "./pages/(v2)/DatabasePage";
import FilesPage from "./pages/(v2)/FilesPage";
import InvestigatePage from "./pages/(v2)/InvestigatePage";
import ApiKeysPage from "./pages/(v2)/ApiKeysPage";

// Workspace Pages
import WorkspacesPage from "./pages/(v2)/WorkspacesPage";
import WorkspaceDetailPage from "./pages/(v2)/WorkspaceDetailPage";
import ProposalsPage from "./pages/(v2)/ProposalsPage";
import IntelligencePage from "./pages/(v2)/IntelligencePage";

// Developer Pages
import TestingPage from "./pages/(v2)/TestingPage";
import SubscribersPage from "./pages/(v2)/SubscribersPage";

// Other Pages
import MemoryPage from "./pages/(v2)/MemoryPage";
import FlowPageV3 from "./pages/(v2)/FlowPageV3";

import "./App.css";

function App() {
  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
        {/* Data Pod Routes */}
        <Route index element={<DashboardPage />} />
        <Route path="health" element={<DashboardPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="data" element={<DatabasePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="events" element={<InvestigatePage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />

        {/* Workspace Routes */}
        <Route path="workspace" element={<WorkspaceDetailPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />
        <Route path="proposals" element={<ProposalsPage />} />
        <Route path="commands" element={<IntelligencePage />} />
        <Route path="memory" element={<MemoryPage />} />

        {/* Developer Routes */}
        <Route path="testing" element={<TestingPage />} />
        <Route path="automation" element={<SubscribersPage />} />
        <Route path="flow" element={<FlowPageV3 />} />

        {/* Legacy route redirects */}
        <Route path="investigate" element={<InvestigatePage />} />
        <Route path="database" element={<DatabasePage />} />
        <Route path="subscribers" element={<SubscribersPage />} />
      </Route>
    </Routes>
  );
}

export default App;
