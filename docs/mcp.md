# Local AI connections

Virtual-home serves MCP through the existing web process at **`VH_BASE_URL/mcp`**. It uses stateless
Streamable HTTP, the existing HTTPS/LAN address, and individually revocable bearer credentials.
There is no additional listening port, database copy, cloud relay, or HA credential in a client.

## Create a connection

Open **Settings → AI connections**, create a clearly named connection for each AI app, and choose:

| Access | Capability |
|---|---|
| Read | Search records, retrieve details/relationships, read extracted documentation and request outcomes. |
| Edit catalog and instructions | Equipment, supplies, projects, plans, procedure drafts/publishing, providers, document metadata/text and attachment uploads. |
| Prepare actions for approval | Propose stock changes, actual work/history corrections, lifecycle/deletion changes and supported linked HA commands. Nothing consequential executes until approved in the app. |

Tokens are shown once and stored only as SHA-256 digests. They belong to the creating household
member. The default lifetime is 90 days, with 30-day and one-year options in the form. Revocation,
expiry and banned/deleted users are checked on every request and again inside write transactions.
Token management and action approval require a fresh database-backed browser session.

Copy the endpoint and token into **private client configuration**, never a repository, chat, URL,
command argument, or shared screenshot. The local server does not make an AI provider local: records
returned through the connection enter that AI app's context and are subject to its provider settings.

## Recommended desktop setup: shared private file and stdio bridge

Keep a JSON file outside the repository, permissions **0600**, containing:

```json
{
  "url": "https://home.example/mcp",
  "token": "PASTE_THE_ONCE_SHOWN_TOKEN_HERE"
}
```

Set `VH_MCP_CONFIG` to its absolute path. `scripts/mcp-bridge.mjs` reads this file and forwards MCP
stdio to authenticated HTTP. It never prints its credential. The bridge requires installed project
dependencies and the chosen application Node runtime; use absolute paths because GUI apps do not
necessarily inherit your shell's PATH. HTTP is allowed only on loopback; use the normal HTTPS address
across the LAN. Reuse the current runtime and TLS deployment rather than changing either for MCP.

For Codex, merge this entry into the user's private configuration:

```toml
[mcp_servers.virtual_home]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/virtual-home/scripts/mcp-bridge.mjs"]

[mcp_servers.virtual_home.env]
VH_MCP_CONFIG = "/absolute/private/path/virtual-home-mcp.json"
```

Codex also supports direct HTTP when the bearer variable is already supplied to its process:

```toml
[mcp_servers.virtual_home]
url = "https://home.example/mcp"
bearer_token_env_var = "VIRTUAL_HOME_MCP_TOKEN"
```

