#!/usr/bin/env node
/**
 * The choice-rule eval of the `surfaces` skill: does an agent that has read ONLY
 * the system skills pick the right body and door for each prompt?
 *
 * The system prompt is the assembled `surfaces/SKILL.md` plus the core `synap`
 * teaching (by default its alwaysOn topics, as `_teaching.json` marks them: what
 * an installed agent always carries; `SURFACES_EVAL_CORE=full` sends the whole
 * `synap/SKILL.md`). No other skill (synap-ui, synap-design) is loaded. Each
 * prompt is asked once; the model answers with one JSON object, graded against
 * `prompts.yaml` (body AND door in the accepted lists, an anchor when the item
 * says `attached`, the view type when it says `expectViewType`).
 *
 * Bar: >= 24/26 prompts and 7/7 adversarial. Exit 0 on pass, 1 on fail, 2 when
 * it could not run (no credential, no SDK, an API error).
 *
 * Run (from any directory where `@anthropic-ai/sdk` is installed; the SDK is
 * resolved from the CURRENT directory, so the backend needs no new dependency):
 *   mkdir -p /tmp/surfaces-eval && cd /tmp/surfaces-eval && npm i @anthropic-ai/sdk
 *   node skills/surfaces/eval/run.mjs            # paths are relative to synap-backend
 *   (or: node <abs path>/skills/surfaces/eval/run.mjs --json out.json)
 * Credentials: whatever the SDK resolves (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 * or an `ant auth login` profile). `node skills/build.mjs` first, so SKILL.md is
 * current. Cost: one cached ~20-90K-token system prompt + 33 short turns.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(HERE, "../..");
const MODEL = process.env.SURFACES_EVAL_MODEL || "claude-opus-5-5";
const BAR = { prompts: 24, adversarial: 7 };
const BODIES = ["view", "document", "bento", "html", "whiteboard", "renderer", "cell", "site"];

// ── prompts.yaml: the flat subset it is written in (no YAML library) ─────────
export function parsePrompts(text) {
  const sections = {};
  let section = null;
  let item = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) continue;
    const top = /^([a-z]+):$/.exec(line);
    if (top) {
      section = sections[top[1]] = [];
      continue;
    }
    const kv = /^\s*(-\s+)?([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv || !section) throw new Error(`prompts.yaml: cannot read "${line}"`);
    if (kv[1]) section.push((item = {}));
    const value = kv[3];
    item[kv[2]] = value.startsWith("[")
      ? value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
      : value === "true" || value === "false"
        ? value === "true"
        : value.startsWith('"')
          ? JSON.parse(value)
          : value;
  }
  for (const [name, items] of Object.entries(sections)) {
    for (const it of items) {
      for (const key of ["id", "prompt", "expectBody", "expectDoor", "why"]) {
        if (it[key] === undefined) throw new Error(`prompts.yaml ${name}/${it.id}: no ${key}`);
      }
      const bad = it.expectBody.filter((b) => !BODIES.includes(b));
      if (bad.length) throw new Error(`prompts.yaml ${it.id}: unknown body ${bad}`);
    }
  }
  return sections;
}

// ── the system prompt: surfaces + synap core, nothing else ───────────────────
function systemPrompt() {
  const surfaces = readFileSync(join(SKILLS, "surfaces/SKILL.md"), "utf8");
  let core;
  if (process.env.SURFACES_EVAL_CORE === "full") {
    core = readFileSync(join(SKILLS, "synap/SKILL.md"), "utf8");
  } else {
    const teaching = JSON.parse(readFileSync(join(SKILLS, "_teaching.json"), "utf8"));
    core = Object.entries(teaching)
      .filter(([k, v]) => k.startsWith("synap/") && typeof v === "object" && v.alwaysOn)
      .map(([k]) => readFileSync(join(SKILLS, `${k}.md`), "utf8"))
      .join("\n\n---\n\n");
  }
  return [
    "You are an agent connected to the person's Synap pod. These are the skills you have loaded.",
    "<skill name=\"synap\">\n" + core + "\n</skill>",
    "<skill name=\"surfaces\">\n" + surfaces + "\n</skill>",
  ].join("\n\n");
}

const INSTRUCTION = `Do not call any tool. Say what you would make for the request below, as ONE JSON object and nothing else:
{"body": one of ${BODIES.join(" | ")} (renderer = a kind's renderer binding; site = a Site or an external app),
 "door": the one MCP tool (its synap_* name) that makes or binds it, or "none" when nothing new is made,
 "attachedTo": the kind of the ONE object it is anchored to (entity | profile | workspace | project | track | playbook | session), or null,
 "viewType": the view type when body is view (else null),
 "why": one short sentence}
Request: `;

function lastJson(text) {
  const start = text.lastIndexOf("{");
  for (let i = start; i >= 0; i = text.lastIndexOf("{", i - 1)) {
    try {
      return JSON.parse(text.slice(i, text.lastIndexOf("}") + 1));
    } catch {
      /* try an earlier brace */
    }
  }
  throw new Error(`no JSON object in the answer: ${text.slice(0, 200)}`);
}

