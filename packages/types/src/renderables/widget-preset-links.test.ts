import { describe, expect, it } from "vitest";
import { WIDGET_DEFINITIONS } from "./widgets";

/**
 * Every URL a widget preset ships must open a live page. The Quick Access
 * preset linked Docs, Community and Support to synap.so, a domain that answers
 * 404 for all three. The scanned set is derived from every preset's config, so
 * a new preset is covered without being listed here.
 */
const DEAD_HOSTS = ["synap.so"];

function collectUrls(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, out);
  }
}

describe("widget preset links", () => {
  const urls: string[] = [];
  for (const def of WIDGET_DEFINITIONS) {
    for (const preset of def.presets ?? []) collectUrls(preset, urls);
  }

  it("finds preset URLs to check", () => {
    expect(urls.length).toBeGreaterThan(0);
  });

  it("never points at a dead host, and always uses https", () => {
    const bad = urls.filter((url) => {
      const { protocol, hostname } = new URL(url);
      return (
        protocol !== "https:" ||
        DEAD_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))
      );
    });
    expect(bad).toEqual([]);
  });
});
