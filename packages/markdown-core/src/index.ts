/**
 * @synap-core/markdown-core — the ONE Synap markdown spine (pure).
 *
 * Every reader and writer of Synap markdown — the web and native renderers,
 * relay, the backend section door and run summaries, later the editor, IS and
 * CLI — goes through these modules. No React, no Tiptap, no DOM.
 */
export * from "./markers.js";
export * from "./scan.js";
export * from "./processor.js";
export * from "./embeds.js";
export * from "./directive-registry.js";
export * from "./sections.js";
export * from "./plain-text.js";
export * from "./diagnostics.js";
export * from "./blame.js";
export * from "./diff.js";
