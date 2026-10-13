/**
 * `@synap-core/types/grants` — what one credential may touch.
 *
 *  - `grammar`  — the permission grammar + matcher (the backend enforces it;
 *                 mirrored byte-for-byte in `@synap/governance-policy/grants`).
 *  - `catalog`  — the subjects × actions a UI offers, worded by the vocabulary.
 *  - `draft`    — the value a selector edits (= the mint wire shape) and its ops.
 *  - `summary`  — the read-only rendering model.
 *  - `presets`  — roles: built-in presets and the person's stored roles.
 *  - `agent`    — an agent's capability allowlist, edited as a grant.
 *  - `sections` — how an editor groups, describes and counts the subjects.
 *  - `holder`   — what a holder (agent, app, key) may do, in one reading.
 *  - `listed`   — a listed grant back into the editor, keeping its lineage.
 *  - `algebra`  — cover, meet and containment of grants, exact against `permits`.
 *
 * Pure and dependency-free: browser, Electron, landing, Node and CLI.
 */
export * from "./grammar.js";
export * from "./catalog.js";
export * from "./draft.js";
export * from "./summary.js";
export * from "./presets.js";
export * from "./agent.js";
export * from "./sections.js";
export * from "./holder.js";
export * from "./listed.js";
export * from "./algebra.js";
