/**
 * Service Key Crypto — re-exported from @synap/database
 *
 * The canonical implementation lives in packages/database so that packages/jobs
 * can also import it without a circular dependency.
 */
export {
  encryptServiceKey,
  decryptServiceKey,
  resolveServiceKey,
  isEncryptedServiceKey,
} from "@synap/database";
