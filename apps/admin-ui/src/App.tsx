import { Routes, Route } from 'react-router-dom';
import MainLayout from './components/layout/MainLayout';

// V2 Pages (New workflow-oriented design)
import DashboardPage from './pages/(v2)/DashboardPage';
import InvestigatePage from './pages/(v2)/InvestigatePage';
import TestingPage from './pages/(v2)/TestingPage';
import ExplorePage from './pages/(v2)/ExplorePage';

// V1 Pages (Legacy - still accessible)
import CapabilitiesPage from './pages/CapabilitiesPage';
import EventPublisherPage from './pages/EventPublisherPage';

import './App.css';

function App() {
  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
        {/* V2 Routes - New workflow-oriented pages */}
        <Route index element={<DashboardPage />} />
        <Route path="investigate" element={<InvestigatePage />} />
        <Route path="testing" element={<TestingPage />} />
        <Route path="explore" element={<ExplorePage />} />

        {/* Legacy Routes - V1 pages still accessible */}
        <Route path="capabilities" element={<CapabilitiesPage />} />
        <Route path="publish" element={<EventPublisherPage />} />
      </Route>
    </Routes>
  );
}

export default App;
