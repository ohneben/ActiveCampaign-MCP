import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RateLimiter } from "./rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ActiveCampaign enforces 5 requests / second per account. We default a touch
// under that so bursts of tool calls stay clear of the server-side 429.
const DEFAULT_MAX_REQUESTS = 4;
const DEFAULT_RATE_WINDOW_MS = 1_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
// 0 disables the guard. ~120k chars keeps a single huge list response from
// swamping the model's context while still returning plenty of records.
const DEFAULT_MAX_RESPONSE_CHARS = 0;

export interface ServerConfig {
  /** Scheme + host of the account API, e.g. `https://acme.api-us1.com`. */
  origin: string;
  /** The full base URL as configured (kept for diagnostics/messages). */
  baseUrl: string;
  apiToken: string;
  specDir: string;

  maxRetries: number;
  timeoutMs: number;
  rateLimiter?: RateLimiter;

  // ── Tool-surface controls ───────────────────────────────────────────────
  /** If set, only these resource groups are exposed. */
  includeGroups?: Set<string>;
  /** These resource groups are hidden. */
  excludeGroups?: Set<string>;
  /** Hide every write/destructive tool — expose read-only tools only. */
  readOnly: boolean;
  /** Expose the GraphQL passthrough tool. */
  enableGraphql: boolean;
  /** GraphQL endpoint (Ecommerce GraphQL API). */
  graphqlUrl: string;

  /** Truncate tool responses longer than this many characters (0 = never). */
  maxResponseChars: number;

  fetchImpl?: typeof fetch;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Required: ACTIVECAMPAIGN_API_URL, ACTIVECAMPAIGN_API_TOKEN. See README.md for setup.`,
    );
  }
  return v.trim();
}

/** Read a non-negative integer env var, falling back when unset/invalid. */
function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a comma/space-separated group list into a lowercased Set (or undefined). */
function groupSetEnv(name: string): Set<string> | undefined {
  const v = process.env[name];
  if (!v || v.trim().length === 0) return undefined;
  const items = v
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : undefined;
}

/** Derive `https://host` from a full API URL, tolerating a missing scheme. */
function originFromUrl(url: string): string {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new Error(
      `ACTIVECAMPAIGN_API_URL is not a valid URL: "${url}". ` +
        `Expected something like https://your-account.api-us1.com/api/3 ` +
        `(copy it from ActiveCampaign → Settings → Developer).`,
    );
  }
}

function resolveSpecDir(): string {
  const explicit = process.env.ACTIVECAMPAIGN_SPEC_DIR;
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) throw new Error(`ACTIVECAMPAIGN_SPEC_DIR not found: ${abs}`);
    return abs;
  }
  // Bundled specs: dist/ is a sibling of spec/ at the package root.
  const bundled = resolve(__dirname, "..", "spec");
  if (existsSync(bundled)) return bundled;
  throw new Error(
    `Could not locate the bundled spec/ directory. Set ACTIVECAMPAIGN_SPEC_DIR to point at it.`,
  );
}

export function loadConfig(): ServerConfig {
  const baseUrl = requireEnv("ACTIVECAMPAIGN_API_URL");
  const origin = originFromUrl(baseUrl);
  const maxRequests = intEnv("ACTIVECAMPAIGN_MAX_REQUESTS", DEFAULT_MAX_REQUESTS);
  const windowMs = intEnv("ACTIVECAMPAIGN_RATE_WINDOW_MS", DEFAULT_RATE_WINDOW_MS);

  return {
    origin,
    baseUrl,
    apiToken: requireEnv("ACTIVECAMPAIGN_API_TOKEN"),
    specDir: resolveSpecDir(),
    maxRetries: intEnv("ACTIVECAMPAIGN_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    timeoutMs: intEnv("ACTIVECAMPAIGN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    rateLimiter: maxRequests > 0 ? new RateLimiter(maxRequests, windowMs) : undefined,

    includeGroups: groupSetEnv("ACTIVECAMPAIGN_INCLUDE_GROUPS"),
    excludeGroups: groupSetEnv("ACTIVECAMPAIGN_EXCLUDE_GROUPS"),
    readOnly: boolEnv("ACTIVECAMPAIGN_READ_ONLY", false),
    enableGraphql: boolEnv("ACTIVECAMPAIGN_ENABLE_GRAPHQL", true),
    graphqlUrl:
      process.env.ACTIVECAMPAIGN_GRAPHQL_URL?.trim() || `${origin}/api/3/ecom/graphql`,

    maxResponseChars: intEnv("ACTIVECAMPAIGN_MAX_RESPONSE_CHARS", DEFAULT_MAX_RESPONSE_CHARS),
  };
}
