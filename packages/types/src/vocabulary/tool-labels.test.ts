/**
 * Tool labels — the merged door (`resolveToolLabel`), and a COVERAGE check
 * against the tools the IS actually defines.
 *
 * The coverage set is DERIVED by scanning the IS tool sources for `name: "…"`
 * definitions, never hand-listed (a hand list is how the four forked tables
 * fell behind). It reads the sibling repo, so it skips cleanly in an isolated
 * checkout where synap-intelligence-service is absent — same contract as
 * `capability-intents/parity.test.ts`.
 *
 * What it does NOT see: a tool whose name is built at runtime (dynamic skills,
 * MCP-proxied tools) — those reach the fallback, which humanizes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  humanizeToken,
  isKnownToolName,
  resolveObjectNoun,
  resolveToolLabel,
} from "./index.js";

describe("resolveToolLabel — merged seeds", () => {
  it("search reads as one answer across the old tables, in every mood", () => {
    for (const name of ["search", "search_unified", "search_entities"]) {
      expect(resolveToolLabel(name, "progressive")).toBe("Searching your pod");
      expect(resolveToolLabel(name, "past")).toBe("Searched your pod");
      expect(resolveToolLabel(name, "imperative")).toBe("Search your pod");
    }
  });

  it("defaults to the progressive mood (the live status line)", () => {
    expect(resolveToolLabel("web_search")).toBe("Searching the web");
    expect(resolveToolLabel("web_search", "past")).toBe("Searched the web");
  });

  it("keeps the delegation and memory rows the old tables carried", () => {
    expect(resolveToolLabel("dispatch_agent")).toBe("Delegating to a teammate");
    expect(resolveToolLabel("memory_search", "past")).toBe("Recalled memories");
    expect(resolveToolLabel("graph_traverse", "past")).toBe(
      "Explored connections"
    );
  });

  it("composes <verb>_<object> through the ONE noun door", () => {
    // The glossary calls an automation a rule — the label follows it.
    expect(resolveObjectNoun("automation")).toBe("Rule");
    expect(resolveToolLabel("create_automation")).toBe("Creating rule");
    expect(resolveToolLabel("create_automation", "past")).toBe("Created rule");
    expect(resolveToolLabel("get_document", "past")).toBe("Read document");
    // list_ takes the curated PLURAL, never singular + "s".
    expect(resolveToolLabel("list_views", "past")).toBe("Listed views");
    expect(resolveToolLabel("list_entities")).toBe("Listing entities");
    // A phrase routes each kind word through the door.
    expect(resolveToolLabel("promote_session_to_playbook", "past")).toBe(
      "Promoted session to template"
    );
    // Acronyms stay upper-case mid-sentence.
    expect(resolveToolLabel("request_mcp")).toBe("Requesting MCP server");
  });

  it("an irregular past is curated, not suffixed", () => {
    expect(resolveToolLabel("run_capability", "past")).toBe("Ran tool");
    expect(resolveToolLabel("set_track_status", "past")).toBe(
      "Set track status"
    );
  });

  it("is case/whitespace tolerant on the name", () => {
    expect(resolveToolLabel("  Search_Unified ")).toBe("Searching your pod");
  });

  it("an unknown tool humanizes — the same words in every mood, never raw", () => {
    expect(isKnownToolName("frobnicate_thing")).toBe(false);
    for (const mood of ["progressive", "past", "imperative"] as const) {
      expect(resolveToolLabel("frobnicate_thing", mood)).toBe(
        "Frobnicate thing"
      );
    }
    expect(resolveToolLabel(null)).toBe("");
    expect(isKnownToolName(undefined)).toBe(false);
  });
});

// ─── Coverage over the IS's real tool names ──────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
// src/vocabulary → src → types → packages → synap-backend → monorepo root
const IS_TOOLS_DIR = join(
  HERE,
  "../../../../../synap-intelligence-service/apps/intelligence-hub/src/tools"
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [path] : [];
  });
}

/** `name: "search_unified",` — a tool definition's name line, line-anchored. */
const NAME_LINE = /^\s*name:\s*["']([a-z][a-z0-9_]*)["']/gm;

function deriveIsToolNames(): string[] {
  const names = new Set<string>();
  for (const file of walk(IS_TOOLS_DIR)) {
    for (const m of readFileSync(file, "utf8").matchAll(NAME_LINE)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

describe.skipIf(!existsSync(IS_TOOLS_DIR))(
  "resolveToolLabel — covers every tool the IS defines",
  () => {
    it("the scan can still see its own target (self-check)", () => {
      NAME_LINE.lastIndex = 0;
      expect([...`  name: "search_unified",`.matchAll(NAME_LINE)][0]?.[1]).toBe(
        "search_unified"
      );
    });

    it("finds a plausible number of tools (non-vacuity)", () => {
      const names = deriveIsToolNames();
      // 98 on 2026-10-05. A floor, not an exact count: the IS adds tools.
      expect(names.length).toBeGreaterThan(60);
      expect(names).toContain("search_unified");
      expect(names).toContain("create_entity");
    });

    it("every IS tool has curated words, in every mood", () => {
      const uncurated: string[] = [];
      for (const name of deriveIsToolNames()) {
        if (!isKnownToolName(name)) {
          uncurated.push(name);
          continue;
        }
        for (const mood of ["progressive", "past", "imperative"] as const) {
          const label = resolveToolLabel(name, mood);
          expect(label, `${name}/${mood}`).not.toMatch(/_/);
          expect(label, `${name}/${mood}`).not.toBe("");
        }
        // A known tool must say MORE than the humanized fallback in the moods
        // that carry tense — otherwise "known" is a claim nobody earned.
        expect(resolveToolLabel(name, "progressive"), name).not.toBe(
          humanizeToken(name)
        );
      }
      // Add an override row (or a verb) in tool-labels.ts for each of these.
      expect(uncurated).toEqual([]);
    });
  }
);
