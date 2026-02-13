/**
 * SelectionContext – formal typed payload for {selection} placeholder in Commands.
 * Used when running a command: entities, view rows, documents, or raw text.
 */

export type SelectionContextType =
  | "entities"
  | "viewRows"
  | "documents"
  | "text";

export interface SelectionContextBase {
  type: SelectionContextType;
}

export interface SelectionContextEntities extends SelectionContextBase {
  type: "entities";
  entityIds: string[];
}

export interface SelectionContextViewRows extends SelectionContextBase {
  type: "viewRows";
  viewId: string;
  rowEntityIds: string[];
}

export interface SelectionContextDocuments extends SelectionContextBase {
  type: "documents";
  documentIds: string[];
}

export interface SelectionContextText extends SelectionContextBase {
  type: "text";
  text: string;
}

export type SelectionContext =
  | SelectionContextEntities
  | SelectionContextViewRows
  | SelectionContextDocuments
  | SelectionContextText;
