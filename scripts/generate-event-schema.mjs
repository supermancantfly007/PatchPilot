import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunEventSchemaDocument } from "../packages/contracts/src/index.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outputPath = resolve(repoRoot, "packages/contracts/events/run-events.schema.json");
const nextContent = `${JSON.stringify(buildRunEventSchemaDocument(), null, 2)}\n`;
const check = process.argv.includes("--check");

if (check) {
  const current = await readFile(outputPath, "utf8");
  if (current !== nextContent) {
    throw new Error(`${outputPath} is out of date. Run: pnpm events:generate`);
  }
  console.log("Run event schema is up to date");
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, nextContent, "utf8");
  console.log(`Wrote ${outputPath}`);
}
