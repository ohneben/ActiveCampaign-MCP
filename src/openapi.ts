import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SpecSource } from "./specs.js";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ParameterSpec {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: JsonSchema;
  explode?: boolean;
}

export interface Operation {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  /** Normalised resource group derived from the path (e.g. `contacts`, `deals`). */
  group: string;
  parameters: ParameterSpec[];
  requestBodySchema?: JsonSchema;
  requestBodyRequired: boolean;
  requestBodyContentType?: string;
  /** Which bundled definition this operation came from (carries auth scheme). */
  source: SpecSource;
  /**
   * The path prefix from the definition's `servers[].url` (e.g. `/api/3`, or an
   * empty string when the operation's own path already includes `/api/3`).
   */
  serverPath: string;
}

export type JsonSchema = Record<string, unknown> | null | undefined;

interface OpenApiDoc {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, PathItem>;
  components?: {
    parameters?: Record<string, ParameterSpec>;
    schemas?: Record<string, JsonSchema>;
    requestBodies?: Record<string, RequestBodyObject>;
    responses?: Record<string, unknown>;
  };
}

interface PathItem {
  parameters?: Array<ParameterSpec | RefObject>;
  [method: string]: unknown;
}

interface RefObject {
  $ref: string;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<ParameterSpec | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
}

interface RequestBodyObject {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

function isRef(value: unknown): value is RefObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as RefObject).$ref === "string"
  );
}

function resolveRef<T>(doc: OpenApiDoc, ref: string): T | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/");
  let cursor: unknown = doc;
  for (const seg of segments) {
    // JSON Pointer escaping: ~1 => "/", ~0 => "~"
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cursor && typeof cursor === "object" && key in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cursor as T;
}

/**
 * Inline every `$ref` in a schema, guarding against infinite recursion so a
 * self-referential schema resolves to a short note instead of blowing the stack.
 */
