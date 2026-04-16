import { Navigate } from "react-router-dom";

export default function ExternalSourcesPage() {
  return <Navigate to="/connections?tab=advanced-sources" replace />;
}
