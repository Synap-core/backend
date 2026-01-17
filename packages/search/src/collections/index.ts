/**
 * Collection Schemas Export
 */

export { entitiesCollectionSchema } from "./entities.js";
export { documentsCollectionSchema } from "./documents.js";
export { viewsCollectionSchema } from "./views.js";
export { projectsCollectionSchema } from "./projects.js";
export { chatThreadsCollectionSchema } from "./chat-threads.js";
export { agentsCollectionSchema } from "./agents.js";

export const ALL_COLLECTIONS = [
  "entities",
  "documents",
  "views",
  "projects",
  "chat_threads",
  "agents",
] as const;

export type CollectionName = (typeof ALL_COLLECTIONS)[number];
