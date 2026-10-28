import { StartIslandSkeleton } from "./_lib/start-island";

/** S1 "Loading": three skeleton cards while the pod answers. */
export default function StartLoading() {
  return <StartIslandSkeleton step="start:intent" />;
}
