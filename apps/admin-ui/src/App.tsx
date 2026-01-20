import { Routes, Route } from "react-router-dom";
import MainLayout from "./components/layout/MainLayout";

// Core Module Pages
import DashboardPage from "./pages/(v2)/DashboardPage";
import InvestigatePage from "./pages/(v2)/InvestigatePage";
import TestingPage from "./pages/(v2)/TestingPage";
import DatabasePage from "./pages/(v2)/DatabasePage";
import SubscribersPage from "./pages/(v2)/SubscribersPage";
import FlowPageV3 from "./pages/(v2)/FlowPageV3";
import FilesPage from "./pages/(v2)/FilesPage";

import "./App.css";

function App() {
  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
        {/* Core Module Routes */}
        <Route index element={<DashboardPage />} />
        <Route path="health" element={<DashboardPage />} />
        <Route path="events" element={<InvestigatePage />} />
        <Route path="testing" element={<TestingPage />} />
        <Route path="data" element={<DatabasePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="automation" element={<SubscribersPage />} />
        <Route path="flow" element={<FlowPageV3 />} />

        {/* Legacy route redirects for backwards compatibility */}
        <Route path="investigate" element={<InvestigatePage />} />
        <Route path="database" element={<DatabasePage />} />
        <Route path="subscribers" element={<SubscribersPage />} />
      </Route>
    </Routes>
  );
}

export default App;