export function grade(item, answer) {
  const misses = [];
  if (!item.expectBody.includes(answer.body)) misses.push(`body ${answer.body}`);
  if (!item.expectDoor.includes(answer.door)) misses.push(`door ${answer.door}`);
  if (item.attached && !answer.attachedTo) misses.push("not anchored to one object");
  if (item.expectViewType && !item.expectViewType.includes(answer.viewType))
    misses.push(`viewType ${answer.viewType}`);
  return misses;
}

async function loadSdk() {
  const require = createRequire(join(process.cwd(), "noop.js"));
  const mod = await import(pathToFileURL(require.resolve("@anthropic-ai/sdk")).href);
  return mod.default;
}

async function main() {
  const out = process.argv.includes("--json")
    ? process.argv[process.argv.indexOf("--json") + 1]
    : null;
  const sets = parsePrompts(readFileSync(join(HERE, "prompts.yaml"), "utf8"));
  let Anthropic;
  try {
    Anthropic = await loadSdk();
  } catch {
    console.error("NOT RUN: @anthropic-ai/sdk is not installed in the current directory (npm i @anthropic-ai/sdk).");
    process.exit(2);
  }
  const client = new Anthropic();
  const system = [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }];
  const results = {};
  for (const [name, items] of Object.entries(sets)) {
    results[name] = [];
    for (const item of items) {
      let answer;
      let misses;
      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4000,
          system,
          output_config: { effort: "medium" },
          messages: [{ role: "user", content: INSTRUCTION + item.prompt }],
        });
        if (response.stop_reason === "refusal") throw new Error("refusal");
        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        answer = lastJson(text);
        misses = grade(item, answer);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          console.error("NOT RUN: no valid Anthropic credential (ANTHROPIC_API_KEY or `ant auth login`).");
          process.exit(2);
        }
        if (err instanceof Anthropic.APIError) {
          console.error(`NOT RUN: API error ${err.status}: ${err.message}`);
          process.exit(2);
        }
        answer = { error: String(err.message ?? err) };
        misses = ["no answer"];
      }
      const pass = misses.length === 0;
      results[name].push({ id: item.id, prompt: item.prompt, pass, misses, answer });
      console.log(`${pass ? "PASS" : "FAIL"} ${item.id} ${JSON.stringify(item.prompt)} → ${answer.body ?? "?"} / ${answer.door ?? "?"}${answer.attachedTo ? ` on ${answer.attachedTo}` : ""}${pass ? "" : `  (${misses.join("; ")})`}`);
    }
  }
  const score = (n) => (results[n] ?? []).filter((r) => r.pass).length;
  const summary = {
    model: MODEL,
    core: process.env.SURFACES_EVAL_CORE === "full" ? "full" : "alwaysOn",
    prompts: `${score("prompts")}/${results.prompts.length}`,
    adversarial: `${score("adversarial")}/${results.adversarial.length}`,
    pass: score("prompts") >= BAR.prompts && score("adversarial") >= BAR.adversarial,
  };
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
  process.exit(summary.pass ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
