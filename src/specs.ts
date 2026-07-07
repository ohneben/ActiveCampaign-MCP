/**
 * Manifest of the bundled OpenAPI specifications that make up ActiveCampaign's
 * account-level API surface.
 *
 * ActiveCampaign does not publish a single OpenAPI file. Their developer portal
 * is backed by several definitions, all served from the same account host
 * (`https://<account>.api-us1.com`):
 *
 *   - the main v3 REST API (contacts, deals, accounts, lists, tags, custom
 *     fields/objects, ecommerce, campaigns, automations, webhooks, …),
 *   - the SMS Broadcast API,
 *   - the WhatsApp channel API,
 *   - and the newer async Segments API (CRUD + match).
 *
 * We bundle each one under `spec/` and merge them at load time. Every operation
 * carries the auth scheme and server prefix of the definition it came from, so
 * the client can talk to each family of endpoints correctly even though they
 * differ slightly (WhatsApp uses a `Token` header; the segment-match endpoints
 * are mounted at the host root rather than under `/api/3`).
 *
 * The Partners/Agency API is intentionally excluded: it targets a different
 * product (reseller portal), a different host, and a different auth model, so it
 * does not belong in an account-scoped server.
 */

export interface SpecSource {
  /** Filename under `spec/`. */
  file: string;
  /** Short human label for the origin API, shown in tool descriptions. */
  label: string;
  /** HTTP header used to authenticate this definition's endpoints. */
  authHeader: string;
  /** Value prefix prepended to the token for this header (e.g. `"Token "`). */
  authPrefix: string;
}

/**
 * Order matters only for display/stability: the main v3 API comes first so its
 * operations win any (extremely unlikely) name race.
 */
export const SPEC_SOURCES: SpecSource[] = [
  { file: "v3.json", label: "Core", authHeader: "Api-Token", authPrefix: "" },
  { file: "sms.json", label: "SMS", authHeader: "Api-Token", authPrefix: "" },
  // WhatsApp endpoints are documented with a `Token: Token <value>` scheme.
  // We still send `Api-Token` too (see client.ts), so either is accepted.
  { file: "whatsapp.json", label: "WhatsApp", authHeader: "Token", authPrefix: "Token " },
  { file: "segments-crud.json", label: "Segments", authHeader: "Api-Token", authPrefix: "" },
  { file: "segments-match-one.json", label: "Segments", authHeader: "Api-Token", authPrefix: "" },
  { file: "segments-match-all-some.json", label: "Segments", authHeader: "Api-Token", authPrefix: "" },
];
