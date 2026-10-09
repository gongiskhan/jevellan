# Work with Jevellan from another agent

Jevellan exposes a Streamable HTTP MCP server at `/mcp`, plus a local stdio client through `jevellan mcp-server`. Both use the same tools, resources and prompts. This connection is separate from the scoped worker bridge carried by Jevellan's own running agents.

Open **Settings → Agents**, create a named connection, and copy its token. You can grant access to all projects and conversations or select specific projects, choose an expiry, and revoke the connection later. The token is shown once. Retrying a creation request returns the existing connection without issuing another token; if the original response was lost, revoke that connection and create a replacement.

For a client that supports remote MCP:

```json
{
  "mcpServers": {
    "jevellan": {
      "url": "https://YOUR-JEVELLAN-HOST/mcp",
      "headers": { "Authorization": "Bearer <connection token>" }
    }
  }
}
```

Settings supplies the actual address and a copyable configuration. Clients with a local-command transport can use:

```json
{
  "mcpServers": {
    "jevellan": {
      "command": "jevellan",
      "args": ["mcp-server"],
      "env": {
        "JEVELLAN_MCP_URL": "https://YOUR-JEVELLAN-HOST/mcp",
        "JEVELLAN_MCP_TOKEN": "<connection token>"
      }
    }
  }
}
```

Use the executable path on the client machine if `jevellan` is not on its PATH. Store the connection token in that client's private configuration or secret storage. Jevellan does not install anything into native agent homes.

## Discover and delegate

Start with `jevellan_discover`. It reports the available tools, providers, accounts and readiness, model IDs, supported efforts, devices, project access and limits. Tools advertise their own input schemas and whether they read, change or discard work. Use the returned stable IDs for choices.

- `jevellan_job_start` creates ordinary conversation work in a registered project.
- `jevellan_thread_start` creates a project job with placement choices.
- `jevellan_coordinator_send` gives work to a project coordinator, which can delegate it to threads.
- Read, message, stop and override controls expose the same work continuity and resource gates as the app.
- Project tools cover decisions, the revisioned notebook, mail, file reservations, managed app links and pull request controls. Memory tools read Jevellan's isolated project memory.

Each selection accepts `"auto"` or an explicit value: `providerId` (also called `runtimeId`), `accountId`, `modelId` and `effort`. Project jobs also expose isolation and device. Automatic choices pass through the existing decision system; explicit choices must still satisfy enabled providers, account authentication, usage ceilings, paid-use rules, device availability and project limits. Provider and runtime aliases must agree when both specify explicit IDs.

Choose a stable `clientRequestId` or `clientMessageId` before a repeatable mutation and keep it when retrying the exact request. Generation and revision inputs come from the read tools; stale changes are refused. Stop and discard actions retain the app's settlement behavior. Inspect a job before choosing a destructive action.

Conversation start choices apply to the next decision, like the app's composer. Use `jevellan_job_override` with `mode: "pin"` to keep a choice for later decisions; Auto clears it. Project threads retain their chosen runtime and model across turns, with normal next-turn overrides or restart controls. Returning a thread's provider to Auto clears its provider pin while preserving the current native runtime; changing providers requires a restart. Coordinator overrides apply from the next turn; its effort Auto restores the configured default.

Managed apps and memory belong to a device. Their read/stop tools accept an optional `deviceId`; leave it out for the connected device or use an ID from discovery for another owner. Starting an app follows its thread's owner. Job, thread and coordinator controls and output watch route to their owner automatically.

Update each participating Jevellan device to this release before using external-agent controls across devices. Older daemons do not provide the peer MCP endpoint and cannot read the new optional choice and external-mail fields. A failed remote call does not automatically upgrade that device.

## Tool reference

The server currently exposes these 47 tools. Discovery and the MCP tool list provide the current input schemas and capabilities for your connection.

| Purpose | Tool names |
| --- | --- |
| Discovery and projects | `jevellan_discover`, `jevellan_projects_list`, `jevellan_project_read`, `jevellan_project_settings_read` |
| Coordinator | `jevellan_coordinator_send`, `jevellan_coordinator_read`, `jevellan_coordinator_stop`, `jevellan_coordinator_fresh`, `jevellan_coordinator_move`, `jevellan_coordinator_override` |
| Project threads | `jevellan_threads_list`, `jevellan_thread_start`, `jevellan_thread_read`, `jevellan_thread_send`, `jevellan_thread_stop`, `jevellan_thread_override`, `jevellan_thread_restart`, `jevellan_thread_discard`, `jevellan_thread_allow_turns` |
| Conversation jobs | `jevellan_jobs_list`, `jevellan_job_start`, `jevellan_job_read`, `jevellan_job_send`, `jevellan_job_cancel`, `jevellan_job_override`, `jevellan_job_manual`, `jevellan_job_resume`, `jevellan_job_approve_plan`, `jevellan_job_close_work`, `jevellan_job_changes`, `jevellan_job_read_pointer` |
| Decisions | `jevellan_decisions_list`, `jevellan_decision_answer` |
| Notebook, mail and reservations | `jevellan_notebook_read`, `jevellan_notebook_write`, `jevellan_mail_list`, `jevellan_mail_send`, `jevellan_reservations_list` |
| Managed apps | `jevellan_apps_list`, `jevellan_app_start`, `jevellan_app_stop` |
| Pull requests | `jevellan_pull_requests_list`, `jevellan_pull_request_refresh`, `jevellan_pull_request_merge` |
| Project memory | `jevellan_memory_search`, `jevellan_memory_read` |
| Organized output | `jevellan_watch` |

