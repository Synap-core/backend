/**
 * @synap/search Package
 * Typesense search integration
 */

// Client
export {
  getTypesenseClient,
  getTypesenseAdminClient,
  testConnection,
} from "./client.js";

// Collections
export * from "./collections/index.js";

// Indexers
export * from "./indexers/index.js";

// Services
export * from "./services/index.js";

// Types
export * from "./types/index.js";
