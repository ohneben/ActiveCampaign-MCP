import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../src/openapi.js";
import { SPEC_SOURCES } from "../src/specs.js";
import { operationsToTools } from "../src/tools.js";
import { graphqlTool } from "../src/graphql.js";
import type { ServerConfig } from "../src/config.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const operations = loadAllSpecs(specDir, SPEC_SOURCES, resolve);
const tools = operationsToTools(operations);

// The full default tool set as src/index.ts assembles it: every REST tool plus
// the always-on GraphQL passthrough. graphqlTool only reads cfg.graphqlUrl.
const defaultTools = [
  ...tools,
  graphqlTool({ graphqlUrl: "https://acme.api-us1.com/api/3/ecom/graphql" } as ServerConfig),
];

describe("operationsToTools", () => {
  it("produces exactly one tool per operation (no filter)", () => {
    expect(tools.length).toBe(operations.length);
  });

  it("gives every tool a unique, MCP-legal name", () => {
    const names = new Set<string>();
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
  });

  it("prefixes every description with a 🟢 / 🟡 / 🔴 banner", () => {
    for (const t of tools) {
      expect(t.description).toMatch(/^(🟢|🟡|🔴)/);
    }
  });

  it("builds a closed object input schema for every tool", () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("only exposes Anthropic-legal property keys — one bad key would break the whole client", () => {
    // Regression: ActiveCampaign's spec uses PHP-style bracket query params like
    // `filters[email]`, `orders[cdate]`, `dealIds[]`, plus oddities `<operator>`,
    // `exclude=email`, `[]ids` and `Fitlers[due_before]`. Copied verbatim into
    // input_schema.properties they make Claude's API 400 the ENTIRE tool list with
    // "Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'". Assert the FULL
    // default tool set (REST + GraphQL) only ever exposes sanitized keys and names.
    const LEGAL_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
    const LEGAL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const t of defaultTools) {
      expect(t.name, `illegal tool name ${JSON.stringify(t.name)}`).toMatch(LEGAL_NAME);
      for (const key of Object.keys((t.inputSchema.properties as Record<string, unknown>) ?? {})) {
        expect(key, `${t.name} exposes illegal property key ${JSON.stringify(key)}`).toMatch(LEGAL_KEY);
      }
      const required = (t.inputSchema.required as string[] | undefined) ?? [];
      for (const key of required) expect(key, `${t.name} requires unknown key ${key}`).toMatch(LEGAL_KEY);
    }
  });

  it("renames bracket query params to sanitized keys and notes the raw name", () => {
    // e.g. a list endpoint exposing `filters[email]` must surface it as
    // `filters_email` with a "Sent to ActiveCampaign as ..." breadcrumb.
    const withBracketParam = tools.find((t) =>
      t.operation?.parameters.some((p) => p.name.includes("[") && p.in === "query"),
    );
    expect(withBracketParam).toBeDefined();
    const props = withBracketParam!.inputSchema.properties as Record<string, { description?: string }>;
    for (const p of withBracketParam!.operation!.parameters) {
      if (!p.name.includes("[")) continue;
      expect(Object.prototype.hasOwnProperty.call(props, p.name)).toBe(false);
      expect(p.argName).toBeDefined();
      expect(props[p.argName!]).toBeDefined();
      expect(props[p.argName!].description).toContain(`Sent to ActiveCampaign as "${p.name}"`);
    }
  });

  it("sets readOnlyHint on GETs and destructiveHint on DELETEs", () => {
    for (const t of tools) {
      if (!t.operation) continue;
      if (t.operation.method === "get") {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(t.annotations.destructiveHint).toBe(false);
      }
      // A plain DELETE is destructive; a curated "unlink" DELETE is not.
      if (t.operation.method === "delete" && t.category === "delete") {
        expect(t.annotations.destructiveHint).toBe(true);
      }
    }
  });

  describe("read-only filter", () => {
    const readTools = operationsToTools(operations, { readOnly: true });
    it("keeps only read-only tools", () => {
      expect(readTools.length).toBeGreaterThan(0);
      expect(readTools.length).toBeLessThan(tools.length);
      for (const t of readTools) {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(t.annotations.destructiveHint).toBe(false);
      }
    });
  });

  describe("group filters", () => {
    it("include-list keeps only the named groups", () => {
      const only = operationsToTools(operations, { includeGroups: new Set(["contacts", "deals"]) });
      expect(only.length).toBeGreaterThan(0);
      for (const t of only) expect(["contacts", "deals"]).toContain(t.group);
    });

    it("exclude-list drops the named groups", () => {
      const without = operationsToTools(operations, { excludeGroups: new Set(["ecomorders"]) });
      expect(without.some((t) => t.group === "ecomOrders")).toBe(false);
      expect(without.length).toBeLessThan(tools.length);
    });
  });
});
