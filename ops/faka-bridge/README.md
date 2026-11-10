# FakaBridge subscription delivery repair

The MoNexus formatter previously stripped integer trailing zeros (`100 GB` became
`1 GB`). The bridge also omitted the subscription credential, leaving buyers with
a panel URL even when the panel user frontend was disabled.

## Source changes

- `server/src/lib/fakaBridge/subscriptionResult.ts` preserves integer zeros,
  accepts the optional `subscription.subscribe_url`, and delivers it as a masked,
  copyable field. HTTPS without embedded username/password is required.
- The structured delivery remains within the shared eight-field contract. If a
  renewal contains both expiry and traffic comparisons, its cycle stays in the
  complete text rather than exceeding the structured field limit.
- `subscription-url.patch` is a companion patch for the separately deployed
  Xboard FakaBridge plugin. Apply from the plugin root with `patch -p1 --dry-run`
  before `patch -p1`. Back up both touched files first; do not apply to an unknown
  plugin version without reviewing the context.
- The plugin uses the core `Helper::getSubscribeUrl` domain configuration and
  subscription hooks. It resolves the account through the completed Xboard trade,
  checks its email against the bridge order, and excludes blocked users. No
  email-only credential lookup, token rotation, or additional provisioning occurs.

The optional nested field is carried by the existing paid/status subscription
parser into both normal fulfillment and reconciliation. Older plugin responses
remain accepted; missing links instruct the buyer to contact support.

## Production deployment on 2026-11-10

The active plugin is a persistent bind mount under `/root/Xboard/plugins/FakaBridge`
on `oracle-sg`. Only its order service and signed webhook controller were changed.
Octane workers were reloaded; the installed worker-start hook resets opcode caches.
No proxy or public path configuration changed.

The backend hotfix image is derived from the existing `sha-c176be7` image and
replaces only the compiled subscription result module:
`ghcr.io/amo0114/monexus-server:hotfix-faka-delivery-20261110`.
This image exists on the production host, not in the remote registry. Compose adds
`/root/monexus-faka-delivery-repair-20261110/docker-compose.faka-delivery.yml` to
select it. The backend was recreated alone, after verifying its environment was
unchanged. The web image and shared image tag were unchanged.

Backups, Dockerfile, compiled module, deployment script and receipt live under
`oracle-sg:/root/monexus-faka-delivery-repair-20261110/` (root-only). Integrate this
source change into the next normal backend release before removing the overlay.
A deployment that discards the overlay and uses an older image loses the fix.

To roll back code, restore the two plugin originals from that directory and reload
Octane; recreate the backend with the original Compose file list recorded in
`deployment-receipt.json`, excluding the hotfix overlay. Use the normal deployment
lock `/var/lock/monexus-compose-deploy.lock`. Do not roll back a valid delivery
credential or replay an order merely to roll back code.

## Existing delivery repair

`repair-deliveries.mjs` is an explicit operator tool, executed from the backend
runtime root via standard input. It does not provide a public endpoint. Set
`FAKA_REPAIR_ORDER_IDS` and `FAKA_REPAIR_ADMIN_ID`; first run without
`FAKA_REPAIR_APPLY`. Copy `/tmp/faka-delivery-originals.json` from the container to a
root-only persistent backup. Only then repeat with `FAKA_REPAIR_APPLY=1`.

The tool requires delivered, unexpired legacy orders with successful bridge tasks.
It verifies the signed read-only status response against both external order and
Xboard trade. Credential changes and audit records commit together; balances,
orders' economic facts, expiration dates and provider execution remain unchanged.
Its traffic correction is deliberately limited to the two confirmed incident
orders (55 and 56), zero current usage, and the exact erroneous 1 GB snapshot.
Other historical traffic snapshots are preserved.

Never copy the backup, subscription URL, provider response body, signing parameters
or runtime environment into a PR, logs or chat. The subscription URL grants access.

## Validation

- Ten focused formatter/parser/delivery tests passed; server `tsc --noEmit` passed.
- Signed read-only status probes for both affected orders returned matching trades,
  107374182400 bytes and the configured subscription host.
- Both repaired delivery records parse correctly, show 100 GB and mark the URL
  sensitive. The normal builder also emits the credential from current responses.
- Owner detail exposes the credential; the order list excludes it; another buyer
  is rejected; anonymous HTTP access returns 401.
- Backend is healthy; local live/ready and public ready checks return 200.

The separately authorized assisted purchase used the normal transactional order,
point hold/capture and provider outbox flow in an isolated maintenance process.
Its creation event identifies an administrator; an audit record explicitly records
operator exceptions to email proof and buyer consent. Account email verification,
OTP evidence and global verification settings were unchanged. The temporary helper
was not included in the serving application or the hotfix image.
