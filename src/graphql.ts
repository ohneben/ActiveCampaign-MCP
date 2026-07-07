import type { ServerConfig } from "./config.js";
import type { ToolDefinition } from "./tools.js";

/**
 * A single passthrough tool for ActiveCampaign's **Ecommerce GraphQL API**
 * (`POST /api/3/ecom/graphql`), which sits alongside the REST API and is handy
 * for shaping exactly the fields you want in one round-trip. It authenticates
 * with the same `Api-Token` as REST.
 *
 * The REST tools are 1:1 with documented endpoints; this one is deliberately
 * open-ended, so it is flagged as a write (a GraphQL document may contain
 * mutations) and left for power users.
 */
export const GRAPHQL_TOOL_NAME = "activecampaign_graphql_query";

export function graphqlTool(cfg: ServerConfig): ToolDefinition {
  const description = [
    "🟡 WRITE · GraphQL · POST /api/3/ecom/graphql",
    "Run an arbitrary query against ActiveCampaign's Ecommerce GraphQL API and return the JSON result.",
    "A GraphQL document may contain mutations, so treat this as a write. " +
      "Endpoint: " +
      cfg.graphqlUrl +
      ". Prefer the dedicated REST tools for standard CRUD; use this for precise field selection or ecommerce data.",
  ].join("\n\n");

  return {
    name: GRAPHQL_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query or mutation document." },
        variables: {
          type: "object",
          description: "Optional variables object referenced by the query.",
          additionalProperties: true,
        },
        operationName: {
          type: "string",
          description: "Optional operation name when the document defines several.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      title: "Run an ActiveCampaign GraphQL query",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    operation: null,
  };
}

export async function callGraphql(cfg: ServerConfig, rawArgs: unknown): Promise<{ status: number; ok: boolean; body: unknown }> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error('The "query" argument is required and must be a non-empty GraphQL string.');
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const payload: Record<string, unknown> = { query };
  if (args.variables !== undefined) payload.variables = args.variables;
  if (typeof args.operationName === "string") payload.operationName = args.operationName;

  if (cfg.rateLimiter) await cfg.rateLimiter.acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(cfg.graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Api-Token": cfg.apiToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}
