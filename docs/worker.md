# The worker

`dist/worker/index.mjs` — the background process. One per household, supervised by launchd. It is
the only process that holds `HA_TOKEN` and the only one that writes reminders.

Source: `src/worker/`. Entry `src/worker/index.ts`.

## Responsibilities

| Concern | Where | Cadence |
|---|---|---|
| HA WebSocket (states, registries, `state_changed`) | `ha/socket.ts` + `haBridge.ts` | event-driven; 250 ms coalescing, hourly re-list |
| Scheduling tick (`pending`→`due`, reminder slots, catch-up, digests) | `scheduler.ts` → `domain/notify/tick.ts` | every **60 s**, lease `notification_tick` |
| Outbox drain (`notify` / `clear` service calls) | `scheduler.ts` → `domain/notify/outbox.ts` | every **5 s**, lease `outbox_drain` |
| Inbound notification actions (a tap on a phone) | `actions.ts` → `domain/notify/actions.ts` | event-driven |
| Battery condition signals | `conditions.ts` → `domain/condition.ts` | event-driven (bridge callback) |
| Liveness | `jobs/heartbeat.ts` | every `VH_WORKER_HEARTBEAT_MS` (15 s) |
| Process metrics + 14-day pruning | `jobs/metrics.ts` | every `VH_METRICS_INTERVAL_MS` (60 s); prune hourly |
| Housekeeping (outbox, idempotency keys, expired sessions, WAL checkpoint) | `jobs/housekeeping.ts` | hourly |
| Integrity check (attachments vs rows, dangling `project_link`) | `jobs/integrity.ts` | daily |

Everything that *decides* anything lives in `src/domain`. `src/worker` is timing, transport and
adapters; that split is what lets the whole engine be tested with a fake clock and no socket.

### Cadences and windows in one place

- tick 60 s, lease TTL 90 s (one missed tick does not hand the lease away)
- drain 5 s, 20 commands per pass, clears before notifies
- send backoff 30 s → 1 m → 2 m → 5 m → 15 m → 30 m, then constant; abandon after 200 attempts
- slot claim TTL 120 s; command claim TTL 120 s (both reclaimed by the next pass)
- first run of each loop is jittered by up to 5 s, so two workers do not hit the lease in lockstep
- outbox retention 10 min, idempotency keys 24 h, metrics 14 days

## Startup sequence

1. `loadEnv('worker')`. Invalid configuration exits **78** (`EX_CONFIG`) printing field *names*,
   never values — `HA_TOKEN` must never reach a log file. A configured `HA_URL` without a usable
   `HA_TOKEN` is a config error, not a degraded mode.
2. Open the database (`getDb()`, WAL, `foreign_keys=ON`, `busy_timeout=5000`).
3. **Verify the schema; never migrate.** The journal in `drizzle/meta/_journal.json` is compared
   with `__drizzle_migrations`. If the journal is ahead the worker logs a `fatal` line naming the
   counts and exits **78**. Applying migrations is `pnpm db:migrate`'s job (production:
   `scripts/update.sh`, which stops the worker first and takes a backup) — two processes racing to
   migrate at boot is how a database gets corrupted.
4. Create a `workerId`: `<hostname>/<pid>/<random>`. The random suffix matters: a reused pid must
   not inherit a dead worker's lease.
5. HA, if `HA_URL` + `HA_TOKEN` are set: start the socket, the bridge and the
   `mobile_app_notification_action` subscription. Otherwise log **once** at `info` that HA is
   disabled, write `integration_status` accordingly, and carry on — scheduling is the point of
   this process, and a household without HA still gets its tick. Notifications simply stay
   `queued` and drain when HA appears.
6. Start the scheduler and the four jobs.

## Failure behaviour

- **A failing tick or drain is logged at `warn` and the loop continues.** A tick that died for
  good would take every reminder in the household with it. The counters are in
  `scheduler.stats`.
