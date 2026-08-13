/**
 * `transform` step executor — pipe-style expressions over a prior step value.
 */
import {
  resolveTemplate,
  matchWholeStringReference,
} from "../template-resolve.js";
import { resolveReferencePath } from "../context-path.js";
import { evaluateCondition } from "../condition-eval.js";
import { logger } from "../automation-executor-logger.js";
import type { StepContext } from "../automation-executor-types.js";

export function executeTransformStep(
  data: { expression: string },
  context: StepContext
): Record<string, unknown> {
  const expr = data.expression.trim();

  // Split on " | " to find pipe operations
  const pipeIdx = expr.indexOf(" | ");
  if (pipeIdx === -1) {
    // No pipe — resolve the expression as a template and return it
    const resolved = resolveTemplate(expr, context);
    return { result: resolved };
  }

  const templatePart = expr.slice(0, pipeIdx).trim();
  const pipePart = expr.slice(pipeIdx + 3).trim();

  // Resolve the template variable (or literal) before the pipe
  let value: unknown;
  // If it looks like a plain {{...}} reference, resolve the raw path value (not
  // stringified). Uses the SHARED matcher — this site was missed when the
  // both-ends-anchored `/^\{\{(.+?)\}\}$/` was replaced elsewhere, and a
  // transform whose pre-pipe part held two placeholders (`"{{a}} {{b}} | trim"`)
  // would still have captured the junk path `a}} {{b` and yielded undefined.
  // Four call sites, not three: that is why the matcher is a named export
  // rather than a regex written out per site.
  const templateMatch = matchWholeStringReference(templatePart);
  if (templateMatch !== null) {
    value = resolveReferencePath(templateMatch, context);
  } else {
    value = resolveTemplate(templatePart, context);
  }

  // Apply each pipe in sequence (supports chaining: "| trim | uppercase")
  const pipes = pipePart.split("|").map((p) => p.trim());
  let current: unknown = value;

  for (const pipe of pipes) {
    // Array-aware pipes take an argument after ":" — split name from arg.
    // Scalar pipes below have no ":" so `pipeName` === `pipe` for them.
    const colonIdx = pipe.indexOf(":");
    const pipeName = colonIdx === -1 ? pipe : pipe.slice(0, colonIdx).trim();
    const pipeArg = colonIdx === -1 ? "" : pipe.slice(colonIdx + 1).trim();

    // ── Array-aware pipes ───────────────────────────────────────────────
    // Operate on an array input; a non-array input is treated as empty so a
    // flow that expected a list degrades to [] rather than throwing.
    if (
      pipeName === "filter" ||
      pipeName === "map" ||
      pipeName === "unique" ||
      pipeName === "slice"
    ) {
      const arr = Array.isArray(current) ? current : [];
      switch (pipeName) {
        case "filter": {
          // Reuse the shared predicate evaluator. Each item is exposed as
          // `item` (and `loop.item`) in a per-item context so the predicate
          // can reference `item.<field>` — e.g. "filter:item.score > 5".
          current = arr.filter((item, index) => {
            const itemContext: StepContext = {
              ...context,
              loop: { item, index },
              item,
            };
            return evaluateCondition(pipeArg, itemContext);
          });
          break;
        }
        case "map": {
          // Resolve `pipeArg` as a template per item, exposing `item`. Returns
          // the raw resolved value when the arg is a single `{{...}}` ref,
          // otherwise the interpolated string.
          const singleRef = matchWholeStringReference(pipeArg);
          current = arr.map((item, index) => {
            const itemContext: StepContext = {
              ...context,
              loop: { item, index },
              item,
            };
            return singleRef !== null
              ? resolveReferencePath(singleRef, itemContext)
              : resolveTemplate(pipeArg, itemContext);
          });
          break;
        }
        case "unique": {
          // Dedupe by JSON identity so objects/arrays compare structurally.
          const seen = new Set<string>();
          current = arr.filter((item) => {
            const key =
              typeof item === "object" && item !== null
                ? JSON.stringify(item)
                : String(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          break;
        }
        case "slice": {
          const n = Number(pipeArg);
          current = Number.isFinite(n) ? arr.slice(0, n) : arr;
          break;
        }
      }
      continue;
    }

    // ── Scalar pipes (unchanged) ────────────────────────────────────────
    switch (pipe) {
      case "uppercase":
        current =
          typeof current === "string"
            ? current.toUpperCase()
            : String(current ?? "").toUpperCase();
        break;
      case "lowercase":
        current =
          typeof current === "string"
            ? current.toLowerCase()
            : String(current ?? "").toLowerCase();
        break;
      case "json":
        current = JSON.stringify(current);
        break;
      case "trim":
        current =
          typeof current === "string"
            ? current.trim()
            : String(current ?? "").trim();
        break;
      case "url_extract": {
        const text =
          typeof current === "string" ? current : String(current ?? "");
        // Strip trailing sentence punctuation/brackets so "see https://x.com."
        // yields "https://x.com" (not the broken "https://x.com.").
        current = (text.match(/https?:\/\/[^\s>]+/g) ?? []).map((u) =>
          u.replace(/[.,!?;:'")\]}>]+$/, "")
        );
        break;
      }
      case "date_ms":
      case "to_ms": {
        // Parse a date STRING (ISO-8601 or RFC-2822 — the shape gmail_search
        // returns in the `date` header) to epoch milliseconds, so a watermark
        // filter can compare it numerically (e.g. `item.dateMs > automation.
        // state.lastProcessedMs`). Date.parse handles BOTH grammars natively.
        const text =
          typeof current === "string" ? current : String(current ?? "");
        const ms = Date.parse(text.trim());
        // Unparseable → 0 sentinel (a stable, comparable value) rather than NaN
        // (which would make every numeric compare silently false) or a throw
        // (which would fail the whole flow on one bad date header).
        current = Number.isNaN(ms) ? 0 : ms;
        break;
      }
      default:
        logger.warn({ pipe }, "transform: unknown pipe operation — skipping");
    }
  }

  return { result: current };
}
