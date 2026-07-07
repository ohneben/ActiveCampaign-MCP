import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs, type Operation } from "../src/openapi.js";
import { SPEC_SOURCES } from "../src/specs.js";
import { callOperation, buildUrl, __test } from "../src/client.js";
import type { ServerConfig } from "../src/config.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const operations = loadAllSpecs(specDir, SPEC_SOURCES, resolve);
const byId = (id: string): Operation => {
  const op = operations.find((o) => o.operationId === id);
  if (!op) throw new Error(`missing op ${id}`);
  return op;
};

function cfg(fetchImpl?: typeof fetch): ServerConfig {
  return {
    origin: "https://acme.api-us1.com",
    baseUrl: "https://acme.api-us1.com/api/3",
    apiToken: "tok123",
    specDir,
    maxRetries: 2,
    timeoutMs: 5000,
    readOnly: false,
    enableGraphql: true,
    graphqlUrl: "https://acme.api-us1.com/api/3/ecom/graphql",
    maxResponseChars: 0,
    fetchImpl,
  } as ServerConfig;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("buildUrl", () => {
  it("mounts core v3 operations under /api/3", () => {
    const op = byId("list-all-contacts");
    expect(buildUrl(cfg(), op, "/contacts", "")).toBe("https://acme.api-us1.com/api/3/contacts");
  });

  it("respects the host-root server for segment-match endpoints", () => {
    const op = byId("create_match_all_request"); // serverPath "", path already has /api/3
    expect(buildUrl(cfg(), op, op.path, "")).toBe("https://acme.api-us1.com/api/3/segmentMatchAll");
  });
});

describe("auth headers", () => {
  it("always sends Api-Token", () => {
    const h = __test.authHeaders(cfg(), byId("list-all-contacts"));
    expect(h["Api-Token"]).toBe("tok123");
    expect(h["Token"]).toBeUndefined();
  });

  it("also sends the WhatsApp Token header with its prefix", () => {
    const h = __test.authHeaders(cfg(), byId("Send a WhatsApp Template Message"));
    expect(h["Api-Token"]).toBe("tok123");
    expect(h["Token"]).toBe("Token tok123");
  });
});

describe("query building", () => {
  const op = byId("list-all-contacts");
  it("expands nested objects into bracket notation (orders[email]=ASC)", () => {
    const q = __test.buildQueryString(op, { orders: { email: "ASC" } }, new Set());
    expect(q).toBe("?orders%5Bemail%5D=ASC");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(__test.parseRetryAfter("2")).toBe(2000);
  });
  it("returns undefined for a missing header", () => {
    expect(__test.parseRetryAfter(null)).toBeUndefined();
  });
});

describe("callOperation", () => {
  it("injects auth, builds the URL, and parses JSON", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse(200, { contacts: [] });
    }) as unknown as typeof fetch;

    const res = await callOperation(cfg(fetchImpl), byId("list-all-contacts"), { limit: 5 });
    expect(seenUrl).toBe("https://acme.api-us1.com/api/3/contacts?limit=5");
    expect(seenHeaders["Api-Token"]).toBe("tok123");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [] });
  });

  it("retries on 429 (honoring Retry-After) then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: "rate" }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    const res = await callOperation(cfg(fetchImpl), byId("list-all-contacts"), {});
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
  });

  it("throws a clear error when a required path parameter is missing", async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as unknown as typeof fetch;
    // get-a-contact needs {id}
    const withId = operations.find((o) => o.path.includes("/contacts/{id}") && o.method === "get");
    expect(withId).toBeDefined();
    await expect(callOperation(cfg(fetchImpl), withId!, {})).rejects.toThrow(/path parameter/i);
  });
});