- **Never two runs of a loop at once.** Each loop arms its next run only after the previous one
  settled, and an out-of-band run while one is in flight is skipped (`drainSkips`/`tickSkips`).
- **An unhandled rejection or uncaught exception logs `fatal` and exits 1.** launchd restarts us
  (`ThrottleInterval` 10 s). Every lease and claim this process held expires on its own; the next
  tick reclaims expired slots and the next drain reclaims expired commands. A worker limping along
  in an unknown state is worse than a restart.
- **HA down is not an error.** `SendOutcome` distinguishes `ha_unavailable` (retry soon) from
  `ha_error` (something is wrong with us) and `timeout`. Clears jump the queue, so a completed task
  stops nagging as soon as HA comes back.
- **Nothing in an HA event handler throws.** `actions.ts` and `conditions.ts` catch everything: an
  exception crossing the `EventEmitter` boundary would take the process down over one bad payload.
- **SIGTERM / SIGINT**: stop the job timers, stop the scheduler (handing both leases back so a
  restart takes over without waiting out the 90 s TTL), flush the bridge's coalescing buffer, close
  the socket, `PRAGMA wal_checkpoint(TRUNCATE)`, close the database, exit 0.

## Running it

Development:

```bash
pnpm worker:dev          # VH_ROLE=worker tsx --env-file-if-exists=.env.local watch src/worker/index.ts
```

Reads `.env.local`. Pretty logs to stdout; `LOG_LEVEL=debug` shows every tick and drain result.
Running it alongside a production worker on the same database is safe — the leases decide which one
schedules — but expect "worker loop overlap skipped" to be absent and the lease to change hands.

Production:

```bash
pnpm build                                                        # next build + esbuild worker bundle
launchctl kickstart -k gui/$(id -u)/net.machadolucas.virtual-home.worker
tail -f ~/virtual-home-data/logs/worker.log
```

`scripts/launchd/run-worker.sh` sources `$VH_DATA_DIR/secrets/vh.env` (mode 0600 enforced) and
`exec`s `node dist/worker/index.mjs`. Logs: JSON to `logs/worker.log` (rolling daily, 20 MB, 14
files); launchd's own stdout/stderr goes to `logs/worker.launchd.log`.

To verify a bundle without starting it:

```bash
VH_ROLE=worker node --check dist/worker/index.mjs
```

## Log fields

Every line carries `role: "worker"` and `pid` from `src/server/log.ts`. Beyond that:

| Message | Fields |
|---|---|
| `worker started` | `workerId`, `db`, `ha`, `tickMs`, `drainMs`, `heartbeatMs`, `metricsMs` |
| `notification tick` (info, only when something happened) | `becameDue`, `slotsCreated`, `slotsHealed`, `slotsFastForwarded`, `slotsHeld`, `slotsClaimed`, `slotsFailed`, `slotsReclaimed`, `commandsQueued`, `digestsSent`, `inCatchUp`, `outageMs`, `fence` |
| `outbox drain` (info, only when something happened) | `attempted`, `sent`, `requeued`, `abandoned`, `reclaimed`, `slotsSent`, `fence` |
| `worker loop ran` (debug) | `loop`, `durationMs`, plus the whole `TickResult` / `DrainOutboxResult` |
| `worker loop failed` (warn) | `loop`, `err`, `durationMs` |
| `worker loop overlap skipped` (warn) | `loop` |
| `notification action handled` | `action`, `validation`, `effect`, `eventId` |
| `notify send skipped: HA not subscribed` (debug) | `commandId`, `kind`, `socketState` |
| `battery signal evaluated` (info, only on a transition) | `entityRegistryId`, `rawState`, `occurrenceId`, `episodeId`, `alertId` |
| `integrity check found problems` (warn) | `missingFiles`, `orphanFiles`, `danglingLinks` |
| `ha snapshot applied` | `entities`, `devices`, `renames`, `removals`, `statesCached`, `skipped` |

Secrets are redacted by `src/server/log.ts` as a last line of defence; the first line of defence is
that nothing here logs a token or a payload body.

