# 0018. Personal RevBank access through a private gateway

Status: accepted for implementation; deployment requires operator configuration.

## Context

People want to read their own prepaid balance and bookings in Pixel. RevBank and its existing Git backup must remain unchanged. Pixel is public source; the backup contains private account records, terminal input and transaction descriptions.

## Decision

Pixel calls a separately deployed private gateway. Only that gateway can read a local mirror of the backup. Pixel has no Git credentials, backup mount, account catalogue, or persisted financial data. The gateway's code and operations live in a separate private repository. Public code contains only the typed API port, HTTP client, commands and fictional fixtures.

- Personal commands require at least friend tier: friends, members and admins can use them, while guests cannot. A RevBank account does not grant Pixel membership, and membership does not grant access to a RevBank account.
- The authenticated Discord actor is the only identity used for personal requests. There is no personal `user` or `nick` selector on balance/history requests. Replies and failures are private from the initial deferral onward.
- A request carries a nickname, expires after 24 hours and receives a unique request ID. It reveals no account existence. A manager verifies ownership independently in person, then approves that exact request for the selected Discord user. Self-approval is refused by the gateway.
- Link management requires the `revbank-link-admin` capability at member tier in Pixel **and** a separately maintained immutable-ID allow-list in the gateway. Managers can inspect pending/link metadata and approve, reject or revoke; they cannot read another person's balance. Approvals enforce one Discord identity per account. Unlinking is available to the owner without a manager.
- The gateway reads fixed filenames from one immutable Git commit. It never checks out or executes backup content. Account creation markers bind links to account incarnations, so a missing or recreated account fails closed. Unrecognised formats and account/log inconsistencies fail closed. Historic data is taken from confirmed booking records, not commit messages or Git diffs.
- Only the last ten confirmed bookings are exposed. Labels come from recognised catalogue descriptions; other descriptions become generic credit/debit/adjustment labels. Raw terminal input, counterparties and free-form log content never cross the API.
- Pixel stores no financial response. HTTP requests have an eight-second deadline, a streamed 16 KiB response cap, strict schemas, no redirects and no automatic retries. Errors contain fixed codes only. There is no financial/request-body logging.
- The TypeScript gateway runs as a separate Azure Container App in Pixel’s existing Container Apps environment, with internal HTTPS ingress and a dedicated bearer token. Its private repository provides the deployment recipes and separate Terraform state keys. HTTP is allowed only for loopback testing. No public ingress or Tailscale Funnel. Dev must use a separate gateway, token and fictional backup.

## Consequences and limits

The gateway trusts Pixel to identify the authenticated Discord actor correctly. A stolen Pixel service token can impersonate linked users; a private repository does not remove that trust. Token rotation and network ACLs remain necessary. Neither Pixel operators nor gateway operators are cryptographically prevented from accessing the data they administer.

Data is as recent as the backup commit, not live. The private service enforces a configured maximum age and reports the commit time; old commits may mean either a quiet space or an interrupted backup. No financial writes, payments, reminders, public statistics or automated membership changes are included.

RevBank's terminal operates on trust. A nickname entered there is not proof of ownership. Renames require unlinking and a fresh, independently verified request. Restore procedures must not silently resurrect revoked links. The private service owns the link-state audit and retention; the Pixel privacy notice describes the integration separately from ordinary Pixel storage.

## Validation

Tests cover dispatcher gating, private replies, actor-only requests, schema/size failures, missing or expired approvals, request replacement, duplicate links, self-approval, revocation, recreated accounts, inconsistent snapshots and removal of private descriptions. Operators must review the gateway, configure access and verify its private deployment before enabling production.
