# Unknot API daemon

Optional (`unknot daemon [--port N]`). Zero dependencies: `node:http`, `node:https`, `node:crypto`.
Every endpoint calls the same library function as the matching CLI command, so the API cannot do
anything the CLI's policy would refuse. There is no shell endpoint, and no endpoint approves.

## Threat model

| Threat | Control |
| --- | --- |
| Remote attacker reaches a local daemon | Local mode binds `127.0.0.1` / `::1` only; any other `daemon.listen` host is refused at startup (`UK_POLICY_DENIED`). |
| Malicious web page drives the daemon via the browser (CSRF / DNS rebinding) | Bearer token required (a page cannot read the 0600 token file); `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; JSON-only `content-type` forces a CORS preflight, and no `access-control-*` header is ever sent. |
| Token theft from disk | `<unknotHome>/daemon/<project-id>.token`, created `0600` (32 random bytes, base64url). A token file readable by group/other makes startup fail. The token is never printed or logged. Delete the file to rotate. |
| Timing attacks on the token | Both sides are SHA-256 hashed, then compared with `timingSafeEqual`. |
| Network attacker / unauthorised client in remote mode | HTTPS with `requestCert: true, rejectUnauthorized: true`, `ca = daemon.tls.client_ca`: the handshake fails without a client certificate from that CA. |
| Stolen or forged identity token | OIDC JWT, signatures verified offline against `daemon.oidc.jwks_file` (re-read when its mtime changes; no network fetch). Only RS256 (>= 2048-bit), ES256 (P-256) and EdDSA (Ed25519), each pinned to its key type, so `alg: none`, HS* and the "public key as HMAC secret" confusion attack are rejected before key lookup. `iss`, `aud`, `exp` required; `nbf`, `iat` checked; 60 s skew. Unknown `kid` is rejected. |
| Privilege escalation | RBAC from `daemon.oidc.role_claim` through `role_map` to `viewer < planner < operator < admin`; the highest mapped role wins, a token with no mapped role is denied. |
| Cross-tenant access | `X-Unknot-Tenant` must match `^[a-z0-9][a-z0-9-]{1,62}$`, be in the token's `tenants` claim and in `daemon.tenants`. The project is `<root>/<tenant>` (resolved with `resolveInside`, which blocks traversal and symlink escape) and must itself contain `.unknot`, so lookup never walks up into a parent project. Idempotency rows live in the tenant's own store. |
| Approval bypass | `POST /v1/slices/{id}/approve` always returns `403 UK_POLICY_DENIED` for every role. Approvals need the interactive CLI with an approver key (spec 16.3). API callers are recorded as non-human actors (`ci:api:<subject>`), so no human-only check can be satisfied through the API. |
| Resource exhaustion | 1 MiB request limit (declared and actual bytes; excess is discarded, then the socket is cut), token-bucket rate limit (default 60/min, per client address, and per subject in remote mode), request/header timeouts, 8 MiB per proof-bundle file. |
| Replay / duplicate mutation | `Idempotency-Key` (8-128 visible chars) required on mutations. |
| Information leakage | Errors use the spec 25 shape; unexpected errors become `internal error` with no stack. Responses are `application/json` (or NDJSON), `cache-control: no-store`. 401s carry no hint about which check failed. |

Out of scope: TLS certificate issuance/rotation, revocation lists (rotate the client CA and JWKS file),
and per-request audit of rejected requests. Run behind your normal network controls.

## Configuration

`daemon` block of `.unknot/config.yaml`: `listen`, `mode` (`local` | `remote`), `tls {cert,key,client_ca}`,
`oidc {issuer,audience,jwks_file,role_claim,role_map}`, `tenants`. Remote mode refuses to start unless
all of these are present and every `role_map` value is a valid role. In remote mode the project root
given to the daemon is the tenants base directory: tenant `acme` is `<root>/acme`.

## Request rules

* Mutations (`POST`): `Content-Type: application/json` (else 415), JSON object body (else 400),
  `Idempotency-Key`. Same key and same request replays the stored 2xx response (`idempotent-replay: true`);
  same key with a different request is `409 UK_STATE_CONFLICT`. Keys are scoped per tenant and principal.
* Mutations on one project are serialised.
* `GET` slice/campaign/finding/run return `ETag: "<version>"`; `apply`, `verify` and run `end` honour
  `If-Match` (mismatch is `412 UK_STATE_CONFLICT`).
* Status mapping: 400 schema, 401 unauthenticated, 403 policy/RBAC/tenant/Host, 404, 405, 409 conflict,
  412, 413, 415, 429 budget (with `Retry-After`), 500 internal.

## Endpoints

| Endpoint | Role | Notes |
| --- | --- | --- |
| `GET /v1/healthz` | none | `{"ok":true}` only |
| `POST /v1/runs` | planner | `{command, scope?, slice_id?, campaign_id?}`; starts a run (409 if one is active) |
| `GET /v1/runs/{id}` | viewer | ETag |
| `POST /v1/runs/{id}/end` | planner | `{outcome?}` (extra to the spec list, so a client-started run can be closed) |
| `POST /v1/maps` | planner | `{scope?, adapters?, history?}` |
| `POST /v1/diagnoses` | planner | `{scope?, objective?, only?}` |
| `GET /v1/findings/{id}` | viewer | ETag |
| `POST /v1/campaigns` | planner | `{objective, findings? / decomposition? / proposal?, scope?, constraints?}`; needs `mode: plan` |
| `GET /v1/campaigns/{id}`, `GET /v1/slices/{id}` | viewer | ETag; extras that make the concurrency token readable |
| `POST /v1/slices/{id}/approve` | any | always 403 |
| `POST /v1/slices/{id}/apply` | operator | `{action: start|finish|replan|abandon, reason?}`; `If-Match` |
| `POST /v1/slices/{id}/verify` | operator | `If-Match` |
| `GET /v1/slices/{id}/proof-bundle` | viewer | manifest + file list; `?file=<name>` returns one manifest entry, digest-checked |
| `POST /v1/decisions` | planner | `{finding, decision: accept|reject, rationale, days?}` |
| `GET /v1/audit/events` | admin | NDJSON; first line is a header with the audit public key and `verifyLedger` result; `?after=<seq>&limit=` |
