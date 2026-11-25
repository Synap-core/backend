/**
 * The PDF verbs' one runner (PDF tools W1): pod PDFs in, a NEW pod file out.
 *
 *   1. Is the engine there? (`probePdfEngine`) — "off" and "down" are answered
 *      before any file is read or any work is done.
 *   2. The read floor, per source: `readableFileEntity` under the caller (the
 *      registered `entities` rule, a key's grant ANDed), then: in the trash or
 *      no stored bytes → `target_missing`; over 100 MB → `validation`; a type
 *      the verb cannot take → `validation`.
 *   3. The engine call (`callStirling`): the stored bytes stream from storage
 *      to the engine; the result comes back buffered (≤ 50 MB) and sniffed.
 *   4. The output, through the GOVERNED file door
 *      (`createGovernedFileEntityFromBuffer`: honest `ai_agent` provenance for
 *      an agent, created or proposed). The source is never overwritten.
 *   5. One `derived_from` edge per source (new file → source), through the
 *      governed `relations.create` caller the handler built. A proposed file
 *      has no id yet, so its links are honestly `pending`, never faked.
 *
 * `pdf.info` stops after step 3 and returns the engine's JSON: it creates
 * nothing.
 *
 * NEVER the ungoverned writers (`store-entity-source-blob.ts`,
 * `uploadBufferAsFileEntity`, `createFileEntityForStoredDocument`).
 */
import { db, getActingAgentUserId } from "@synap/database";
import { findUserDefaultWorkspaceId } from "../../utils/user-default-workspace.js";
import type { ProviderFileRef } from "../../connectors/provider-file-body.js";
import type { BuiltinVerbContext } from "../capabilities/builtin-verbs.js";
import { pdfText, type PdfCopyKey } from "./copy.js";
import {
  PDF_VERB_PARAMS,
  type PdfTransformVerb,
  type PdfVerbInput,
} from "./params.js";
import {
  callStirling,
  engineDownRefusal,
  engineOffRefusal,
  PDF_INPUT_MAX_BYTES,
  PDF_REFUSAL_CODES,
  probePdfEngine,
  refuse,
  stirlingCallFor,
  toPdfRouteFor,
  type StirlingDeps,
  type ToPdfRoute,
} from "./stirling-client.js";

/** The relation each new file carries to each of its sources. */
export const DERIVED_FROM = "derived_from";

/**
 * Scopes handed to the governed file door's caller context. That door's
 * `entities.create` reads none of them (governance keys on the acting agent and
 * the key grant in the request's ambient context, not on these); the value
 * mirrors the other non-HTTP caller of the door
 * (`connectors/ingest-inbound-attachments.ts`).
 */
const FILE_DOOR_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

