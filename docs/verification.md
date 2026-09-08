# Verification

Living record of what is checked automatically, what was measured, and what remains unverified.
Update the tables when results change; never record a number that was not measured.

## Automated
| Area | Where | Status |
|---|---|---|
| Migrations apply cleanly; schema snapshot; invariants (partial unique indexes, CHECKs, FKs) | `tests/integration/migrations.test.ts`, `schema-invariants.test.ts` | pending |
| Recurrence (completion-anchored vs fixed calendar vs seasonal), month ends, DST 2027-03-28 / 2027-10-31 | `tests/unit/domain/*` | pending |
| Occurrence lifecycle, weekly reminders, restart catch-up, digest | `tests/unit/domain/*` | pending |
| Completion + stock atomicity, idempotency, concurrency, void/correction, kit explode, replacement | `tests/unit/domain/*` | pending |
| Notification action validation and replay | `tests/unit/domain/*` | pending |
| Low battery: hysteresis, invalid/stale values, recovery ≠ maintenance | `tests/unit/domain/*`, `tests/unit/ha/*` | pending |
| HA socket: auth, reconnect, resubscribe, heartbeat, registry re-list | `tests/unit/ha/*` | pending |
| Model manifest validation, colour-plan isolation, visibility/explode policy, geometry | `tests/unit/house/*` | pending |
| Auth boundary: 401/redirect, expired/revoked, sign-up blocked, rate limit, open redirect | `tests/unit/auth/*`, `tests/e2e/auth.spec.ts` | pending |
| Files: safeJoin, sniffing, EXIF stripping, upload cap | `tests/unit/files/*` | pending |
| Backup/restore round trip | `tests/integration/backup-restore.test.ts` | pending |
| Browser: model load, selection, colours, views, explode, edit, phone locate | `tests/e2e/house.spec.ts` | pending |

## Measured (fill in with real numbers, machine and date)
| Metric | Target | Measured | Machine / date |
|---|---|---|---|
| First useful maintenance screen (LAN) | < 1 s | | |
| Interactive simplified model | < 3 s | | |
| Selection feedback | < 100 ms | | |
| Orbit frame time p95 | ≤ 16.7 ms | | |
| Web RSS p50/p95 | measured → alert 1.5× p95 | | |
| Worker RSS p50/p95 | measured → alert 1.5× p95 | | |

## Not verified / limitations
- Live Home Assistant delivery to phones: requires `HA_TOKEN` on the server; until then tests use the fake HA server.
- Deployment on the Mac mini: scripts are tested locally; the first real install happens with the owner.
