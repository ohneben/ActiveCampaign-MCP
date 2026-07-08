import type { ServerConfig } from "./config.js";
import type { Operation } from "./openapi.js";

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  body: unknown;
  rawBody: string;
  /** Number of retries performed before this response was returned. */
  attempts: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter, capped, so retries don't thunder. */
function backoffDelay(attempt: number, base = 500, cap = 8000): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** The input-schema key a parameter's value arrives under (see ParameterSpec.argName). */
const argKey = (p: { name: string; argName?: string }): string => p.argName ?? p.name;

function expandPath(op: Operation, args: Record<string, unknown>, consumed: Set<string>): string {
  const pathParams = new Map(op.parameters.filter((p) => p.in === "path").map((p) => [p.name, p]));
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const key = pathParams.has(name) ? argKey(pathParams.get(name)!) : name;
    if (!(key in args)) throw new Error(`Missing required path parameter "${key}".`);
    consumed.add(key);
    const v = args[key];
    if (v === null || v === undefined) throw new Error(`Path parameter "${key}" cannot be null/undefined.`);
    return encodeURIComponent(String(v));
  });
}

function buildQueryString(op: Operation, args: Record<string, unknown>, consumed: Set<string>): string {
  const usp = new URLSearchParams();
  for (const p of op.parameters) {
    if (p.in !== "query") continue;
    const key = argKey(p);
    if (consumed.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    consumed.add(key);
    if (Array.isArray(value)) {
      const explode = p.explode !== false;
      if (explode) for (const v of value) usp.append(p.name, String(v));
      else usp.append(p.name, value.map((v) => String(v)).join(","));
    } else if (typeof value === "object") {
      // ActiveCampaign uses bracketed params like orders[email]=ASC. When the
      // model passes a nested object we expand it to that bracket notation.
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        usp.append(`${p.name}[${k}]`, String(v));
      }
    } else {
      usp.append(p.name, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function collectExtraHeaders(op: Operation, args: Record<string, unknown>, consumed: Set<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const p of op.parameters) {
    if (p.in !== "header") continue;
    const key = argKey(p);
    if (consumed.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    consumed.add(key);
    headers[p.name] = String(value);
  }
  return headers;
}

async function fetchWithResilience(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  cfg: ServerConfig,
): Promise<{ response: Response; attempts: number }> {
  const maxRetries = cfg.maxRetries;
  const timeoutMs = cfg.timeoutMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (cfg.rateLimiter) await cfg.rateLimiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoffDelay(attempt);
        await response.text().catch(() => undefined); // drain so the socket is reusable
        await sleep(wait);
        continue;
      }

      return { response, attempts: attempt };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort ? new Error(`Request timed out after ${timeoutMs}ms.`) : err;
      if (attempt < maxRetries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("Request failed after exhausting retries.");
}

/**
 * Build the auth headers for an operation. Every request carries the account
 * `Api-Token`; if the operation's source definition declares a different auth
 * header (WhatsApp uses `Token: Token <value>`), we send that one too, so the
 * request authenticates whichever header the endpoint actually reads.
 */
function authHeaders(cfg: ServerConfig, op: Operation): Record<string, string> {
  const headers: Record<string, string> = { "Api-Token": cfg.apiToken };
  const { authHeader, authPrefix } = op.source;
  if (authHeader && authHeader.toLowerCase() !== "api-token") {
    headers[authHeader] = `${authPrefix}${cfg.apiToken}`;
  }
  return headers;
}

/** Resolve the full request URL for an operation: origin + serverPath + path. */
export function buildUrl(cfg: ServerConfig, op: Operation, expandedPath: string, query: string): string {
  return `${cfg.origin}${op.serverPath}${expandedPath}${query}`;
}

export async function callOperation(cfg: ServerConfig, op: Operation, rawArgs: unknown): Promise<CallResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const consumed = new Set<string>();
  const expandedPath = expandPath(op, args, consumed);
  const query = buildQueryString(op, args, consumed);
  const extraOpHeaders = collectExtraHeaders(op, args, consumed);

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders(cfg, op),
    ...extraOpHeaders,
  };

  let body: string | undefined;
  if (op.requestBodySchema && args.body !== undefined) {
    headers["Content-Type"] = op.requestBodyContentType ?? "application/json";
    body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  const url = buildUrl(cfg, op, expandedPath, query);

  const { response, attempts } = await fetchWithResilience(
    fetchImpl,
    url,
    { method: op.method.toUpperCase(), headers, body },
    cfg,
  );

  const rawBody = await response.text();
  const contentType = response.headers.get("content-type");
  let parsedBody: unknown = rawBody;
  if (contentType && contentType.includes("application/json") && rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  return { status: response.status, ok: response.ok, contentType, body: parsedBody, rawBody, attempts };
}

// Exposed for unit tests.
export const __test = { parseRetryAfter, backoffDelay, buildQueryString, expandPath, authHeaders, RETRYABLE_STATUS };
