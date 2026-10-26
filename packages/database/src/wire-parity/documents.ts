/**
 * Compile-time contract: the document rows `@synap-core/types/documents`
 * declares are EXACTLY the rows inferred from this package's tables
 * (`schema/documents.ts`). No runtime code. A column added, retyped or made
 * nullable on one side only fails `tsc` here.
 */
import type * as Wire from "@synap-core/types/documents";
import type {
  Document,
  NewDocumentVersion,
  DocumentSession,
  NewDocumentSession,
} from "../schema/documents.js";
import type { Equal } from "./equal.js";

export const _document: Equal<Document, Wire.Document> = true;
export const _newDocumentVersion: Equal<
  NewDocumentVersion,
  Wire.NewDocumentVersion
> = true;
export const _documentSession: Equal<DocumentSession, Wire.DocumentSession> =
  true;
export const _newDocumentSession: Equal<
  NewDocumentSession,
  Wire.NewDocumentSession
> = true;