Choose one entry, not both. A shell variable does not automatically reach an already running GUI
app. The bridge avoids that problem by reading the private file directly. The supported configuration
keys are documented in [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For Claude Desktop, merge the following into its existing `mcpServers` configuration; preserve all
other connections:

```json
{
  "mcpServers": {
    "virtual-home": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/virtual-home/scripts/mcp-bridge.mjs"],
      "env": {
        "VH_MCP_CONFIG": "/absolute/private/path/virtual-home-mcp.json"
      }
    }
  }
}
```

Claude Desktop's Developer settings provide **Edit Config**; restart the app after saving. See the
[official local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
If a client runs on another computer, the bridge runs there and reaches the same LAN HTTPS endpoint;
the database stays on the server.

## Efficient read and write workflow

1. Use `search` with a record kind and a short query. Pages default to 20 records, maximum 100.
2. Use `get` for one record, asking only for needed related sections. It includes `updatedAtMs`.
3. Use `list_related` to page through longer relationships. Cursors are bound to the source/filter.
4. Use `read_document` for bounded text, following `nextOffset`/`nextPage`. The default is 4,000
   characters and the MCP maximum is 12,000 per read. Cached PDF extraction runs in the worker;
   `pending`, `scan`, `truncated` and failure states must not be mistaken for an understood document.
5. Call `describe_operations` without names for a compact catalog, or with up to three operation
   names for exact argument schemas. Schemas are loaded when needed instead of repeated in every
   tool description.
6. Use the corresponding `equipment_write`, `supplies_write`, `projects_write`, `plans_write`,
   `procedures_write`, `providers_write` or `documents_write` tool.

Read kinds include equipment, locations, systems, supplies/storage, procedures, plans/tasks,
projects, providers/bookings, attachments, authored service documents, routes/endpoints/annotations
and completion history. Secrets, credentials, authentication records, arbitrary SQL/filesystem
access, model import and backup administration are not exposed.

Write tools take `operation`, `arguments`, and a caller-generated `requestKey` (8–128 characters).
Reuse that key only for an identical retry. Its operation/payload digest and result commit in the
same `BEGIN IMMEDIATE` transaction as the domain write, audit and events. A different payload with
the same connection/key conflicts. Web actions and MCP use the same extracted application services.

Equipment patches and supply/project/plan/provider updates take a **`patch`** object. Omitted
fields remain unchanged; explicit null clears only nullable fields. Send the `expectedRevision`
from `get` with the target kind, ID and `updatedAtMs`. A changed target conflicts rather than losing
another editor's work. Collections explicitly supplied in a patch replace that collection.
Procedure draft saves intentionally replace the complete draft content, and published versions stay
immutable. Document metadata/record edits use their service's `expectedUpdatedAtMs`; partial authored
report edits use `documents.patch_service_record`.

Authored installation instructions can live in equipment notes, linked procedure drafts, or
`documents.service_record` with `kind: "report"`, textual `notes`, and the relevant equipment ID.
A report/booking/project never creates a maintenance completion. Quantities remain integer
thousandths, money cents, and calendar dates household-local `YYYY-MM-DD`.

Large results are returned in `structuredContent` with a short text acknowledgement. Responses over
40,000 characters ask for a smaller request rather than silently truncating a detail object. Tool
JSON requests are capped at 128 KiB. Household document text is treated as untrusted data, never
instructions to the agent.

## Upload a manual or photo

Call `documents_upload` for the current endpoint, limits and helper instructions. File bytes never
belong in MCP JSON or model context. The companion helper uses the same private credential:

```sh
VH_MCP_CONFIG=/absolute/private/path/virtual-home-mcp.json \
  /absolute/path/to/node /absolute/path/to/virtual-home/scripts/mcp-upload.mjs \
  /absolute/path/to/user-selected-manual.pdf
```

The helper performs **PUT on the exact `/mcp` endpoint**, with raw bytes, bearer authentication and
`X-VH-Filename` containing the percent-encoded original filename. Actual streamed bytes are capped
by `VH_UPLOAD_MAX_BYTES` (normally 25 MiB), independent of Content-Length. Existing sniffing,
active-PDF rejection, metadata stripping, image derivatives, containment and deduplication apply.
Authorization is rechecked inside registration; failed registration cleans up finalized files.
The response contains a document ID and safe metadata, never a storage path or secret. Link that ID
using `documents.link`, or associate it with invoice/report metadata through `documents.service_record`.

## Consequential actions

Use **Rotate token** in AI connections to replace a credential without changing its name, scopes,
expiry or request history. Save the replacement token when it is shown; the previous token stops
working immediately, including requests still streaming an upload.

Use `request_action` for deletion, retirement/replacement, stock ledger changes, recording/correcting
work, document unlink/report deletion, provider archive, plan cancellation, draft discard and supported HA commands. Requests keep an
immutable validated payload, target snapshots and a 30-minute expiry. Their approval links open
Settings → AI connections; the global alert button also surfaces pending requests.

An app approval checks the connection again, compares captured targets, reruns domain validation,
and commits the result and request outcome once. A changed record requires a new request. Rejecting
or expiring a request changes no domain record. `request_status` only reads requests created by that
connection. `approved` for an HA command means it was queued; physical success must be observed
through the existing HA control status and telemetry.

## Verification and troubleshooting

`tests/integration/mcp.test.ts` exercises real protocol initialization, a spawned stdio bridge with a
temporary loopback HTTP listener, bounded reads, patch preservation, scope/expiry/revocation, replay
rollback, upload registration revocation, and approval once-only/target-change/expiry behavior.
Run it with loopback-listener permission in sandboxed environments.

401 means missing/expired/revoked credentials; 403 means an unavailable scope or incorrect host/origin.
Use the exact configured base URL rather than a raw IP alias. `revision_conflict` means refresh the
record before preparing the next patch. A `pending` document needs the worker extraction pass.
Bridge startup errors go to stderr; stdout is reserved for MCP JSON-RPC.
