/**
 * Collection Schemas Export
 */

export { entitiesCollectionSchema } from "./entities.js";
export { documentsCollectionSchema } from "./documents.js";
export { viewsCollectionSchema } from "./views.js";
export { projectsCollectionSchema } from "./projects.js";
export { channelsCollectionSchema } from "./channels.js";
export { agentsCollectionSchema } from "./agents.js";

export const ALL_COLLECTIONS = [
  "entities",
  "documents",
  "views",
  "projects",
  "channels",
  "agents",
] as const;

export type CollectionName = (typeof ALL_COLLECTIONS)[number];
