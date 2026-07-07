import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../openapi.js";
import { SPEC_SOURCES } from "../specs.js";
import { operationsToTools, prettyGroup } from "../tools.js";
import { CATEGORIES, safetyBucket, type CategoryId } from "../categories.js";
import { graphqlTool } from "../graphql.js";
import type { ServerConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findSpecDir(): string {
  if (process.env.ACTIVECAMPAIGN_SPEC_DIR) return resolve(process.env.ACTIVECAMPAIGN_SPEC_DIR);
  const bundled = resolve(__dirname, "..", "..", "spec");
  if (!existsSync(bundled)) throw new Error(`Spec directory not found at ${bundled}`);
  return bundled;
}

const operations = loadAllSpecs(findSpecDir(), SPEC_SOURCES, resolve);
const tools = operationsToTools(operations);
// Include the GraphQL tool in the catalog so the count matches the running server.
tools.push(graphqlTool({ graphqlUrl: "https://<account>.api-us1.com/api/3/ecom/graphql" } as ServerConfig));

const bucketCounts = { read: 0, write: 0, destructive: 0 };
const catCounts = new Map<CategoryId, number>();
const byGroup = new Map<string, { read: number; write: number; destructive: number }>();

for (const t of tools) {
  const cat = (t.category ?? "create") as CategoryId;
  const bucket = t.operation ? safetyBucket(cat) : "write"; // GraphQL → write
  bucketCounts[bucket]++;
  catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  const group = t.group ?? "graphql";
  const row = byGroup.get(group) ?? { read: 0, write: 0, destructive: 0 };
  row[bucket]++;
  byGroup.set(group, row);
}

console.log(`ActiveCampaign MCP — ${operations.length} operations across ${SPEC_SOURCES.length} specs → ${tools.length} tools.\n`);
console.log(`🟢 Read-only:    ${bucketCounts.read}`);
console.log(`🟡 Write:        ${bucketCounts.write}`);
console.log(`🔴 Destructive:  ${bucketCounts.destructive}`);

console.log("\nBy category:");
for (const [id, meta] of Object.entries(CATEGORIES)) {
  const c = catCounts.get(id as CategoryId) ?? 0;
  if (c > 0) console.log(`  ${meta.banner.padEnd(34)} ${String(c).padStart(4)}`);
}

console.log("\nBy resource group (🟢 read / 🟡 write / 🔴 destructive):");
for (const [group, row] of [...byGroup.entries()].sort()) {
  console.log(
    `  ${prettyGroup(group).padEnd(30)} ${String(row.read).padStart(4)}  ${String(row.write).padStart(4)}  ${String(row.destructive).padStart(4)}   (${group})`,
  );
}

// Sanity: names must be unique and MCP-legal.
const seen = new Set<string>();
const dups: string[] = [];
for (const t of tools) {
  if (!/^[a-z0-9_]+$/.test(t.name) || t.name.length > 64) console.warn(`⚠️  Illegal tool name: ${t.name}`);
  if (seen.has(t.name)) dups.push(t.name);
  seen.add(t.name);
}
console.log(dups.length ? `\n⚠️  Duplicate names: ${dups.join(", ")}` : "\nAll tool names unique ✓");
