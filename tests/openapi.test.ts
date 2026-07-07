import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs, groupForPath, type Operation } from "../src/openapi.js";
import { SPEC_SOURCES } from "../src/specs.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const operations = loadAllSpecs(specDir, SPEC_SOURCES, resolve);
const byId = (id: string): Operation | undefined => operations.find((o) => o.operationId === id);

describe("loadAllSpecs", () => {
  it("loads the full merged account API surface", () => {
    // v3 (276) + sms (17) + whatsapp (13) + segments crud/one/all-some (8+2+8) = 324
    expect(operations.length).toBe(324);
  });

  it("gives every operation an operationId, method and path", () => {
    for (const op of operations) {
      expect(op.operationId.length).toBeGreaterThan(0);
      expect(op.method).toMatch(/^(get|post|put|delete|patch)$/);
      expect(op.path.startsWith("/")).toBe(true);
    }
  });

  it("carries the source auth scheme for each operation", () => {
    expect(byId("list-all-contacts")?.source.authHeader).toBe("Api-Token");
    // WhatsApp endpoints declare a `Token` header.
    expect(byId("Send a WhatsApp Template Message")?.source.authHeader).toBe("Token");
    expect(byId("Send a WhatsApp Template Message")?.source.authPrefix).toBe("Token ");
  });

  it("extracts the server path prefix per definition", () => {
    // Core v3 endpoints are mounted under /api/3…
    expect(byId("list-all-contacts")?.serverPath).toBe("/api/3");
    // …while the segment-match endpoints sit at the host root and carry /api/3 in the path.
    const segAll = byId("create_match_all_request");
    expect(segAll?.serverPath).toBe("");
    expect(segAll?.path.startsWith("/api/3/")).toBe(true);
  });

  it("dereferences $ref-based request bodies (SMS/WhatsApp/Segments specs)", () => {
    const create = byId("createBroadcast");
    expect(create?.requestBodySchema).toBeDefined();
    // The dereferenced schema must not still be a bare $ref.
    expect(JSON.stringify(create?.requestBodySchema)).not.toContain('"$ref"');
  });

  it("never leaks auth/content headers as tool parameters", () => {
    for (const op of operations) {
      for (const p of op.parameters) {
        if (p.in === "header") {
          expect(["api-token", "token", "authorization", "content-type", "accept"]).not.toContain(
            p.name.toLowerCase(),
          );
        }
      }
    }
  });

  it("normalises resource groups from the path", () => {
    expect(groupForPath("/contacts")).toBe("contacts");
    expect(groupForPath("/contact/sync")).toBe("contacts"); // singular alias
    expect(groupForPath("/api/3/segmentMatchAll")).toBe("segments");
    expect(groupForPath("/channel/whatsapp/channels/whatsapp/template")).toBe("whatsapp");
    expect(groupForPath("/ecomOrders/{id}")).toBe("ecomOrders");
  });
});
