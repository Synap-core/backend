/**
 * Whether a cell's stored source IS AN HTML PAGE — the ONE classifier.
 *
 * A cell's mechanism (`widget_definitions.renderer_type`) says how a surface
 * draws its source: `frame` runs it as an ES module in the sandboxed React
 * frame (synap-app `cell-runtime/ViewFrame`), `iframe` loads it as an HTML
 * document. An agent that writes a cell (MCP `synap_create_cell`, Hub
 * `POST /cells/define`) names no mechanism, so the write door derives it from
 * the source with this function, and every surface that reads a row still
 * stored under the wrong mechanism asks the same question: the pod's
 * `defineCell`, migration 0366, the pod console's `cellIsHtmlPage`, the
 * desktop's cell registration.
 *
 * The rule: after an optional byte-order mark and whitespace, the first
 * character is `<` (`<!doctype`, `<html`, `<title>`, `<style>`, `<div>`,
 * `<!-- … -->` …). A full document is NOT required — an agent's report that
 * opens with `<title>` and never writes `<html>` is a page (browsers build the
 * document around it), and that is exactly the case a doctype-only test
 * missed (document 6aa8d140, cell `generated:claude-code-fleet-report`).
 *
 * Why that is sound: a `frame` cell is an ES module that must
 * `export default` a component, so its source starts with `import`, `export`,
 * a `//` or block comment, or other code. No module that exports a component
 * can open with `<`: a leading JSX element is an expression statement whose
 * value is discarded, and the legacy `<!--` comment is a syntax error in a
 * module. So a source opening with `<` is never a working frame cell, and a
 * source that does not open with `<` is never treated as a page here.
 *
 * Mirror: Postgres reads the same rule in migration 0366
 * (`renderer_source ~ '^\uFEFF?\s*<'`).
 */

const HTML_PAGE_START = /^\uFEFF?\s*</;

export function isHtmlPageSource(source: unknown): boolean {
  return typeof source === "string" && HTML_PAGE_START.test(source);
}
