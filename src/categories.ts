/**
 * Safety categorisation for every ActiveCampaign operation.
 *
 * Each tool carries two, complementary signals:
 *   1. machine-readable MCP annotations (`readOnlyHint`, `destructiveHint`, …)
 *      so a well-behaved host (Claude included) can auto-trust reads and demand
 *      confirmation before destructive actions, and
 *   2. a human-readable 🟢 / 🟡 / 🔴 banner prepended to the description so the
 *      model sees the category even if it ignores annotations.
 *
 * A naive "GET = safe, everything-else = write, DELETE = destructive" mapping is
 * a decent floor, but it mislabels real endpoints:
 *   - `POST /contact/sync` is an idempotent upsert, not a blind create;
 *   - `POST /segmentMatchAll` runs a *search* — it changes no account data;
 *   - `POST /contactTags` merely *links* a tag to a contact (reversible);
 *   - `DELETE /contactTags/{id}` *unlinks* it (reversible, low-risk) — not the
 *     same as deleting the contact;
 *   - `POST /sms/broadcasts` *sends messages* to real people — arguably the most
 *     consequential thing in the whole API;
 *   - `DELETE /accounts/bulk_delete` removes many records at once.
 *
 * So we start from the HTTP method and then apply a curated per-operation
 * override map (keyed by the stable `operationId`) for the cases that deserve a
 * sharper label. A wrong or missing override simply falls back to the
 * method-based default, which is always at least as cautious.
 */

export type CategoryId =
  | "read"
  | "query"
  | "create"
  | "upsert"
  | "update"
  | "link"
  | "unlink"
  | "send"
  | "delete"
  | "bulk_delete";

export interface CategoryMeta {
  id: CategoryId;
  /** Banner prefixed to the tool description. */
  banner: string;
  /** One-line explanation of what this class of action does. */
  blurb: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  read: {
    id: "read",
    banner: "🟢 READ-ONLY",
    blurb: "Fetches data. Makes no changes to your ActiveCampaign account.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  query: {
    id: "query",
    banner: "🟢 READ-ONLY · query",
    blurb:
      "Runs a search/report (a POST that returns data). Changes no account records; may create a short-lived, cached result-set.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  create: {
    id: "create",
    banner: "🟡 WRITE · creates data",
    blurb: "Creates a new record. Not idempotent — calling twice may create duplicates.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  upsert: {
    id: "upsert",
    banner: "🟡 WRITE · creates or updates",
    blurb: "Creates the record if it is new, otherwise updates the existing one (an upsert). Idempotent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  update: {
    id: "update",
    banner: "🟡 WRITE · updates data",
    blurb: "Modifies an existing record in place. Idempotent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  link: {
    id: "link",
    banner: "🟡 WRITE · links records",
    blurb:
      "Creates an association between records (e.g. tags a contact, adds a contact to a list/automation). Reversible.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  unlink: {
    id: "unlink",
    banner: "🟡 WRITE · unlinks records",
    blurb:
      "Removes an association between records (e.g. untags a contact, removes it from a list/automation). Reversible — it does not delete the underlying records.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  send: {
    id: "send",
    banner: "🟡 WRITE · sends messages",
    blurb:
      "Sends or schedules an outbound message (SMS / WhatsApp) to real recipients. Not reversible once delivered — confirm the audience first.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  delete: {
    id: "delete",
    banner: "🔴 DESTRUCTIVE · deletes data",
    blurb: "Deletes a record. Confirm with the user before calling.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  bulk_delete: {
    id: "bulk_delete",
    banner: "🔴 DESTRUCTIVE · bulk delete",
    blurb: "Deletes many records in a single call. High blast radius — always confirm before calling.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
};

/**
 * Curated overrides keyed by `operationId`. Only operations whose method-based
 * default would be misleading are listed here — everything else uses the default.
 */
export const CATEGORY_OVERRIDES: Record<string, CategoryId> = {
  // ── Upserts (idempotent create-or-update) ──────────────────────────────
  "sync-a-contacts-data": "upsert",

  // ── Non-mutating POST searches / reports (return data, change nothing) ──
  create_match_all_request: "query",
  create_match_all_request_with_segment_id: "query",
  find_contact_id_by_ac_playload: "query",
  getBroadcastMetrics: "query",
  getBroadcastSnapshotByIds: "query",
  exportBroadcastMetrics: "query",
  exportBroadcastRecipients: "query",

  // ── Links (associate records — reversible) ─────────────────────────────
  "create-contact-tag": "link",
  "create-new-contactautomation": "link",
  "update-list-status-for-contact": "link",
  "create-an-account-1": "link", // POST /accountContacts — create an association
  "create-a-custom-field-relationship-to-lists": "link",
  "add-custom-field-to-field-group": "link",

  // ── Unlinks (remove associations — reversible, not record deletes) ─────
  "remove-a-contacts-tag": "unlink",
  "delete-a-contactautomation": "unlink", // remove a contact from an automation
  "delete-an-association-1": "unlink", // DELETE /accountContacts
  "delete-a-custom-field-relationship-to-lists": "unlink",
  "delete-custom-field-field-group": "unlink",

  // ── Outbound message sends (real-world effect) ─────────────────────────
  createBroadcast: "send",
  createAIBroadcast: "send",
  "Send a WhatsApp Template Message": "send",

  // ── Bulk deletes (high blast radius) ───────────────────────────────────
  "bulk-delete-accounts": "bulk_delete",
  "bulk-delete-variables": "bulk_delete",
};

function defaultCategory(method: string): CategoryId {
  switch (method.toLowerCase()) {
    case "get":
      return "read";
    case "delete":
      return "delete";
    case "put":
    case "patch":
      return "update";
    default:
      return "create"; // post
  }
}

export function categoryFor(operationId: string, method: string): CategoryMeta {
  const override = CATEGORY_OVERRIDES[operationId];
  return CATEGORIES[override ?? defaultCategory(method)];
}

/** Coarse bucket used for the read-only filter and headline counts. */
export function safetyBucket(id: CategoryId): "read" | "write" | "destructive" {
  if (id === "read" || id === "query") return "read";
  if (id === "delete" || id === "bulk_delete") return "destructive";
  return "write";
}