`jevellan_app_start` serves a static directory belonging to the thread or registered project checkout and returns a verified browser URL. `kind` defaults to `"static"`. External connections cannot supply an executable or arguments, including when they have access to all projects; arbitrary command app starts require a confined runner before they can be exposed. Coding and other execution use the job and thread tools with their normal runtime and account gates.

For example, send these three MCP `tools/call` parameter objects in order. Replace the project, provider, account and model placeholders with eligible IDs returned by discovery, then use the thread ID returned by the start result. Keep `inspect_app_20261009_01` when retrying that exact start request. Omit any selection field or set it to `"auto"` to let Jev choose it.

```json
[
  {
    "name": "jevellan_discover",
    "arguments": {}
  },
  {
    "name": "jevellan_thread_start",
    "arguments": {
      "projectId": "PROJECT_ID_FROM_DISCOVERY",
      "clientRequestId": "inspect_app_20261009_01",
      "title": "Inspect the app",
      "task": "Inspect the app and report how to run it. Do not change files.",
      "providerId": "PROVIDER_ID_FROM_DISCOVERY",
      "accountId": "ACCOUNT_ID_FROM_DISCOVERY",
      "modelId": "MODEL_ID_FROM_DISCOVERY",
      "effort": "auto",
      "isolation": "auto",
      "deviceId": "auto"
    }
  },
  {
    "name": "jevellan_watch",
    "arguments": {
      "target": {
        "kind": "thread",
        "projectId": "PROJECT_ID_FROM_DISCOVERY",
        "threadId": "THREAD_ID_FROM_START_RESULT"
      },
      "limit": 100,
      "streamMs": 30000
    }
  }
]
```

Read-only resources are `jevellan://guide`, `jevellan://capabilities`, `jevellan://projects` and `jevellan://jobs`. Resource templates expose `jevellan://projects/{projectId}`, `jevellan://projects/{projectId}/notebook`, `jevellan://projects/{projectId}/threads/{threadId}` and `jevellan://jobs/{conversationId}`. The prompts are `delegate_project_work` (required `projectId` and `task`) and `follow_jevellan_work` (required `target`). They supply delegation and listening guidance; obtaining a prompt does not start work.

## Follow output

`jevellan_watch` follows a conversation, project thread or project coordinator. It returns formatted Markdown and versioned structured events and blocks. Text, thinking, statuses, decisions and reports have distinct blocks. Consecutive calls to the same tool share an open output area; a different tool or another content block ends that group.

Keep the returned cursor separately for each target and pass it unchanged on the next watch. Event `id` values increase within that target. Individual text blocks and tool calls retain their `blockId`; `groupId` and the returned block's `id` identify their output area. A late tool result updates its original call and area even after other content has appeared. `continuation` marks an update to an existing area.

For text and thinking events, `offset` counts UTF-16 code units within that individual block, using JavaScript's `string.length`, rather than bytes or Unicode code points. Without `replace: true`, an event carrying an offset supplies the suffix to append at that position. With `replace: true`, its text replaces the block's full text and the offset is zero. Events without an offset are separate chunks to append to their area. Tool patches update the supplied `input`, `output` and `state` fields on the same `blockId`; preserve omitted fields and replace a supplied field's value rather than appending it.

`waitMs` waits for the first batch; `streamMs` keeps a request open for multiple batches. Total waiting is bounded to 30 seconds. Call again with the latest cursor to keep listening. MCP progress is supplied when the client requests it, with each versioned batch at `_meta["jevellan/output"]`. The final structured result also contains the request's collected events, so deduplicate by target and event `id` if you already rendered progress. Save each delivered batch's cursor; it lets you resume after cancellation without repeating that batch.

Cancellation, disconnection and revoked or expired access terminate listening without stopping the underlying job. Reading or reconnecting never starts work. Clients that do not render progress can use the final structured result and Markdown on normal completion.

The client's presentation determines how progress appears. A text-only client can print the Markdown; a richer client can render structured blocks and append updates to their existing areas. Jevellan-owned IDs identify this public output; native session identifiers and credentials are not part of it.

Streamed content is assembled before registered credentials and recognized credential patterns are redacted. Native stream fields, job text mirrors and opaque pointer content can contain partial source, so possible unfinished credential prefixes are withheld until they can be resolved safely. This protects opaque field names and values, including quoted JSON keys in native tool payloads; a field name alone does not establish a completed-document boundary. An ambiguous tail can remain withheld even after a native tool reports completion, since later patches can still arrive. Completed owner documents, mail and metadata retain ordinary text and mask whole credentials. The public journal stores only safe output, so paging, progress, cancellation and reconnecting do not expose previously received credential fragments. After an upgrade from the old output-journal format, discard its cursor and start watching without one to rebuild safe output from the source history.

## Scope and ownership

Selected-project connections cannot enumerate or act on other projects or their conversations. The hub stores token material in its encrypted vault and exposes masked connection summaries after issuance. Remote owners validate the connection and project scope at the operation boundary. Work remains on its owner device; following it from another agent does not move it.

External connections do not manage logins, fetch credentials, alter native homes, modify global configuration, or control Jevellan's installation lifecycle. Revoking a connection removes its access while work already admitted through the normal controls keeps running. This prevents a disconnected client from becoming the owner of a job's process lifetime.

Verification and deployment evidence is recorded separately in the [acceptance report](acceptance/REPORT.md).
