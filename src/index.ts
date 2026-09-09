#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callOperation } from "./client.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { loadAllSpecs } from "./openapi.js";
import { SPEC_SOURCES } from "./specs.js";
import { operationsToTools, type ToolDefinition } from "./tools.js";
import { GRAPHQL_TOOL_NAME, callGraphql, graphqlTool } from "./graphql.js";

import {
  bearerFrom,
  healthHostAllowlist,
  hostAllowed,
  hostAllowlist,
  loadHttpConfig,
  startupRefusal,
  tokenMatches,
  weakTokenWarning,
} from "./http.js";

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

/** Thrown by readBody when the request exceeds the configured limit. */
class BodyTooLarge extends Error {}

/**
 * Reads the request body, refusing anything over `limitBytes`. Without the
 * limit the whole request is buffered in memory: a single 150 MB request drove
 * RSS from 91 MB to 851 MB, and with no token set anyone could send it.
 */
async function readBody(
  req: IncomingMessage,
  limitBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) {
      // Throwing out of `for await` already destroys the request and nulls its
      // socket, so neither req.pause() nor a later req.destroy() does anything.
      // The response socket is still alive, which is all the caller needs to
      // write the 413.
      throw new BodyTooLarge(`Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buf);
  }
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
  const cfg = loadHttpConfig();

  const refusal = startupRefusal(cfg);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (cfg.portFellBack) {
    console.error(
      `${SERVER_NAME}: WARNING - PORT=${process.env.PORT} is not a usable ` +
        `port number, falling back to ${cfg.port}. A platform that injects ` +
        `PORT will probe the value it injected, not this one.`,
    );
  }
  const weak = weakTokenWarning(cfg);
  if (weak) console.error(`${SERVER_NAME}: ${weak}`);
  if (!cfg.authToken && cfg.allowInsecure) {
    console.error(
      `${SERVER_NAME}: WARNING - MCP_ALLOW_INSECURE is set and no ` +
        `MCP_AUTH_TOKEN is configured. Anyone who can reach this port has ` +
        `full access to the ActiveCampaign account data.`,
    );
  }

  const allowlist = hostAllowlist(cfg);
  const healthAllowlist = healthHostAllowlist(cfg);

  type Session = {
    server: Server;
    transport: StreamableHTTPServerTransport;
    lastSeen: number;
    /** Open SSE streams; a session serving one is in use, however quiet. */
    streams: number;
  };
  const sessions = new Map<string, Session>();

  const drop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void Promise.resolve(s.transport.close()).catch(() => {});
  };

  // Sessions were previously only removed on transport close. Worse, a POST
  // carrying an unknown session id built a full Server plus transport before
  // the 400 was returned, so a random UUID per request leaked ~86 KB with no
  // token and no initialize needed.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - cfg.sessionTtlMs;
    for (const [id, s] of sessions) {
      if (s.streams === 0 && s.lastSeen < cutoff) drop(id);
    }
  }, 60_000);
  sweep.unref();

  const evictOldest = () => {
    let victim: string | undefined;
    let oldest = Infinity;
    let victimStreaming = true;
    for (const [id, s] of sessions) {
      const streaming = s.streams > 0;
      if (victimStreaming && !streaming) {
        victim = id;
        oldest = s.lastSeen;
        victimStreaming = false;
        continue;
      }
      if (streaming === victimStreaming && s.lastSeen < oldest) {
        victim = id;
        oldest = s.lastSeen;
      }
    }
    if (victim) drop(victim);
  };

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const rpcError = (code: number, message: string) => ({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    // 1. DNS-rebinding protection, on every route: /health used to answer with
    //    any Host header and hand out the server name and tool count.
    const listForRequest =
      req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))
        ? healthAllowlist
        : allowlist;
    if (listForRequest && !hostAllowed(req.headers.host, listForRequest)) {
      send(res, 403, rpcError(-32000, `Invalid Host: ${req.headers.host ?? "(missing)"}`));
      return;
    }

    // Liveness only. Behind the Host check, in front of the auth gate so a
    // platform health check needs no token.
    // Parse once: req.url carries the query string, and startsWith() turned
    // /mcpXYZ and /mcp-evil into fully working MCP endpoints, which silently
    // defeats any WAF rule, proxy route or rate limit scoped to exactly /mcp.
    const pathname = (() => {
      try {
        return new URL(req.url!, "http://localhost").pathname;
      } catch {
        return req.url!;
      }
    })();
    const isMcpPath = pathname === cfg.path || pathname.startsWith(cfg.path + "/");

    if (req.method === "GET" && pathname === "/health") {
      send(res, 200, { status: "ok", server: SERVER_NAME });
      return;
    }

    if (!isMcpPath) {
      send(res, 404, rpcError(-32601, `Not found. MCP endpoint is ${cfg.path}`));
      return;
    }

    // 2. Shared secret, still before the body is read.
    if (cfg.authToken && !tokenMatches(bearerFrom(req.headers.authorization), cfg.authToken)) {
      send(res, 401, rpcError(-32001, "Unauthorized"));
      return;
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      // 3. Body first, so an initialize can be recognised without allocating.
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readBody(req, cfg.bodyLimitBytes);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            send(res, 413, rpcError(-32600, `Request body exceeds the configured limit of ${cfg.bodyLimitBytes} bytes`));
            return;
          }
          throw err;
        }
      }

      let session: Session | undefined;

      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          // 404, not 400: clients only re-initialize on 404, and nothing is
          // allocated for a session id we do not know.
          send(res, 404, rpcError(-32001, "Session not found"));
          return;
        }
        session.lastSeen = Date.now();
      } else if (req.method === "POST" && isInitializeRequest(body)) {
        if (sessions.size >= cfg.maxSessions) evictOldest();
        const server = buildServer(tools, config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport, lastSeen: Date.now(), streams: 0 });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { server, transport, lastSeen: Date.now(), streams: 0 };
      } else {
        send(res, req.method === "POST" ? 400 : 404, rpcError(-32000, "Bad Request: no valid session ID provided."));
        return;
      }

      // A GET is the SSE stream and stays open; count it so the idle sweep
      // leaves the session alone while it is genuinely in use.
      if (req.method === "GET" && sessionId) {
        const held = session;
        held.streams += 1;
        res.on("close", () => {
          held.streams = Math.max(0, held.streams - 1);
          held.lastSeen = Date.now();
        });
      }

      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Request handling error:", err);
      if (!res.headersSent) {
        send(res, 500, rpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    const hint =
      err.code === "EADDRINUSE"
        ? ` Port ${cfg.port} is already in use.`
        : err.code === "EACCES"
          ? ` No permission to bind port ${cfg.port}.`
          : err.code === "ENOTFOUND" || err.code === "EADDRNOTAVAIL"
            ? ` HOST=${cfg.host} is not an address this machine can bind.`
            : "";
    console.error(
      `Fatal: could not listen on ${cfg.host}:${cfg.port}.${hint} (${err.code ?? err.message})`,
    );
    process.exit(1);
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    console.error(
      `${SERVER_NAME} (http) ready on http://${cfg.host}:${cfg.port}${cfg.path}  -  ${tools.length} tools registered.`,
    );
    if (allowlist) {
      console.error(`${SERVER_NAME}: Host header restricted to ${allowlist.join(", ")}`);
    }
    if (cfg.authToken) console.error("Bearer auth: required (MCP_AUTH_TOKEN set).");
    else console.error("Bearer auth: DISABLED (MCP_AUTH_TOKEN not set).");
  });

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down...`);
    clearInterval(sweep);
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