/** The governed `relations.create` caller — the one procedure this runner uses. */
export interface DerivedLinkCaller {
  create(input: {
    sourceEntityId: string;
    targetEntityId: string;
    type: string;
    workspaceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

type PdfVerbCtx = Pick<
  BuiltinVerbContext,
  "userId" | "workspaceId" | "agentUserId" | "sessionId"
>;

export interface PdfDerivedLink {
  sourceFileId: string;
  state: "linked" | "proposed" | "failed";
  relationId?: string;
  proposalId?: string;
  /** Why the link was not made (the relation door's own words). */
  error?: string;
}

export interface PdfVerbResult {
  /** `created`: the file exists now. `proposed`: it lands on approval. */
  status: "created" | "proposed";
  fileEntityId?: string;
  proposalId?: string;
  reviewUrl?: string;
  documentId: string;
  title: string;
  mimeType: string;
  size: number;
  sourceFileIds: string[];
  /**
   * The `derived_from` edges as a whole: `linked` (all made), `proposed` (at
   * least one awaits review, none failed), `failed` (at least one was not
   * made: see `links`), `pending` (the file itself awaits review, so no edge
   * can exist yet).
   */
  link: "linked" | "proposed" | "failed" | "pending";
  links: PdfDerivedLink[];
  /** A fact about the result the caller should pass on (split → one ZIP). */
  note?: string;
}

interface SourceFile {
  id: string;
  title: string;
  mimeType: string;
  storageKey: string;
  size: number;
}

/** Run a verb that makes a new file. */
export async function runPdfVerb(
  verb: PdfTransformVerb,
  params: Record<string, unknown>,
  ctx: PdfVerbCtx,
  { caller }: { caller: DerivedLinkCaller },
  deps: StirlingDeps = {}
): Promise<PdfVerbResult> {
  const input = PDF_VERB_PARAMS[verb].parse(params) as PdfVerbInput<
    typeof verb
  >;
  await assertEngineUp(deps);

  const ids =
    verb === "pdf.merge"
      ? (input as PdfVerbInput<"pdf.merge">).fileIds
      : [(input as { fileId: string }).fileId];
  const sources = await loadSources(ctx.userId, ids);

  let route: ToPdfRoute | undefined;
  if (verb === "pdf.to_pdf") {
    const src = sources[0]!;
    const found = toPdfRouteFor(src.mimeType);
    if (!found) {
      throw refuse(
        pdfText("pdf.refusal.unsupported_type", {
          file: src.title,
          mime: src.mimeType,
        }),
        "validation",
        PDF_REFUSAL_CODES.unsupportedType
      );
    }
    route = found;
  } else {
    for (const src of sources) assertPdf(src);
  }

  const spec = stirlingCallFor(verb, input, route);
  const result = await callStirling(
    spec,
    sources.map((s) => fileRef(s, route?.extension ?? "pdf")),
    deps
  );

  const title = pdfText(TITLE_KEYS[verb], {
    source: baseName(sources[0]!.title),
    pages:
      verb === "pdf.split" ? (input as PdfVerbInput<"pdf.split">).pages : "",
  });
  const filename = `${safeFileStem(title)}.${extensionOf(result.mimeType)}`;

  const workspaceId =
    ctx.workspaceId ?? (await findUserDefaultWorkspaceId(db, ctx.userId));
  if (!workspaceId) {
    throw refuse(
      pdfText("pdf.refusal.no_space"),
      "validation",
      PDF_REFUSAL_CODES.noSpace
    );
  }
  const agentUserId = getActingAgentUserId() ?? ctx.agentUserId ?? undefined;

  const { createGovernedFileEntityFromBuffer } =
    await import("../../routers/create-governed-file-entity.js");
  const stored = await createGovernedFileEntityFromBuffer({
    buffer: result.bytes,
    mimeType: result.mimeType,
    filename,
    title,
    userId: ctx.userId,
    workspaceId,
    ...(agentUserId ? { agentUserId } : {}),
    scopes: FILE_DOOR_SCOPES,
    sessionId: ctx.sessionId ?? null,
  });

  const sourceFileIds = sources.map((s) => s.id);
  const note =
    verb === "pdf.split" && result.mimeType === "application/zip"
      ? pdfText("pdf.note.split_zip")
      : undefined;
  const base = {
    documentId: stored.documentId,
    title,
    mimeType: result.mimeType,
    size: result.bytes.length,
    sourceFileIds,
    ...(note ? { note } : {}),
  };

  if (stored.status === "proposed") {
    return {
      status: "proposed",
      ...(stored.proposalId ? { proposalId: stored.proposalId } : {}),
      ...(stored.reviewUrl ? { reviewUrl: stored.reviewUrl } : {}),
      ...base,
      link: "pending",
      links: [],
    };
  }

  // One edge per distinct source, new file → source. Each through the governed
  // relations door; an edge that fails is REPORTED (the file already exists and
  // is not undone), never swallowed.
  const links: PdfDerivedLink[] = [];
  for (const sourceFileId of [...new Set(sourceFileIds)]) {
    try {
      const linked = (await caller.create({
        sourceEntityId: stored.fileEntityId,
        targetEntityId: sourceFileId,
        type: DERIVED_FROM,
        workspaceId,
        metadata: { verb },
      })) as { id?: string; status?: string; proposalId?: string };
      if (linked.status === "proposed") {
        links.push({
          sourceFileId,
          state: "proposed",
          ...(linked.proposalId ? { proposalId: linked.proposalId } : {}),
        });
      } else {
        links.push({
          sourceFileId,
          state: "linked",
          ...(linked.id ? { relationId: linked.id } : {}),
        });
      }
    } catch (err) {
      links.push({
        sourceFileId,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const link = links.some((l) => l.state === "failed")
    ? "failed"
    : links.some((l) => l.state === "proposed")
      ? "proposed"
      : "linked";

  return {
    status: "created",
    fileEntityId: stored.fileEntityId,
    ...base,
    link,
    links,
  };
}

/** `pdf.info` — the engine's report on one PDF. Creates nothing. */
export async function runPdfInfo(
  params: Record<string, unknown>,
  ctx: PdfVerbCtx,
  deps: StirlingDeps = {}
): Promise<{ fileId: string; info: unknown }> {
  const input = PDF_VERB_PARAMS["pdf.info"].parse(params);
  await assertEngineUp(deps);
  const [src] = await loadSources(ctx.userId, [input.fileId]);
  assertPdf(src!);
  const result = await callStirling(
    stirlingCallFor("pdf.info", input),
    [fileRef(src!, "pdf")],
    deps
  );
  let info: unknown;
  try {
    info = JSON.parse(result.bytes.toString("utf8"));
  } catch {
    throw refuse(
      pdfText("pdf.refusal.bad_output", {
        expected: pdfText("pdf.expected.json"),
      }),
      "provider",
      PDF_REFUSAL_CODES.badOutput
    );
  }
  return { fileId: src!.id, info };
}

async function assertEngineUp(deps: StirlingDeps): Promise<void> {
  const state = await probePdfEngine(deps);
  if (state === "off") throw engineOffRefusal();
  if (state === "down") throw engineDownRefusal();
}

/** The read floor + the facts the engine call needs, per source, in order. */
async function loadSources(
  userId: string,
  ids: readonly string[]
): Promise<SourceFile[]> {
  const { readableFileEntity } = await import("../../routers/file-upload.js");
  const out: SourceFile[] = [];
  for (const id of ids) {
    const readable = await readableFileEntity(userId, id);
    if (!readable.ok) {
      throw readable.status === 404
        ? refuse(
            pdfText("pdf.refusal.file_not_found", { fileId: id }),
            "target_missing",
            PDF_REFUSAL_CODES.fileNotFound
          )
        : refuse(
            pdfText("pdf.refusal.file_not_readable", { fileId: id }),
            "permission",
            PDF_REFUSAL_CODES.fileNotReadable
          );
    }
    const { entity } = readable;
    if (entity.deletedAt) {
      throw refuse(
        pdfText("pdf.refusal.file_not_found", { fileId: id }),
        "target_missing",
        PDF_REFUSAL_CODES.fileNotFound
      );
    }
    if (!entity.storageKey) {
      throw refuse(
        pdfText("pdf.refusal.file_no_bytes", { fileId: id }),
        "target_missing",
        PDF_REFUSAL_CODES.fileNoBytes
      );
    }
    const title = entity.title?.trim() || pdfText("pdf.untitled_source");
    if (entity.size !== null && entity.size > PDF_INPUT_MAX_BYTES) {
      throw refuse(
        pdfText("pdf.refusal.file_too_large", {
          file: title,
          mb: PDF_INPUT_MAX_BYTES / (1024 * 1024),
        }),
        "validation",
        PDF_REFUSAL_CODES.fileTooLarge
      );
    }
    out.push({
      id,
      title,
      mimeType: (entity.mimeType ?? "application/octet-stream")
        .split(";")[0]!
        .trim()
        .toLowerCase(),
      storageKey: entity.storageKey,
      // Unknown size: the encoder's streamed cap still holds the 100 MB line.
      size: entity.size ?? 0,
    });
  }
  return out;
}

function assertPdf(src: SourceFile): void {
  if (src.mimeType === "application/pdf") return;
  throw refuse(
    pdfText("pdf.refusal.not_a_pdf", { file: src.title, mime: src.mimeType }),
    "validation",
    PDF_REFUSAL_CODES.notAPdf
  );
}

/** The part the engine receives; its NAME carries the extension Stirling reads. */
function fileRef(src: SourceFile, extension: string): ProviderFileRef {
  return {
    storageKey: src.storageKey,
    filename: `${safeFileStem(baseName(src.title))}.${extension}`,
    contentType: src.mimeType,
    size: src.size,
  };
}

const TITLE_KEYS = {
  "pdf.ocr": "pdf.title.ocr",
  "pdf.compress": "pdf.title.compress",
  "pdf.merge": "pdf.title.merge",
  "pdf.split": "pdf.title.split",
  "pdf.redact": "pdf.title.redact",
  "pdf.to_pdf": "pdf.title.to_pdf",
  "pdf.to_markdown": "pdf.title.to_markdown",
} as const satisfies Record<PdfTransformVerb, PdfCopyKey>;

/** A title without a trailing file extension ("Report.pdf" → "Report"). */
function baseName(title: string): string {
  return title.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim() || title;
}

/** A filename stem: no path separators or control characters, bounded. */
function safeFileStem(name: string): string {
  const stem = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return stem || "file";
}

function extensionOf(mimeType: string): string {
  switch (mimeType) {
    case "application/zip":
      return "zip";
    case "text/markdown":
      return "md";
    default:
      return "pdf";
  }
}
