/**
 * Worker-thread entry of the CPU pool (cpu-pool.ts): runs one CpuTask per
 * message. Nothing else runs here: no network, no database, no logger — the
 * pool logs and enforces the deadline. Built next to cpu-pool.js
 * (`dist/utils/cpu-worker.js`, tsc).
 */

import { serveWorkerTasks } from "@synap/shared-utils/worker-task";
import { runCpuTask, type CpuTask } from "./cpu-tasks.js";

serveWorkerTasks((task: CpuTask) => runCpuTask(task));
