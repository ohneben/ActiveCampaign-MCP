import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../src/openapi.js";
import { SPEC_SOURCES } from "../src/specs.js";
import { operationsToTools } from "../src/tools.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const operations = loadAllSpecs(specDir, SPEC_SOURCES, resolve);
const tools = operationsToTools(operations);

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
