# ohneben's ActiveCampaign MCP

[![CI](https://github.com/ohneben/ActiveCampaign-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/ohneben/ActiveCampaign-MCP/actions/workflows/ci.yml)
[![Publish Docker image](https://github.com/ohneben/ActiveCampaign-MCP/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/ohneben/ActiveCampaign-MCP/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE.md)

**The most complete ActiveCampaign MCP server there is.** Run your entire
[ActiveCampaign](https://www.activecampaign.com/) account in plain language from
**Claude**, **Cursor**, or any other [MCP](https://modelcontextprotocol.io) client.

This [Model Context Protocol](https://modelcontextprotocol.io) server exposes the
**whole ActiveCampaign account API — ~325 tools** — covering the v3 REST API plus
the **SMS**, **WhatsApp** and async **Segments** APIs, generated straight from
ActiveCampaign's own OpenAPI definitions. Every tool is **safety-categorized**
(🟢 read-only / 🟡 write / 🔴 destructive) so your assistant knows what an action
does *before* it calls it. It runs over **stdio** (Claude Desktop and other local
launchers) or **Streamable HTTP** (hosted in Docker), and ships with retries,
client-side rate limiting tuned to ActiveCampaign's 5 req/s cap, and request
timeouts so it holds up against a live account.

## Why you'll want this

Some MCP servers just forward a slice of the API. This one is built to be **safe
to hand to an LLM**, **complete**, and **easy to run for real**:

| What you get | Why it matters |
| --- | --- |
| **~325 tools — the full account API** | Complete coverage of contacts, deals, accounts, lists, tags, custom fields & objects, ecommerce (deep data), campaigns, messages, automations, segments, webhooks, tasks, calendars, site/event tracking, SMS and WhatsApp — nothing hand-picked or left behind. Other servers stop at ~60. |
| **Curated safety categories** 🟢 / 🟡 / 🔴 | Not naive "GET = safe": `contact sync` is flagged as an **upsert**, a segment-match `POST` as a **read-only query**, tagging a contact as a **link**, and `POST /sms/broadcasts` as **sends messages** — so the model knows the real blast radius. |
| **Machine-readable MCP annotations** (`readOnlyHint`, `destructiveHint`) | Hosts that honor annotations (Claude included) can auto-trust reads and demand confirmation before anything destructive. |
| **Read-only mode & resource filtering** | Expose only 🟢 read-only tools (`ACTIVECAMPAIGN_READ_ONLY=true`), or narrow to just the groups you use (`ACTIVECAMPAIGN_INCLUDE_GROUPS=contacts,deals,lists`). Tailor the surface per deployment. |
| **Pagination made first-class** | `limit`, `offset`, `orders[…]` and `filters[…]` are injected onto every list endpoint as typed inputs, so the assistant can page, sort and filter without guessing ActiveCampaign's bracket syntax. |
| **Automatic retries with backoff** | Transient `429` / `5xx` responses are retried with jittered exponential backoff, honoring the server's `Retry-After` header. |
| **Built-in rate limiting** | Self-throttles under ActiveCampaign's **5 requests / second** account cap so a burst of tool calls never trips a `429`. |
| **Response-size guard** | Optionally cap huge list responses (`ACTIVECAMPAIGN_MAX_RESPONSE_CHARS`) so one call can't blow the model's context window. |
| **GraphQL passthrough** | A bonus tool for ActiveCampaign's Ecommerce GraphQL API when you want to shape exactly the fields you need in one round-trip. |
| **Two transports: stdio *and* Streamable HTTP** | Use it locally in Claude Desktop, or run one always-on server that any number of MCP clients reach over HTTP. |
| **Docker + docker-compose, health check, auto-restart** | Production-style deployment out of the box: `docker compose up` and it stays up. |
| **Optional bearer-token auth** on the HTTP endpoint | Put the server behind a shared secret the moment it's reachable beyond localhost. |
| **Your token never reaches the model** | The `Api-Token` lives in the server's environment and is injected on every request — the assistant only ever sees tool inputs and API responses. |
| **Drop-in spec updates** | ActiveCampaign ships newer OpenAPI JSON? Replace the file in `spec/` and rebuild — new endpoints become new tools automatically, no code changes. |

## How it compares

There are a few ways to reach ActiveCampaign from an AI assistant today. Here's how
this server stacks up against the alternatives:

| | **This server** | Official AC remote MCP | HighLiuk `mcp-server-activecampaign` | `mcp-activecampaign` (PyPI) | CData MCP |
|---|:---:|:---:|:---:|:---:|:---:|
| Approx. tools | **~325** | curated subset | 58 | ~65 | 3 (generic SQL) |
| Full v3 REST coverage | ✅ | ➖ | ➖ core CRM | ➖ broad CRM | ❌ |
| SMS · WhatsApp · Segments | ✅ | ❌ | ❌ | ❌ | ❌ |
| Ecommerce deep data + GraphQL | ✅ | ➖ | ❌ | ➖ | ❌ |
| Reads **and** writes | ✅ | ✅ | ✅ | ✅ | ❌ read-only |
| Self-hosted on your own infra | ✅ | ❌ vendor cloud | ✅ | ✅ | ✅ |
| Connects directly to the AC API | ✅ | ✅ | ✅ | ✅ | ❌ via JDBC driver |
| `stdio` transport | ✅ | ❌ | ✅ | ✅ | ✅ |
| Streamable-HTTP transport | ✅ | ✅ | ➖ | ➖ | ❌ |
| Docker + compose + health check | ✅ | n/a | ❌ | ❌ | ❌ |
| Curated 🟢 / 🟡 / 🔴 safety categories | ✅ | ➖ | ➖ partial | ➖ | n/a |
| `readOnlyHint` / `destructiveHint` | ✅ | ➖ | ➖ | ➖ | ➖ |
| Read-only mode + group filtering | ✅ | ❌ | ❌ | ❌ | always read-only |
| Rate limiting + auto-retry (`429`/`5xx`) | ✅ | ➖ | ❌ | ➖ | ❌ |
| Language | TypeScript | — | TypeScript | Python | Java |
| License | MIT | proprietary | MIT | MIT | MIT |

<sub>✅ = yes · ➖ = partial / not documented · ❌ = no. Compiled from each project's
public documentation; this is an unofficial project, not affiliated with
ActiveCampaign or the projects listed. Tool counts are approximate and move as APIs
evolve.</sub>

**The short version:** the official remote MCP is a great managed on-ramp but runs
in ActiveCampaign's cloud on a curated slice of the API. The community servers are
solid but top out around 60 tools of core CRM, stdio-only, without a deployment
story. This one gives you **the entire account API**, **both transports**, a
**Docker deployment**, and **safety guardrails** — self-hosted, on your token, MIT.

## What you can do

Once it's connected, ask your assistant things like:

- "Find the contact jane@example.com and show her tags, lists and recent activity."
- "Create a deal for Acme Corp worth $12,000 in the 'Sales' pipeline, stage 'Qualified'."
- "List contacts added this month who opened the last campaign but haven't been tagged 'engaged'."
- "Add the tag 'webinar-2026' to every contact on list 5."
- "Show total ecommerce revenue and the top 10 orders from last week."
- "Create a segment of customers in Germany and count how many match."
- "Draft an SMS broadcast to the 'VIP' list — but don't send it until I confirm."

Tools are generated automatically from ActiveCampaign's specs and grouped into
🟢 read-only, 🟡 write and 🔴 destructive — so a well-behaved host can treat each
group differently.

## How it works

```
Claude / Cursor / any MCP client  ──MCP──►  this server  ──HTTPS──►  ActiveCampaign API (your account)
```

The server parses the bundled OpenAPI definitions into MCP tools (resolving
`$ref`s and guarding against recursive schemas), tags each with a curated safety
category, and injects your `Api-Token` header on every outgoing request. Your
token stays in the server's environment — the model never sees or handles it.

## Requirements

- An **ActiveCampaign account with API access** — your **API URL** and **API
  token** from **Settings → Developer**. See
  [Get your API credentials](#get-your-api-credentials).
- **Docker** (Docker Desktop on macOS/Windows) for the quick start below — or
  **Node.js ≥ 18** to [run from source](#run-from-source-stdio-no-docker).

## Quick start (Docker)

**1. Add your credentials.** Copy the example config and fill it in:

```bash
cp .env.example .env
# edit .env → set ACTIVECAMPAIGN_API_URL and ACTIVECAMPAIGN_API_TOKEN
#           → set MCP_SHARED_TOKEN to a long random string if reachable beyond localhost
```

**2. Start the server:**

```bash
docker compose up -d --build
```

The bundled `docker-compose.yml` binds to `127.0.0.1:8765` only, so the server is
reachable from your machine but not the network.

**3. Confirm it's running:**

```bash
curl -s http://localhost:8765/health
# → {"status":"ok","server":"activecampaign-mcp","tools":325}
```

**4. Connect your MCP client.** The MCP endpoint is `http://localhost:8765/mcp`.

- **Claude Desktop** — add a **custom connector** (Settings → Connectors) pointing
  at the URL, or bridge it locally with
  [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). Add this under
  `mcpServers` in your config, then fully quit and reopen the app:

  ```json
  {
    "mcpServers": {
      "activecampaign": {
        "command": "npx",
        "args": [
          "mcp-remote",
          "http://localhost:8765/mcp",
          "--header", "Authorization: Bearer YOUR_MCP_SHARED_TOKEN"
        ]
      }
    }
  }
  ```

  (Drop the `--header` line if you left `MCP_SHARED_TOKEN` empty.)

- **Claude Code** — one command:

  ```bash
  claude mcp add --transport http activecampaign http://localhost:8765/mcp
  ```

- **Claude Cowork** — shares Claude Code's MCP config, so the command above makes
  the tools available there too.

### Prefer a prebuilt image?

Every push to `main` publishes a ready-to-run image to the GitHub Container
Registry, so you can skip the local build entirely:

```bash
docker run -d --name activecampaign-mcp -p 127.0.0.1:8765:8765 --env-file .env \
  ghcr.io/ohneben/activecampaign-mcp:latest
```

## Get your API credentials

1. Log in to ActiveCampaign and open **Settings → Developer**.
2. Copy your **API URL** → `ACTIVECAMPAIGN_API_URL`. It looks like
   `https://your-account.api-us1.com/api/3`. **Use the exact URL shown** — not all
   accounts are on `api-us1`, and custom domains differ.
3. Copy your **API Key** → `ACTIVECAMPAIGN_API_TOKEN`.

Put both in `.env`. The server injects the token on every request, so your
assistant never sees it.

## Configuration

Everything is set in `.env` (copied from `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `ACTIVECAMPAIGN_API_URL` | ✅ | — | Your account's API URL, incl. `/api/3` |
| `ACTIVECAMPAIGN_API_TOKEN` | ✅ | — | Your API token (`Api-Token` header) |
| `MCP_TRANSPORT` | — | `stdio` | `stdio` or `http` (the Docker image defaults to `http`) |
| `PORT` | — | `8765` | HTTP listen port |
| `HOST` | — | `0.0.0.0` | HTTP bind address |
| `MCP_HTTP_PATH` | — | `/mcp` | HTTP MCP route |
| `MCP_SHARED_TOKEN` | — | _(off)_ | Require `Authorization: Bearer <token>` on `/mcp` |
| `ACTIVECAMPAIGN_MAX_REQUESTS` | — | `4` | Client-side requests per window (`0` disables throttling) |
| `ACTIVECAMPAIGN_RATE_WINDOW_MS` | — | `1000` | Rate-limit window in ms (default: 4 req/s) |
| `ACTIVECAMPAIGN_MAX_RETRIES` | — | `3` | Retries on `429` / `5xx` / network errors |
| `ACTIVECAMPAIGN_TIMEOUT_MS` | — | `30000` | Per-attempt request timeout |
| `ACTIVECAMPAIGN_READ_ONLY` | — | `false` | Expose only 🟢 read-only tools |
| `ACTIVECAMPAIGN_INCLUDE_GROUPS` | — | _(all)_ | Only expose these resource groups (comma-separated) |
| `ACTIVECAMPAIGN_EXCLUDE_GROUPS` | — | _(none)_ | Hide these resource groups |
| `ACTIVECAMPAIGN_ENABLE_GRAPHQL` | — | `true` | Expose the Ecommerce GraphQL passthrough tool |
| `ACTIVECAMPAIGN_GRAPHQL_URL` | — | _(derived)_ | Override the GraphQL endpoint |
| `ACTIVECAMPAIGN_MAX_RESPONSE_CHARS` | — | `0` | Truncate responses longer than N chars (`0` = never) |
| `ACTIVECAMPAIGN_SPEC_DIR` | — | _(bundled)_ | Load OpenAPI files from a different directory |

After changing `.env`, reload with `docker compose up -d --force-recreate`.

Run `npm run list-tools` (no credentials needed) to print the full catalog, the
per-category counts, and the list of resource-group keys you can filter on.

## Tool safety categories

Each tool's description starts with one of these banners and carries the matching
[MCP annotations](https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations):

| Banner | Count | `readOnlyHint` | `destructiveHint` | Meaning |
|---|:---:|:---:|:---:|---|
| 🟢 **READ-ONLY** | 155 | `true` | `false` | `GET` — fetches data only. Safe. |
| 🟢 **READ-ONLY · query** | 7 | `true` | `false` | A `POST` that *searches/reports* (segment match, metrics export) — changes no data. |
| 🟡 **WRITE · creates data** | 51 | `false` | `false` | `POST` — creates a record (not idempotent; may duplicate). |
| 🟡 **WRITE · creates or updates** | 1 | `false` | `false` | Idempotent upsert (`contact sync`). |
| 🟡 **WRITE · updates data** | 52 | `false` | `false` | `PUT` / `PATCH` — modifies a record in place. |
| 🟡 **WRITE · links records** | 6 | `false` | `false` | Associates records (tag a contact, add to a list/automation). Reversible. |
| 🟡 **WRITE · unlinks records** | 5 | `false` | `false` | Removes an association (untag, remove from list). Reversible. |
| 🟡 **WRITE · sends messages** | 3 | `false` | `false` | Sends/schedules an outbound SMS or WhatsApp message. |
| 🟡 **GraphQL** | 1 | `false` | `false` | Arbitrary GraphQL document (may contain mutations). |
| 🔴 **DESTRUCTIVE · deletes data** | 42 | `false` | `true` | `DELETE` — removes a record. Confirm first. |
| 🔴 **DESTRUCTIVE · bulk delete** | 2 | `false` | `true` | Deletes many records at once. Confirm first. |

That's **162 read-only · 119 write · 44 destructive = 325 tools.** Hosts that
respect annotations (Claude included) can require confirmation for
`destructiveHint` tools and trust `readOnlyHint` tools automatically. Prefer to
lock it down further? Set `ACTIVECAMPAIGN_READ_ONLY=true` to expose *only* the 162
read-only tools.

<details>
<summary><strong>Coverage by area (🟢 read / 🟡 write / 🔴 destructive)</strong></summary>

| Area | 🟢 Read | 🟡 Write | 🔴 Delete | Tools |
|---|:---:|:---:|:---:|:---:|
| Custom Fields & Objects | 18 | 25 | 9 | **52** |
| Deals & Pipelines | 19 | 23 | 9 | **51** |
| Contacts | 30 | 11 | 2 | **43** |
| Campaigns & Messaging | 15 | 10 | 4 | **29** |
| Admin & Delivery | 12 | 8 | 6 | **26** |
| Accounts | 8 | 13 | 4 | **25** |
| Segments | 16 | 3 | 1 | **20** |
| Ecommerce (Deep Data) | 9 | 6 | 3 | **18** |
| SMS | 12 | 4 | 1 | **17** |
| Lists, Tags & Forms | 8 | 5 | 2 | **15** |
| Site & Event Tracking | 7 | 5 | 2 | **14** |
| WhatsApp | 7 | 5 | 1 | **13** |
| Automations | 1 | 0 | 0 | **1** |
| GraphQL passthrough | — | 1 | — | **1** |
| **Total** | **162** | **119** | **44** | **325** |

</details>

## Run from source (stdio, no Docker)

Prefer the classic stdio mode for Claude Desktop? Build it locally:

```bash
npm install
npm run build
```

Then point Claude Desktop at the compiled entrypoint in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "activecampaign": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/ActiveCampaign-MCP/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ACTIVECAMPAIGN_API_URL": "https://your-account.api-us1.com/api/3",
        "ACTIVECAMPAIGN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Keeping the specs current

The bundled files under `spec/` are the source of truth for the tools:

| File | API | Auth header |
|---|---|---|
| `v3.json` | Core v3 REST API | `Api-Token` |
| `sms.json` | SMS Broadcast API | `Api-Token` |
| `whatsapp.json` | WhatsApp channel API | `Token` (also sends `Api-Token`) |
| `segments-crud.json`, `segments-match-one.json`, `segments-match-all-some.json` | Async Segments API | `Api-Token` |

To refresh against a newer API version, drop the updated OpenAPI JSON in place (or
point `ACTIVECAMPAIGN_SPEC_DIR` at a directory using the same filenames) and
rebuild. New paths become new tools automatically — no code changes needed.

## Development

```bash
npm install
npm run build      # compile TypeScript → dist/
npm test           # run the Vitest suite
npm run list-tools # print the categorized tool catalog (no credentials needed)
```

CI builds and tests every push across Node 20 and 22; pushes to `main` also
publish a Docker image to the GitHub Container Registry.

## Notes & conventions

- **Transports**: `MCP_TRANSPORT=stdio` (default) for local launchers;
  `MCP_TRANSPORT=http` for the always-on Streamable-HTTP server the Docker image
  runs.
- **Paging / sorting / filtering**: list tools accept `limit` (max 100), `offset`,
  `orders` (`{"email":"ASC"}`) and `filters` (`{"name":"ecom"}`). For very large
  contact exports ActiveCampaign recommends `orders={"id":"ASC"}` + `id_greater`.
- **Rate limit**: ActiveCampaign allows 5 requests / second per account (shared
  across every key); the server self-throttles at `ACTIVECAMPAIGN_MAX_REQUESTS`
  per `ACTIVECAMPAIGN_RATE_WINDOW_MS` (default 4 / 1 s) and retries any `429` it
  still receives, honoring `Retry-After`.
- **Request bodies**: write tools take a `body` argument; its schema is resolved
  from the spec and shown to the model (e.g. create-contact expects
  `{"contact": {…}}`).

## Security

- Your API token lives only in `.env`, which is git-ignored. **Never commit real
  secrets.** The token grants full account access — if it leaks, rotate it in
  **ActiveCampaign → Settings → Developer**.
- The HTTP endpoint is unauthenticated by default (fine on localhost). To expose
  it beyond your machine, set `MCP_SHARED_TOKEN` and send it as an
  `Authorization: Bearer <token>` header — ideally behind TLS.
- Delete and **send** (SMS/WhatsApp) tools carry the right annotations so a
  well-behaved host prompts before acting — keep that confirmation on, or run in
  `ACTIVECAMPAIGN_READ_ONLY=true` mode.

See [SECURITY.md](./SECURITY.md) for the full policy and how to report a
vulnerability.

## Credits & license

An unofficial community integration for
[ActiveCampaign](https://www.activecampaign.com/); not affiliated with or endorsed
by ActiveCampaign. Built on the [Model Context Protocol](https://modelcontextprotocol.io).
Tools are generated from ActiveCampaign's public OpenAPI definitions. Licensed
under the [MIT License](./LICENSE.md).
