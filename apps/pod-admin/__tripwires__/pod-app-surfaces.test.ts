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
const CHOICES = "app/oauth/consent/AccessChoices.tsx";
const PAYLOAD = "app/oauth/consent/allow-payload.ts";
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
    for (const f of [CONSENT, CONSENT_PAGE, CHOICES, CONNECTIONS, APP_PAGE]) {
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
    expect(src).toMatch(/blockedReason=\{draftBlockedReason\(/);
    expect(src).toMatch(/isDisabled=\{busy \|\| blockedReason !== null\}/);
    expect(src).toMatch(/aria-describedby=\{\s*blockedReason/);
  });

  it("consent: the draft starts from the shared rule and Allow sends it within the offer; the width is the model's", () => {
    const src = read(CONSENT);
    expect(src).toMatch(
      /reconsentDraft\(heldAccessOf\(app\.approved\), offer,/
    );
    // What Allow sends comes from ONE pure rule (tested in allow-payload.test).
    expect(src).toMatch(/allowPayload\(\{/);
    expect(src).toMatch(/access: payload\.access/);
    expect(src).toMatch(/approved: payload\.approved/);
    expect(read(PAYLOAD)).toMatch(/toApprovedPairs\(draft, offer\)/);
    expect(src).toMatch(/width=\{consentWidth\(params\.clientId\)\}/);
  });

  it("consent: every choice goes through the shared narrow-only rules; the pod-wide kinds are the server's list", () => {
    // Prettier may break a call over lines: compare without that layout.
    const src = read(CHOICES)
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")");
    for (const rule of [
      "setRowLevel(draft, row, level)",
      "toggleKind(draft, row, kind)",
      "toggleAllKinds(draft, row)",
      "setReadSpacesMode(draft, offer,",
      "toggleReadSpace(draft, sid)",
      "toggleReadProject(draft, pid)",
      "setKindLevel(draft, row, kind, level)",
      "setPermission(draft, p.permission, on)",
      'toggleWritePlace(draft, "space", s.workspaceId)',
      'toggleWritePlace(draft, "project", p.projectId)',
    ]) {
      expect(src, rule).toContain(rule);
    }
    // The pod-wide note is the server's list, never a hand list of kinds.
    expect(src).toMatch(/podWideKinds\.includes\(row\.kind\)/);
    expect(read(CONSENT)).toMatch(/podWideKinds=\{app\.podWideKinds\}/);
  });

  it("consent: the invalid-request hint comes from the client kind", () => {
    const src = read(CONSENT);
    expect(src).toMatch(/hint=\{invalidRequestHint\(params\.clientId\)\}/);
    expect(src).not.toMatch(/from Claude/);
  });

  it("consent: the space hint is never part of what the server receives", () => {
    const page = read(CONSENT_PAGE);
    const params = page.slice(page.indexOf("params={{"));
    expect(params).not.toMatch(/space_?hint/i);
    expect(read(CONSENT)).not.toMatch(/\.\.\.params,\s*spaceHint/);
    // It reaches the model (order only): the page reads it, the form applies it.
    expect(page).toMatch(/spaceHint=\{/);
    expect(read(CONSENT)).toMatch(
      /spaceHintFirst\(offered\.permissions, spaceHint\)/
    );
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