## When notifications do not arrive

Work down this list; each step distinguishes a different box.

1. **Is the worker alive?** `integration_status.heartbeat_at_ms` is bumped every 15 s *regardless
   of HA state*, and `worker_heartbeat('worker')` carries `worker_id` and `tick_count`. A stale
   heartbeat means the worker is down — check `logs/worker.launchd.log` and
   `launchctl print gui/$(id -u)/net.machadolucas.virtual-home.worker`. Do not blame HA for this.
2. **Is the schema behind?** A worker that exited 78 with "database schema is N migration(s)
   behind" needs `pnpm db:migrate`, not a restart.
3. **Is the tick running?** `worker_heartbeat('notification_tick').last_ok_ms` should be under a
   minute old. If it is not, and the process is alive, another worker holds the lease: check
   `worker_lease` (`holder_id`, `expires_at_ms`).
4. **Did the occurrence become due?** `maintenance_occurrence.status` flips to `due` at
   `delivery_time` on `due_date` in the household time zone — not at midnight, not earlier.
   `occurrence_event('became_due')` records it.
5. **Is there a slot?** `reminder_slot` for the recipient state, `state='pending'`. A
   `held_until_ms` in the future means the send window guard parked it (a late reminder is not
   sent at 03:00). `state='failed'` with `cancel_reason='no_device'` means the recipient has no
   active `user_notify_device` — there is an `app_alert` for that.
6. **Is there a command?** `ha_notify_command` for the slot, one per active device. `state`:
   - `queued` with `next_attempt_at_ms` in the future → backing off; read `last_error`.
   - `queued` and never attempted → look at `delivery_attempt` (there should be a row per attempt).
   - `abandoned` → 200 attempts failed; there is a `worker_outage` alert.
   - `sent` → **HA accepted the call.** We record `sent`, never `delivered`: HA → APNs → phone is
     not observable to us. From here the problem is HA or the phone.
7. **Is HA reachable?** `integration_status.state` should be `subscribed`. `auth_failed` means the
   token is bad or revoked — rotate `HA_TOKEN` (`docs/operations.md`) and restart the worker.
   `disconnected` with a recent `heartbeat_at_ms` means the worker is fine and HA is not.
8. **Does the notify service still exist?** `user_notify_device.notify_service` must match a live
   `notify.mobile_app_<device>` in HA; the companion app renames it when the phone is re-added. A
   `last_error` mentioning "service not found" is this.
9. **Did the tap come back?** `notification_action_event` records every inbound action, accepted or
   not. `validation` tells you why one was refused (`unknown_nonce`, `wrong_recipient`, `expired`,
   `action_not_offered`, `device_mismatch`, `duplicate`).

## Integrity findings

`app_alert.kind=integrity` separates file/link findings from worker outages. System → Integrity
shows structured findings and explicit repair links. Missing-file records are retained. Confirmed
orphan files can be quarantined and restored using no-overwrite staging and a transactional journal;
quarantined bytes are part of backup/restore. The interactive report is read-only. Worker alerts
remain deduplicated and do not equate acknowledgment with repair.

## Local document text index

`jobs/documents.ts` processes one uncached PDF per pass, starting five seconds after startup and
waiting 15 seconds between passes. It never overlaps its own jobs. Parsing occurs outside a write
transaction; a short `writeTx` stores the result and emits `document.changed`. The `document_text`
row is keyed by attachment ID and checked against the immutable file SHA-256 and extractor version.
A version/hash mismatch is queued automatically; a failed result waits for the explicit Retry action.

Extraction is limited to 300 pages, 100,000 characters per page and 1,000,000 characters per file,
with a 30-second cancellation timer. It records `ready`, `truncated`, `scan`, `encrypted` or `failed`;
a missing row means pending. Empty scanned pages are never represented as searchable text. OCR is
not performed. The UI and MCP can read bounded page/offset slices with continuation fields, and
search uses only extracted text from matching file hashes. Original files are never altered.
