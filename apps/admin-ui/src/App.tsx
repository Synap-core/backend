import { Routes, Route } from "react-router-dom";
import MainLayout from "./components/layout/MainLayout";

// Core Module Pages (System section)
import DashboardPage from "./pages/(v2)/DashboardPage";
import InvestigatePage from "./pages/(v2)/InvestigatePage";
import TestingPage from "./pages/(v2)/TestingPage";
import DatabasePage from "./pages/(v2)/DatabasePage";
import SubscribersPage from "./pages/(v2)/SubscribersPage";
import FilesPage from "./pages/(v2)/FilesPage";

// Management Pages
import ApiKeysPage from "./pages/(v2)/ApiKeysPage";
import WorkspacesPage from "./pages/(v2)/WorkspacesPage";
import WorkspaceDetailPage from "./pages/(v2)/WorkspaceDetailPage";

// Intelligence Pages
import IntelligencePage from "./pages/(v2)/IntelligencePage";
import MemoryPage from "./pages/(v2)/MemoryPage";
import ProposalsPage from "./pages/(v2)/ProposalsPage";

import "./App.css";

function App() {
  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
        {/* System Routes */}
        <Route index element={<DashboardPage />} />
        <Route path="health" element={<DashboardPage />} />
        <Route path="events" element={<InvestigatePage />} />
        <Route path="testing" element={<TestingPage />} />
        <Route path="data" element={<DatabasePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="automation" element={<SubscribersPage />} />

        {/* Management Routes */}
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />

        {/* Intelligence Routes */}
        <Route path="commands" element={<IntelligencePage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="proposals" element={<ProposalsPage />} />

        {/* Legacy route redirects */}
        <Route path="investigate" element={<InvestigatePage />} />
        <Route path="database" element={<DatabasePage />} />
        <Route path="subscribers" element={<SubscribersPage />} />
      </Route>
    </Routes>
  );
}

export default App;
