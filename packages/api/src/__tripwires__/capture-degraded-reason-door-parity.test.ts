/**
 * TRIPWIRE — the capture honesty triple must reach EVERY door, not just tRPC.
 *
 * THE INCIDENT (live dogfood, deployed pod): `synap import /tmp/zzimg.png` on a
 * pod with no vision provider printed
 *
 *   "AI structuring unavailable (is_empty_result) — nothing was created.
 *    Retry when it's back."
 *
 * Every clause of that is false. The Intelligence Service had returned the
 * honest `vision_provider_not_configured` — a PERMANENT configuration state,
 * not an outage — and two seams destroyed it:
 *
 *   1. the pod's silent-empty guard unconditionally relabelled it
 *      `is_empty_result` (a generic overwriting a specific), and
 *   2. the Hub REST 200 codec declared NOTHING, so `degraded`,
 *      `degradedReason` and `extraction` were undocumented on the door that
 *      CLI, Raycast and every external agent use — the primary door for a
 *      Bring-Your-Own-Agent product.
 *
 * The same omission on `/capture/execute`'s `file` meant `extractedText` could
 * never round-trip: zod STRIPS what it does not declare, so every CLI/agent
 * file capture stored a kept blob with an EMPTY `document_versions.content`.
 *
 * These tests assert the WIRE (what the codecs keep and declare) and the
 * DECISION (which reason wins) — not the presence of a keyword.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveEmptyResultDegradedReason } from "../routers/capture.js";
import {
  CaptureExecuteRequestSchema,
  CaptureStructureResponseSchema,
} from "../routers/hub-protocol/rest/_codecs/misc.js";

/**
 * The eleven honesty reasons the Intelligence Service emits, plus the three
 * pod plumbing ones. Sourced from `synap-intelligence-service`'s
 * `extraction/extractors/*` + `extraction/index.ts`.
 */
const IS_EXTRACTION_REASONS = [
  "pdf_scanned_needs_ocr",
  "pdf_missing_binary",
  "vision_provider_not_configured",
  "image_missing_binary",
  "transcription_provider_not_configured",
  "audio_missing_binary",
  "docx_missing_binary",
  "docx_empty",
  "html_empty",
  "unsupported_type",
] as const;

const POD_PLUMBING_REASONS = [
  "is_auth_error",
  "is_invalid_response",
  "is_empty_result",
] as const;

describe("capture degraded-reason door parity", () => {
  describe("the DECISION: a specific IS reason beats the generic pod one", () => {
    it.each(IS_EXTRACTION_REASONS)(
      "keeps %s verbatim instead of relabelling it is_empty_result",
      (reason) => {
        expect(resolveEmptyResultDegradedReason(reason)).toBe(reason);
      }
    );

    it("falls back to is_empty_result only when the IS said nothing", () => {
      expect(resolveEmptyResultDegradedReason(undefined)).toBe(
        "is_empty_result"
      );
      expect(resolveEmptyResultDegradedReason(null)).toBe("is_empty_result");
      // A blank/whitespace reason is "said nothing", not a reason to report.
      expect(resolveEmptyResultDegradedReason("")).toBe("is_empty_result");
      expect(resolveEmptyResultDegradedReason("   ")).toBe("is_empty_result");
    });

    it("forwards a reason the pod has never been taught (IS owns the vocabulary)", () => {
      // A closed enum here would silently discard the next honest reason the
      // IS adds — the exact failure mode this tripwire exists for.
      expect(resolveEmptyResultDegradedReason("ocr_budget_exhausted")).toBe(
        "ocr_budget_exhausted"
      );
    });
  });

  describe("the WIRE: the REST 200 codec DECLARES the honesty triple", () => {
    const shape = CaptureStructureResponseSchema.shape;

    it("declares degraded, degradedReason and extraction", () => {
      // `.passthrough()` would let these ride through undeclared — but an
      // undeclared field is published nowhere and promised to nobody, which is
      // precisely why the CLI/Raycast/agent door lost them. A declared zod
      // schema IS the contract.
      expect(Object.keys(shape)).toEqual(
        expect.arrayContaining(["degraded", "degradedReason", "extraction"])
      );
    });

    it("declares every field of the extraction summary the tRPC door forwards", () => {
      const extractionShape = (
        shape.extraction as unknown as {
          def: { innerType: { shape: Record<string, unknown> } };
        }
      ).def.innerType.shape;
      // Mirrors `intelligence-client`'s structure() `extraction` return, which
      // is what the tRPC door passes through as `extractionPassThrough`.
      expect(Object.keys(extractionShape).sort()).toEqual(
        [
          "extractor",
          "kind",
          "metadata",
          "text",
          "textTruncated",
          "warnings",
        ].sort()
      );
    });

    it.each([...IS_EXTRACTION_REASONS, ...POD_PLUMBING_REASONS])(
      "round-trips %s through the response codec without dropping or coercing it",
      (reason) => {
        const parsed = CaptureStructureResponseSchema.parse({
          proposals: [],
          relations: [],
          followUp: null,
          degraded: true,
          degradedReason: reason,
          extraction: {
            kind: "image",
            extractor: "vision",
            warnings: ["no vision provider configured"],
          },
        });
        expect(parsed.degraded).toBe(true);
        expect(parsed.degradedReason).toBe(reason);
        expect(parsed.extraction).toEqual({
          kind: "image",
          extractor: "vision",
          warnings: ["no vision provider configured"],
        });
      }
    );
  });

  describe("the WIRE: /capture/execute keeps the extracted text", () => {
    it("does NOT strip file.extractedText / file.extractedTextTruncated", () => {
      // Delete either field from the codec and this fails: zod strips unknown
      // keys, so the text silently never reaches `storeEntitySourceBlob` and
      // the kept document lands with an empty body and no error anywhere.
      const parsed = CaptureExecuteRequestSchema.parse({
        entities: [
          { tempId: "t1", profileSlug: "item", title: "Scanned invoice" },
        ],
        keepRaw: true,
        file: {
          content: "AAAA",
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          extractedText: "Invoice #42 — total 100 EUR",
          extractedTextTruncated: true,
        },
      });
      expect(parsed.file?.extractedText).toBe("Invoice #42 — total 100 EUR");
      expect(parsed.file?.extractedTextTruncated).toBe(true);
    });
  });

  describe("the CALL SITE: the silent-empty guard must go through the resolver", () => {
    it("never hardcodes is_empty_result at the guard", () => {
      // A source scan is the only way to catch a revert of the guard itself
      // (it lives inside a 500-line tRPC procedure that cannot be invoked
      // without the whole IS + DB world). Scoped to the guard BLOCK, not the
      // whole method, and asserting the CALL form — an import alone is not
      // proof the resolver is used.
      const source = readFileSync(
        join(__dirname, "..", "routers", "capture.ts"),
        "utf8"
      );
      const start = source.indexOf("// 1b. Silent-empty guard");
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf(
        "// Normalise every Knowledge proposal",
        start
      );
      expect(end).toBeGreaterThan(start);
      const guard = source.slice(start, end);

      expect(guard).toMatch(
        /resolveEmptyResultDegradedReason\(\s*structureResult\.degradedReason\s*\)/
      );
      // The generic label may appear ONLY inside the resolver and in log copy —
      // never as the argument the fallback is built from.
      expect(guard).not.toMatch(/degradedFallback\(\s*"is_empty_result"\s*\)/);
      // And the evidence behind the reason rides along.
      expect(guard).toMatch(/structureResult\.extraction/);
    });
  });
});
