/**
 * A document a workspace template carries (`definition.documents[]`, plan
 * 9ad4b2fc §5 lane 12) — the ONE zod every install door slots it with:
 * Hub `POST /packages/apply` (`PackageApplySchema`) and the tRPC
 * `createFromDefinition` / `reconcileFromDefinition` / `applyDefinition`
 * inputs. Those objects are plain `z.object`s, so a door without this slot
 * would strip the field in silence.
 *
 * The shape is `WorkspaceDocumentInput` (`@synap-core/types/workspaces/
 * definition`); the installer is `@synap/database` `utils/template-documents.ts`
 * (create and reconcile share it). Cross-references (one document per slug,
 * sidebar items naming a declared slug) are checked by the create door's
 * `collectCrossRefErrors`, before anything is written.
 */
import { z } from "zod";
import type { WorkspaceDocumentInput } from "@synap-core/types/workspaces/definition";

/** A template document slug: kebab-case, stable across template versions. */
export const TEMPLATE_DOCUMENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const templateDocumentSchema = z.object({
  slug: z.string().regex(TEMPLATE_DOCUMENT_SLUG_RE, {
    message: "a document slug is kebab-case (a-z, 0-9, -)",
  }),
  title: z.string().trim().min(1),
  content: z.string(),
  scope: z.enum(["space", "pod"]).optional(),
});

export const templateDocumentsSchema = z
  .array(templateDocumentSchema)
  .optional();

// The zod and the wire type agree, both ways.
type Parsed = z.infer<typeof templateDocumentSchema>;
const _toWire: WorkspaceDocumentInput = {} as Parsed;
const _fromWire: Parsed = {} as WorkspaceDocumentInput;
void _toWire;
void _fromWire;
