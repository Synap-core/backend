/**
 * Registers every Google sync kind (side-effect imports). Imported by the runner
 * so any process that can run a connection sync can see all of them.
 */
import "./run-gcal-import.js";
import "./gmail-thread-sync.js";
import "./google-contact-sync.js";
