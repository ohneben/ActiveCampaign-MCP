import { categoryFor, safetyBucket, type CategoryId } from "./categories.js";
import type { JsonSchema, Operation, ParameterSpec } from "./openapi.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** The REST operation this tool proxies, or `null` for special tools (GraphQL). */
  operation: Operation | null;
  group?: string;
  category?: CategoryId;
}

export interface ToolFilterOptions {
  includeGroups?: Set<string>;
  excludeGroups?: Set<string>;
  readOnly?: boolean;
}

const MCP_TOOL_NAME_MAX = 64;

function snakeCase(input: string): string {
  return input
    .replace(/whatsapp/gi, "whatsapp") // keep the brand word whole (else → "whats_app")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // split camelCase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function paramToSchema(p: ParameterSpec): JsonSchema {
  const base: Record<string, unknown> = { ...(p.schema ?? { type: "string" }) };
  if (p.description && !base.description) base.description = p.description;
  // A renamed (sanitized) parameter still reaches ActiveCampaign under its raw
  // bracket name, so surface it in the description for discoverability.
  if (p.argName && p.argName !== p.name) {
    base.description = [base.description, `Sent to ActiveCampaign as "${p.name}".`].filter(Boolean).join(" ");
  }
  return base;
}

function buildInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    const key = p.argName ?? p.name;
    properties[key] = paramToSchema(p);
    if (p.required) required.push(key);
  }

  if (op.requestBodySchema) {
    properties.body = { description: "Request body (application/json).", ...op.requestBodySchema };
    if (op.requestBodyRequired) required.push("body");
  }

  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Prettify a camelCase resource group into a human title, e.g. `ecomOrders` → `Ecom Orders`. */
export function prettyGroup(group: string): string {
  return group
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function buildDescription(op: Operation, category: CategoryId): string {
  const meta = categoryFor(op.operationId, op.method); // resolves via override map
  const lines: string[] = [];
  lines.push(`${meta.banner} · ${prettyGroup(op.group)} · ${op.method.toUpperCase()} ${op.path}`);
  if (op.summary) lines.push(op.summary);
  lines.push(meta.blurb);
  if (op.description) {
    const desc = op.description.trim();
    if (desc && desc !== op.summary) lines.push(desc.length > 500 ? desc.slice(0, 500) + "…" : desc);
  }
  return lines.join("\n\n");
}

/** Apply group / read-only filters to the operation set (before naming). */
function filterOperations(operations: Operation[], opts: ToolFilterOptions): Operation[] {
  return operations.filter((op) => {
    const g = op.group.toLowerCase();
    if (opts.includeGroups && !opts.includeGroups.has(g)) return false;
    if (opts.excludeGroups && opts.excludeGroups.has(g)) return false;
    if (opts.readOnly) {
      const bucket = safetyBucket(categoryFor(op.operationId, op.method).id);
      if (bucket !== "read") return false;
    }
    return true;
  });
}

export function operationsToTools(
  operations: Operation[],
  opts: ToolFilterOptions = {},
): ToolDefinition[] {
  const used = new Set<string>();
  const tools: ToolDefinition[] = [];

  for (const op of filterOperations(operations, opts)) {
    let baseName = snakeCase(op.operationId) || snakeCase(`${op.method}_${op.path}`) || "tool";
    if (baseName.length > MCP_TOOL_NAME_MAX) baseName = baseName.slice(0, MCP_TOOL_NAME_MAX);

    // Resolve the (rare) collision: try a group prefix, then a numeric suffix.
    let name = baseName;
    if (used.has(name)) {
      const prefixed = `${snakeCase(op.group)}_${baseName}`.slice(0, MCP_TOOL_NAME_MAX);
      if (!used.has(prefixed)) name = prefixed;
    }
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${baseName}_${i}`.slice(0, MCP_TOOL_NAME_MAX))) i++;
      name = `${baseName}_${i}`.slice(0, MCP_TOOL_NAME_MAX);
    }
    used.add(name);

    const meta = categoryFor(op.operationId, op.method);
    const title = op.summary?.trim() || op.operationId;

    tools.push({
      name,
      description: buildDescription(op, meta.id),
      inputSchema: buildInputSchema(op),
      annotations: { title, ...meta.annotations },
      operation: op,
      group: op.group,
      category: meta.id,
    });
  }

  return tools;
}
