/**
 * @synap-core/types/find — the client side of the ONE find door
 * (`knowledge.find`, MCP `synap_find`, Hub `GET /find`).
 *
 *  - `toFindRows`: the wire's per-catalog blocks as ONE row type (`FindRow`),
 *    interleaved, with each row's tier, run and open (`rows.ts`);
 *  - `bindContext`: what the person selected, filled into the right slot of a
 *    row before it runs, never guessed (`bind-context.ts`);
 *  - `isQuestion`: the cue that starts the pod's answer in parallel
 *    (`question.ts`);
 *  - the slot readers the run doors share (`slots.ts`).
 *
 * Pure and dependency-free: runs in the pod, Electron, React Native and the CLI.
 */
export * from "./question.js";
export * from "./slots.js";
export * from "./bind-context.js";
export * from "./rows.js";
