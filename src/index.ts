#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callOperation } from "./client.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { loadAllSpecs } from "./openapi.js";
import { SPEC_SOURCES } from "./specs.js";
import { operationsToTools, type ToolDefinition } from "./tools.js";
import { GRAPHQL_TOOL_NAME, callGraphql, graphqlTool } from "./graphql.js";

const SERVER_NAME = "activecampaign-mcp";
const SERVER_VERSION = "1.0.0";

/** Build the full, filtered tool set (REST tools + optional GraphQL tool). */
function buildTools(config: ServerConfig): ToolDefinition[] {
  const operations = loadAllSpecs(config.specDir, SPEC_SOURCES, resolve);
  const tools = operationsToTools(operations, {
    includeGroups: config.includeGroups,
    excludeGroups: config.excludeGroups,
    readOnly: config.readOnly,
  });
  // GraphQL is a write-style tool, so it is suppressed in read-only mode.
  if (config.enableGraphql && !config.readOnly) tools.push(graphqlTool(config));
  return tools;
}

/** Stringify a response body and, if configured, truncate very large payloads. */
function formatBody(config: ServerConfig, summary: string, body: unknown, rawBody?: string): string {
  let formatted = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (formatted === undefined) formatted = rawBody ?? "";
  const max = config.maxResponseChars;
  if (max > 0 && formatted.length > max) {
    const shown = formatted.slice(0, max);
    formatted =
      `${shown}\n\n…[truncated ${formatted.length - max} of ${formatted.length} characters. ` +
      `Narrow the result with limit/offset, filters[...] or orders[...], or raise ACTIVECAMPAIGN_MAX_RESPONSE_CHARS.]`;
  }
  return `${summary}\n${formatted}`;
}

function buildServer(tools: ToolDefinition[], config: ServerConfig): Server {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === GRAPHQL_TOOL_NAME) {
      try {
        const result = await callGraphql(config, args ?? {});
        const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
        return { isError: !result.ok, content: [{ type: "text", text: formatBody(config, summary, result.body) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `GraphQL call failed: ${message}` }] };
      }
    }

    const tool = toolMap.get(name);
    if (!tool || !tool.operation) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
    try {
      const result = await callOperation(config, tool.operation, args ?? {});
      const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
      return { isError: !result.ok, content: [{ type: "text", text: formatBody(config, summary, result.body, result.rawBody) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Tool execution failed: ${message}` }] };
    }
  });

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runStdio(tools: ToolDefinition[], config: ServerConfig) {
  const server = buildServer(tools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} (stdio) ready: ${tools.length} tools registered.`);
}

async function runHttp(tools: ToolDefinition[], config: ServerConfig) {
  const port = parseInt(process.env.PORT ?? "8765", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const sharedToken = process.env.MCP_SHARED_TOKEN?.trim();

  type Session = { server: Server; transport: StreamableHTTPServerTransport };
  const sessions = new Map<string, Session>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, tools: tools.length }));
      return;
    }

    if (!req.url.startsWith(path)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found. MCP endpoint is ${path}`);
      return;
    }

    if (sharedToken) {
      const auth = req.headers["authorization"];
      const provided = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";
      if (provided !== sharedToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
      let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        const server = buildServer(tools, config);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { server, transport };
      }

      const body = req.method === "POST" ? await readBody(req) : undefined;
      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Request handling error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`${SERVER_NAME} (http) ready on http://${host}:${port}${path}  —  ${tools.length} tools registered.`);
    console.error(sharedToken ? "Bearer auth: required (MCP_SHARED_TOKEN set)." : "Bearer auth: DISABLED (MCP_SHARED_TOKEN not set).");
  });

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down…`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const config = loadConfig();
  const tools = buildTools(config);

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    await runHttp(tools, config);
  } else if (transport === "stdio") {
    await runStdio(tools, config);
  } else {
    throw new Error(`Unknown MCP_TRANSPORT: ${transport}. Use "stdio" or "http".`);
  }
}

main().catch((err) => {
  console.error(`Fatal error starting ${SERVER_NAME}:`, err);
  process.exit(1);
});
