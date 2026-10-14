/** Types for strip-comments.mjs — see that file for what it handles and what it cannot. */

/**
 * `source` with every comment character replaced by a space (line breaks kept):
 * same length, same line numbers; strings, templates and regex literals intact.
 * `"ts"` covers .ts/.tsx/.js/.mjs (// and block comments, JSX `{/* … *\/}`);
 * `"css"` covers block comments only.
 */
export function stripComments(source: string, lang: "ts" | "css"): string;
