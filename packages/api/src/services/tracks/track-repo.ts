/**
 * The ONE construction of `TrackRepository` in the api — shared by the tracks
 * service and the stage gate's track adapter (`services/playbooks/stage-gate.ts`),
 * which cannot import the service without a cycle. Every `project_tracks` write
 * goes through the repository, so every one emits `track.update.completed`.
 *
 * Hookless `new EventRepository(sql)`, like every other track write: `track.*`
 * has no realtime mapping (see `__tripwires__/realtime-event-hooks.test.ts`,
 * whose REALTIME_REPO_CLASSES does not list it). If tracks gain a realtime
 * mapping, switch THIS line to the `eventRepository` singleton — once.
 */

import { EventRepository, TrackRepository, getDb, sql } from "@synap/database";

export async function trackRepository(): Promise<TrackRepository> {
  const db = await getDb();
  return new TrackRepository(db, new EventRepository(sql));
}
