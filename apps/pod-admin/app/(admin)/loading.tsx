import { PageFallback } from "./components/page-header";

/**
 * What a console page shows the instant it is clicked, while the server
 * renders it. Without it the click froze on the old page until the server
 * answered. It fills only the content area: the admin layout (top bar, side
 * nav) stays on screen around it.
 */
export default function AdminLoading() {
  return <PageFallback />;
}
