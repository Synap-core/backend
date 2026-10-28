import { describe, expect, it } from "vitest";
import { isHtmlPageSource } from "./html-page-source.js";

const BOM = String.fromCharCode(0xfeff);

/** How the founder's cell `generated:claude-code-fleet-report` opens (2026-10-28). */
const FLEET_REPORT =
  '<title>Claude Code Fleet Report</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<link rel="preconnect" href="https://fonts.googleapis.com">\n<style>\nbody { margin: 0 }\n</style>';

describe("isHtmlPageSource — a page opens with `<`, a module never does", () => {
  it.each([
    ["a <title>-first fragment (the founder's report)", FLEET_REPORT],
    ["a doctype", "<!doctype html><html><body>x</body></html>"],
    ["an uppercase doctype", "<!DOCTYPE html>\n<html>"],
    ["an <html> root", "<html lang=en>"],
    ["a <style> block", "<style>body{}</style><div>x</div>"],
    ["a bare <div>", "<div>hello</div>"],
    ["an HTML comment", "<!-- generated -->\n<div>x</div>"],
    ["leading whitespace", "\n\n   \t<section>x</section>"],
    ["a byte-order mark", `${BOM}<!doctype html>`],
    ["a byte-order mark then whitespace", `${BOM}\n  <title>x</title>`],
  ])("%s is a page", (_label, source) => {
    expect(isHtmlPageSource(source)).toBe(true);
  });

  it.each([
    ["an import", 'import React from "react";\nexport default () => <div />;'],
    ["an export default", "export default function Cell() { return null; }"],
    ["a // comment", "// cell\nexport default () => null;"],
    ["a block comment", "/* cell */\nexport default () => null;"],
    ["JSX later in the module", "const x = <html />;\nexport default () => x;"],
    ["markup after code", "const html = `<div>`;"],
    ["text before markup", "Report\n<div>x</div>"],
  ])("%s is not a page", (_label, source) => {
    expect(isHtmlPageSource(source)).toBe(false);
  });

  it("no source is not a page", () => {
    expect(isHtmlPageSource("")).toBe(false);
    expect(isHtmlPageSource("   \n")).toBe(false);
    expect(isHtmlPageSource(null)).toBe(false);
    expect(isHtmlPageSource(undefined)).toBe(false);
    expect(isHtmlPageSource(42)).toBe(false);
  });
});
