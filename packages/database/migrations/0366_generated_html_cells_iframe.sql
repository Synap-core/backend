-- 0366_generated_html_cells_iframe
--
-- An HTML page stored as a `frame` cell becomes an `iframe` cell.
--
-- Until this release the one cell write door (`defineCell`) stored every cell
-- an agent wrote as `renderer_type = 'frame'` (an ES module run in the
-- sandboxed React frame), because no agent door names a mechanism. An agent's
-- HTML page stored that way fails on the desktop (the frame imports it as a
-- module: a syntax error) and is not recognised as a page by the pod console
-- when it does not open with a doctype (document 6aa8d140,
-- `generated:claude-code-fleet-report`, which opens with `<title>`).
-- `defineCell` now derives the mechanism from the source; this moves the rows
-- written before it.
--
-- The rule is `isHtmlPageSource` (`@synap-core/types/renderables`): after an
-- optional byte-order mark and whitespace, the first character is `<`. A frame
-- cell is an ES module that exports a component, so it never opens with `<`.
-- In the pattern (a standard string: the backslashes reach the regex engine
-- as written) `\uFEFF` is the byte-order mark and `\s` whitespace.
--
-- Only `frame` rows move; `builtin`, `mcp-app` and `iframe` rows are untouched.
-- `updated_at` is stamped so replication and the desktop's refresh see the
-- change. Idempotent: a second run matches nothing. No new column, so no
-- change to the baseline or to schema coherence.
--
-- Rollback needs no undo: on a previous release a moved page is still not
-- drawn on the desktop (as `frame` it failed as a module; as `iframe` an
-- embed by key finds no registration), and the previous console draws an
-- `iframe` page (it did not draw a `frame` page that opens with `<title>`).

UPDATE "widget_definitions"
SET "renderer_type" = 'iframe',
    "updated_at" = now()
WHERE "renderer_type" = 'frame'
  AND "renderer_source" ~ '^\uFEFF?\s*<';
