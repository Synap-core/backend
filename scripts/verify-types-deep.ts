import fs from "fs";
import path from "path";

// Define paths
const coreTypesDist =
  "/Users/antoine/Documents/Code/synap/synap-backend/packages/types/dist/index.d.ts";
const proposalsDist =
  "/Users/antoine/Documents/Code/synap/synap-backend/packages/types/dist/proposals/index.d.ts";

// Function to check file content
function checkContent(filePath: string, stringsToCheck: string[]) {
  console.log(`Checking ${filePath}...`);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  stringsToCheck.forEach((str) => {
    if (content.includes(str)) {
      console.log(`✅ Found export: ${str}`);
    } else {
      console.error(`❌ Missing export: ${str}`);
    }
  });
}

console.log("--- Deep Type Verification ---");
// Check root index re-exports
checkContent(coreTypesDist, [
  "export * from './proposals/index.js'",
  "UpdateRequest",
  "Proposal",
]);

// Check proposals module specifically
checkContent(proposalsDist, [
  "interface UpdateRequest",
  // Proposal is re-exported from db, so it might be 'export { Proposal } ...'
  "Proposal",
]);