function dereferenceSchema(
  doc: OpenApiDoc,
  schema: JsonSchema,
  seen: Set<string> = new Set(),
): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;
  if (isRef(schema)) {
    const ref = (schema as unknown as RefObject).$ref;
    if (seen.has(ref)) return { description: `Recursive reference to ${ref}` };
    const resolved = resolveRef<JsonSchema>(doc, ref);
    if (!resolved) return { description: `Unresolved $ref: ${ref}` };
    return dereferenceSchema(doc, resolved, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" ? dereferenceSchema(doc, item as JsonSchema, seen) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = dereferenceSchema(doc, v as JsonSchema, seen);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function resolveParameter(doc: OpenApiDoc, p: ParameterSpec | RefObject): ParameterSpec | undefined {
  if (isRef(p)) {
    const resolved = resolveRef<ParameterSpec>(doc, p.$ref);
    return resolved ? { ...resolved, required: resolved.required ?? resolved.in === "path" } : undefined;
  }
  return { ...p, required: p.required ?? p.in === "path" };
}

function resolveRequestBody(
  doc: OpenApiDoc,
  body: RequestBodyObject | RefObject,
): RequestBodyObject | undefined {
  if (isRef(body)) return resolveRef<RequestBodyObject>(doc, body.$ref);
  return body;
}

/** Auth/content headers we inject ourselves — never expose them as tool inputs. */
const HEADERS_TO_SKIP = new Set(["authorization", "api-token", "token", "content-type", "accept"]);

/** Extract the path portion of the first server URL (e.g. `/api/3`, or ``). */
function serverPathFromDoc(doc: OpenApiDoc): string {
  const url = doc.servers?.[0]?.url ?? "";
  const noScheme = url.replace(/^https?:\/\//i, "");
  const slash = noScheme.indexOf("/");
  if (slash === -1) return "";
  return noScheme.slice(slash).replace(/\/+$/, "");
}

/**
 * Normalise a raw path prefix into a stable resource-group key. ActiveCampaign's
 * spec is untagged and has a handful of singular/typo variants; we canonicalise
 * them so grouping, filtering and the coverage table stay tidy.
 */
const GROUP_ALIASES: Record<string, string> = {
  contact: "contacts",
  campaign: "campaigns",
  webhook: "webhooks",
  dealGroup: "dealGroups",
  taskOutccomes: "taskOutcomes", // fix an upstream spelling in AC's own spec
  fieldOption: "fieldValues",
  // Segments live across a few path roots — fold them into one group.
  segmentsV2: "segments",
  segmentMatch: "segments",
  segmentMatchAll: "segments",
  segmentMatchSome: "segments",
  audiences: "segments",
  // WhatsApp channel endpoints all start `/channel/whatsapp/...`.
  channel: "whatsapp",
};

export function groupForPath(path: string): string {
  const stripped = path.replace(/^\/api\/3(?=\/)/, "");
  const segs = stripped.split("/").filter((s) => s && !s.startsWith("{"));
  const first = segs[0] ?? "root";
  return GROUP_ALIASES[first] ?? first;
}

/**
 * ActiveCampaign documents `limit`/`offset` pagination and `orders[...]` /
 * `filters[...]` sorting-and-filtering globally rather than on each endpoint, so
 * the spec rarely declares them. We inject them onto collection GETs so the model
 * can page, sort and filter list responses as first-class tool inputs.
 */
const STANDARD_LIST_PARAMS: ParameterSpec[] = [
  {
    name: "limit",
    in: "query",
    required: false,
    description: "Number of results per page (ActiveCampaign default 20, max 100).",
    schema: { type: "integer", minimum: 1, maximum: 100 },
  },
  {
    name: "offset",
    in: "query",
    required: false,
    description: "Zero-based offset into the result set for pagination.",
    schema: { type: "integer", minimum: 0 },
  },
  {
    name: "orders",
    in: "query",
    required: false,
    description: 'Sort order as an object, e.g. {"email":"ASC"} → orders[email]=ASC.',
    schema: { type: "object", additionalProperties: { type: "string", enum: ["ASC", "DESC"] } },
  },
  {
    name: "filters",
    in: "query",
    required: false,
    description: 'Field filters as an object, e.g. {"name":"ecom"} → filters[name]=ecom.',
    schema: { type: "object", additionalProperties: true },
  },
];

/** True for collection endpoints (GET whose path does not end in a `{param}`). */
function isCollectionGet(method: string, path: string): boolean {
  return method === "get" && !/\}$/.test(path);
}

function withStandardListParams(method: string, path: string, params: ParameterSpec[]): ParameterSpec[] {
  if (!isCollectionGet(method, path)) return params;
  const present = new Set(params.filter((p) => p.in === "query").map((p) => p.name));
  const additions = STANDARD_LIST_PARAMS.filter((p) => !present.has(p.name));
  return additions.length > 0 ? [...params, ...additions] : params;
}

/** Parse a spec file (JSON or YAML) into a document object. */
function parseSpecFile(yamlOrJsonPath: string): OpenApiDoc {
  const raw = readFileSync(yamlOrJsonPath, "utf8");
  if (extname(yamlOrJsonPath).toLowerCase() === ".json") {
    return JSON.parse(raw) as OpenApiDoc;
  }
  return parseYaml(raw) as OpenApiDoc;
}

/** Load a single OpenAPI definition into a flat list of operations. */
export function loadSpec(specPath: string, source: SpecSource): Operation[] {
  const doc = parseSpecFile(specPath);
  const operations: Operation[] = [];
  if (!doc.paths) return operations;

  const serverPath = serverPathFromDoc(doc);

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem) continue;
    const pathLevelParams: ParameterSpec[] = (pathItem.parameters ?? [])
      .map((p) => resolveParameter(doc, p))
      .filter((p): p is ParameterSpec => Boolean(p));

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!op || typeof op !== "object") continue;

      const opParams: ParameterSpec[] = (op.parameters ?? [])
        .map((p) => resolveParameter(doc, p))
        .filter((p): p is ParameterSpec => Boolean(p));

      // Operation-level params override path-level ones by (name + in).
      const merged = new Map<string, ParameterSpec>();
      for (const p of pathLevelParams) merged.set(`${p.in}:${p.name}`, p);
      for (const p of opParams) merged.set(`${p.in}:${p.name}`, p);

      const allParams = [...merged.values()].filter(
        (p) => !(p.in === "header" && HEADERS_TO_SKIP.has(p.name.toLowerCase())),
      );

      let requestBodySchema: JsonSchema | undefined;
      let requestBodyRequired = false;
      let requestBodyContentType: string | undefined;
      if (op.requestBody) {
        const rb = resolveRequestBody(doc, op.requestBody);
        if (rb?.content) {
          const jsonEntry = rb.content["application/json"] ?? Object.values(rb.content)[0];
          if (jsonEntry?.schema) {
            requestBodySchema = dereferenceSchema(doc, jsonEntry.schema);
            requestBodyContentType =
              "application/json" in rb.content ? "application/json" : Object.keys(rb.content)[0];
            requestBodyRequired = rb.required ?? false;
          }
        }
      }

      const operationId =
        op.operationId?.trim() ||
        `${method}-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

      operations.push({
        operationId,
        method,
        path,
        summary: op.summary,
        description: op.description,
        group: groupForPath(path),
        parameters: withStandardListParams(
          method,
          path,
          allParams.map((p) => ({
            ...p,
            schema: p.schema ? dereferenceSchema(doc, p.schema) : undefined,
          })),
        ),
        requestBodySchema,
        requestBodyRequired,
        requestBodyContentType,
        source,
        serverPath,
      });
    }
  }

  return operations;
}

/** Load and merge every bundled definition in `sources` from `specDir`. */
export function loadAllSpecs(
  specDir: string,
  sources: SpecSource[],
  resolvePath: (dir: string, file: string) => string,
): Operation[] {
  const all: Operation[] = [];
  for (const source of sources) {
    all.push(...loadSpec(resolvePath(specDir, source.file), source));
  }
  return all;
}
