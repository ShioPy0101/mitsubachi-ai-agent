# Private user responses

Public and demo commands acknowledge with a waiting message (`type=4`,
`data.flags=64`). Updates to the original
response use that initial visibility. All interaction followups, including
demo previews and diagnostic attachments, also send `flags=64` in JSON or the
multipart payload. Immediate errors and search responses were already private.
The presentation modes and guild/demo access rules remain unchanged.

Discord preserves the visibility selected by the initial response;
it cannot be changed later. See the [official interaction documentation](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx).
The change applies to newly invoked commands, not previously public messages.

The receipt shows 「順番待ちしています…（待機順の目安：3番目）」.
One optional D1 read counts older `queued` jobs across the shared queue; equal
timestamps use insertion order. Running and terminal jobs are excluded. The
number is a snapshot at acceptance, not a live countdown or an execution-order
guarantee. If the job has already started, the receipt says processing is
starting. If position lookup fails, the waiting text remains without a number
and the accepted job is retained. Consumer progress replaces this receipt.

Receipt, queue-position, lookup-failure, and pipeline tests pass (22 tests).
The query uses operational job state and the existing status/created index;
there is no station data access, polling, or new migration.

User result delivery no longer falls back to a channel message when a callback
is missing, expired, rejected, or fails over the network. It reports failure to
the caller instead. Saved clip/job state follows the existing pipeline policy;
an expired interaction cannot receive the final result. Operational monitor
and alert messages continue to use their configured channels.

Verification uses local mocks only:

- Four pure tests verify no public fallback, including attached private audio.
- Interaction receipts, demo access, REST followups and multipart flags, public/demo
  pipeline delivery, and operational monitor tests pass (33 tests).
- Typecheck passes. No migration, external AI call or deployment is required.

```sh
pnpm test:station -t 'private interaction delivery'
pnpm exec vitest run tests/interactions.test.ts tests/demo.test.ts tests/discord-rest-client.test.ts tests/pipeline.integration.test.ts tests/job-monitor.test.ts
pnpm typecheck
```
