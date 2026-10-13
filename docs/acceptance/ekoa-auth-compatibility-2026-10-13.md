# Ekoa authentication compatibility, 13 October 2026

Decision 788. Live evidence; mirror acceptance blocked.

The owner completed the previously pending Ekoa browser sign-in. The authenticated connected-apps page shows the existing Claude connection. No password is read or saved, no existing connection is revoked, and no new grant is created.

At 19:00 UTC, both public metadata endpoints on https://mcp.ekoa.io return HTTP 200. The authorization-server metadata offers authorization_code and refresh_token, S256 PKCE, scopes ekoa.read/ekoa.write, and the /oauth/authorize, /oauth/token and /oauth/register endpoints. The protected-resource metadata identifies /mcp and that authorization server. An unauthenticated MCP initialize returns HTTP 401 with the protected-resource challenge. These are live protocol reads, not authenticated tool discovery or a mirror pass.

Current Ekoa source (read-only) accepts only its OAuth access-token prefix and OAuth principal at the MCP boundary. Access tokens last one hour; refresh tokens rotate. Its gateway keys and ordinary browser session are not substitute MCP credentials. Current Jevellan apps/daemon/src/ekoa-client.ts sends a supplied static Authorization bearer header and has no authorization/refresh flow. No secret is extracted from the browser, native homes or existing Claude connection.

Therefore the durable mirror is blocked on unsupported authentication, as the original Phase 8 requires. A manually obtained one-hour access token would not complete that requirement. No owner credential action can resolve the missing client behavior. OAuth work remains outside the newest cache/journal scope; sandbox provider scenarios continue independently, with mirror assertions blocked. No Ekoa code, CI, scheduler, grant or production service is changed.
