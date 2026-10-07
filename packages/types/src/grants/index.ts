/**
 * `@synap-core/types/grants` — what one credential may touch.
 *
 *  - `grammar`  — the permission grammar + matcher (the backend enforces it;
 *                 mirrored byte-for-byte in `@synap/governance-policy/grants`).
 *  - `catalog`  — the subjects × actions a UI offers, worded by the vocabulary.
 *  - `draft`    — the value a selector edits (= the mint wire shape) and its ops.
 *  - `summary`  — the read-only rendering model.
 *  - `presets`  — named permission lists, the seed of ROLES.
 *  - `agent`    — an agent's capability allowlist, edited as a grant.
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
