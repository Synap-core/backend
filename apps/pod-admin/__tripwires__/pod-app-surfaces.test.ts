import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * The pod-app surfaces' wiring, by scanning SOURCE (2026-10-22 UI review).
 *
 * The rules themselves are pure and tested beside their models
 * (`consent-model`, `key-model`, `pod-app-view`, `host-name`). What a model
 * test cannot see is a page that stops calling the rule: a keys list read
 * straight off `apiKeys.list`, an Allow button disabled on its own condition,
 * a switch that writes on its own change event. Each of those typechecks.
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) =>
  stripComments(readFileSync(join(APP_ROOT, rel), "utf8"), "ts");

const CONSENT = "app/oauth/consent/ConsentForm.tsx";
const CONSENT_PAGE = "app/oauth/consent/page.tsx";
const CONNECTIONS = "app/my-connections/page.tsx";
const APP_PAGE = "app/apps/[publicId]/page.tsx";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("pod-app surfaces", () => {
  it("the files this guards exist", () => {
    for (const f of [CONSENT, CONSENT_PAGE, CONNECTIONS, APP_PAGE]) {
      expect(existsSync(join(APP_ROOT, f)), f).toBe(true);
    }
  });

  it("/my-connections lists keys only through managedKeys", () => {
    const src = read(CONNECTIONS);
    expect(src).toMatch(/managedKeys\(\s*\(keys\.data/);
    // No other read of the raw list feeds a section.
    expect(src.match(/keys\.data/g)?.length).toBe(1);
  });

  it("consent: Allow is disabled by the shared rule, and says why", () => {
    const src = read(CONSENT);
    expect(src).toMatch(/blockedReason=\{allowBlockedReason\(/);
    expect(src).toMatch(/isDisabled=\{busy \|\| blockedReason !== null\}/);
    expect(src).toMatch(/aria-describedby=\{\s*blockedReason/);
  });

  it("consent: the invalid-request hint comes from the client kind", () => {
    const src = read(CONSENT);
    expect(src).toMatch(
      /hint=\{invalidRequestHint\(consentClientKind\(params\.clientId\)\)\}/
    );
    expect(src).not.toMatch(/from Claude/);
  });

  it("consent: the space hint is never part of what the server receives", () => {
    const page = read(CONSENT_PAGE);
    const params = page.slice(page.indexOf("params={{"));
    expect(params).not.toMatch(/space_?hint/i);
    expect(read(CONSENT)).not.toMatch(/\.\.\.params,\s*spaceHint/);
  });

  it("app page: Apply automatically goes through its confirm", () => {
    const src = read(APP_PAGE);
    expect(src).toMatch(/onValueChange=\{requestMode\}/);
    expect(src).toMatch(/writeModeConfirm\(on, pod\) === null/);
    expect(src).not.toMatch(/onValueChange=\{\(on\) => void switchMode/);
  });

  it("no pod-admin page renders an app domain outside HostName", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(join(APP_ROOT, "app"))) {
      const src = stripComments(readFileSync(f, "utf8"), "ts");
      if (/>\s*\{\s*[\w.]*\.domain\s*\}\s*</.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
