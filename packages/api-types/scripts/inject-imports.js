import fs from "fs";
import path from "path";

const filePath = path.join(process.cwd(), "dist/index.d.ts");
const content = fs.readFileSync(filePath, "utf8");

const imports = [
  "import * as _trpc_server from '@trpc/server';",
  "import { z } from 'zod';",
  "import * as _synap_core_types from '@synap-core/types';",
  "",
].join("\n");

fs.writeFileSync(filePath, imports + content);
console.log("Successfully injected missing imports into dist/index.d.ts");
