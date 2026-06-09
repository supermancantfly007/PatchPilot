import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const dataDir = resolve(process.env.PATCHPILOT_DATA_DIR || "data");
await rm(dataDir, { recursive: true, force: true });
console.log(`Removed ${dataDir}`);
