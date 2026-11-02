/**
 * What `workers.enable` takes beside the worker's key (goals that run): the
 * person's "How often?" clock and the mode a chosen clock runs in. One schema
 * for every door (tRPC `workers.enable`, Hub REST `POST /workers`); the
 * service reads the clock through `howOftenEnable`
 * (`@synap-core/types/workers/how-often`).
 */
import { z } from "zod";
import { WORKER_MODES } from "@synap-core/types/workers";

/** A clock answer: every day, or every week on a day, at "HH:MM" UTC. */
export const workerScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: z.string().trim().max(5) }),
  z.object({
    kind: z.literal("weekly"),
    day: z.number().int().min(0).max(6),
    time: z.string().trim().max(5),
  }),
]);

/** A chosen clock's mode: `propose` asks before each run (the default). */
export const workerModeSchema = z.enum(WORKER_MODES);
