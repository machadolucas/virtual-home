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
| Browser, fixture package: load integrity, selection + URL sync, click picking, colour isolation, visibility, views, explode, on-demand rendering, asset auth/ETag, mount→unmount→mount disposal | `tests/e2e/house.spec.ts` (`--project=desktop`) | **14 passed, 2 skipped, 0 failed** (2026-09-08) |
| Browser, real package: load timing, 401/403-surface colours, living-room datum pick, shared-wall independence, dormer isolation, exploded structure edges, orbit frame times | `tests/e2e/house-real.spec.ts` (`--project=desktop`, `VH_REAL_MODEL_DIR` set) | **7 passed, 1 skipped, 0 failed** (2026-09-08) |
| Browser screenshots (§13.4 list) | `tests/e2e/screenshots.spec.ts` | **desktop 9 passed / 13 skipped, phone 1 passed / 21 skipped**; 16 captures in `test-results/screenshots/` (2026-09-08) |

The two skips in `house.spec.ts` and the one in `house-real.spec.ts` are deliberate and carry their
reasons in the test bodies:

- `entering edit mode zeroes the gap and the save payload is physical` — the e2e bootstrap seeds no
  equipment and registers no model revision, so there is no placement to edit and
  `lastSavePayload()` can never be non-null. Needs a change to `tests/e2e/start-server.ts`.
- `the plan view looks straight down at the active floor` — `test.fixme`, an app bug (below).
- `a saved colour comes back on the next page load` — `test.fixme`, an app bug (below).

Screenshot entries 9, 12–17, 21, 23 and 26–28 of §13.4 are skipped individually, each naming what it
needs (a garage or structure asset the fixture does not have; a placement; a stored route; a Home
Assistant connection; a seeded task).

## Measured (fill in with real numbers, machine and date)

Machine: MacBook Pro, Apple M5 Pro (`Darwin 27.0.0 arm64`). Browser: headless Chromium via
Playwright 1.63 (`ANGLE / SwiftShader` software rasteriser — no GPU). Date: 2026-09-08.
Package: the household's own `example-house-1` @ `0000000000000000`, installed into the e2e
harness's throwaway data directory. Raw run artefact: `test-results/house-measurements.json`.

| Metric | Target | Measured | Machine / date |
|---|---|---|---|
| First useful maintenance screen (LAN) | < 1 s | not measured | — |
| Interactive simplified model | < 3 s | **0.73 s** real package (`phase: interactive`, and `ready` in the same tick; 0.60 s for the synthetic fixture), from that document's navigation start | M5 Pro, headless Chromium, 2026-09-08 |
| Selection feedback | < 100 ms | **6.3 ms** pointerup → `invalidate()` (3 invalidations); the inspector heading was present within **16 ms** of the click | M5 Pro, headless Chromium, 2026-09-08 |
| Orbit frame time p95 | ≤ 16.7 ms | **22.6 ms** (avg 20.7 ms) over a 2.1 s scripted keyboard orbit: 108 frames, 349 draw calls, 11 570 triangles | M5 Pro, **headless SwiftShader**, 2026-09-08 |
| Web RSS p50/p95 | measured → alert 1.5× p95 | not measured | — |
| Worker RSS p50/p95 | measured → alert 1.5× p95 | not measured | — |

Further numbers from the same run, all read through `window.__vh`:

| What | Measured | Note |
|---|---|---|
| Default-tier scene, real package | 350 geometries, 350 draw calls, 11 578 triangles, 1 texture, 2 shader programs | 7 assets; the two structure assets sit behind their layer and the two scan references are opt-in |
| Surfaces in the nine `loadByDefault` assets | 403 total, **401** carrying a material | The 2 mesh-less ones are exactly `s-e-f-garage-ext-out-0-upper` and `s-e-f-garage-ext-out-2-upper`, as §14.2 of the design note predicted. §13.2 #3's "403 entries" should read 401. |
| `baseColorFactor` ↔ `defaultColor` | all 401 equal the manifest's `defaultColor`, exactly | end to end through GLTFLoader and three's colour management |
| Cloned materials | 0 for every loaded asset (fixture and real) | the per-surface-material guarantee still holds |
| Living-room pick | `s-r-g-living-floor` at y = **−0.300 m** | picked from overhead at the room's own anchor; its floor is 0.30 m below the ground-floor datum |
| Exploded floors, gap 3 m | `house-upper/f-upper` world Y = **3.000**, `house-ground/f-ground` = **0.000**, `house-structure`'s edges overlay hidden | offsets come from the manifest's own floor order |
| Idle workspace | **0** `invalidate()` calls in 2.0 s | `frameloop="demand"` really does stop |
| Fixture scene | 32 geometries (28 mesh-backed surfaces + 4 edges overlays), 32 draw calls, 56 triangles | and 32 → 0 → 32 across unmount and remount |

## App bugs found by the browser suite (not fixed here — this suite does not edit app code)

1. **The plan view never looks down.** `src/house/hooks/useCameraApi.ts:132-135` — `planFor(floorId)`
   is only `fitBox(planBox3(...))`, and `fitBox` (same file, 77-99) frames with
   `controls.fitToBox()`, which by design fits along the *current* view direction. Nothing rotates
   the polar angle to 0. Measured: isolate the lower floor in orthographic (pose
   `[3, 1.15, 38.28]` → target `[3, 1.15, 2]`, polar 90°, a pure side elevation), then press
   "Plan view (P)" — the pose does not change at all. §4.2 and §13.2 #16 both require polar 0. The
   `minPolarAngle = maxPolarAngle = 0` lock in `src/house/components/Rig.tsx:87-100` only constrains
   later user input; it never moves the camera. Covered by a `test.fixme` in `house.spec.ts`.
2. **The pose is lost on a projection switch.** `src/house/components/Rig.tsx:52-81` — the
   capture/restore pair around `<CameraControls key={projection}>` (112-120) does not land.
   Measured: toggling "Orthographic" from the overview pose (`[19.15, 17, 20.05]` → target
   `[3.15, 3, 2.05]`) leaves the camera at the freshly-mounted orthographic camera's declared
   default, `[22, 16, 24]` → target `[0, 0, 0]`. Because `ViewToolbar.planFor`
   (`src/house/components/ViewToolbar.tsx:51-56`) calls `setProjection` and then
   `runtime.camera?.planFor()` synchronously, the fit also runs against the outgoing controls
   instance and is discarded — so entering the plan view from perspective (button or the `P`
   shortcut) lands on that same default pose, polar 63.8°. Same `test.fixme`.
3. **A saved colour never reaches the scene.** `src/house/hooks/useSceneSync.ts:73-85` — the colour
   subscription applies the plan once on mount and then only when `overrides` changes. On mount the
   GLBs have not arrived, so `index.surfaceMesh` is empty and `applyColors` touches nothing; unlike
   the visibility (55-69) and cutaway/explode (102-107) subscriptions, this one does not include
   `loadedAssetIds` in its selector, so nothing re-applies the plan once the meshes exist. Measured
   with one override persisted for `s-w-g-sauna-e--r-g-sauna`: a fresh load shows `materialHex`
   `#d9c3a5` (the manifest default) while the inspector's colour input shows the saved `#ff00ff`;
   changing it to `#00ffff` applies immediately, and "Reset room" applies the default. Re-picking the
   *same* colour does not help, because `setOverride`
   (`src/house/store/slices/color.ts:28-41`) returns `{}` when the value is unchanged. Covered by a
   `test.fixme` in `house-real.spec.ts` (it needs a registered `model_revision` to reproduce, which
   the fixture harness never has).

## Deviations from the design note's §13 expectations (not bugs)

- **§13.2 #4, `textures === 0`.** Measured 1, for both packages. The packages ship no textures (no
  image-based lighting, no maps in the GLBs); three allocates one internal empty texture for
  unassigned sampler slots. The suite asserts `≤ 1`.
- **§13.2 #12, "`programs` stays constant" on selection.** The *first* selection also creates the
  outline `LineSegments` (§3.4's non-colour selection signal), whose `LineBasicMaterial` is one new
  program: measured 2 → 3. Every selection change after that recompiles nothing, which is the
  invariant the suite asserts.
- **§13.2 #21, `frameStats().frames <= 1` when idle.** Not assertable as the hook is written: the
  sampler in `src/house/test/testHook.ts:80-90` is a self-scheduling `requestAnimationFrame` loop,
  which itself keeps the browser producing frames whether or not three.js draws anything (measured:
  ~121 rAF callbacks in a 2 s idle window, against 0 `invalidate()` calls). The suite asserts on
  `invalidateCount()`, which is the signal that actually separates "nothing asked to render" from
  "something is animating".
- **§13.2 #5, clicking `screenOf(roomAnchor(...))`.** That exact point is covered by the room's own
  label: the label overlay draws each room name as a real `<button>` centred on the anchor with
  `pointer-events: auto` (`src/house/components/LabelOverlay.tsx:113-131`). A click there selects
  the room through the DOM without raycasting, and it also re-frames the camera. The suite picks
  geometrically at the anchor and clicks a nearby bare-canvas point over the same floor.

## Not verified / limitations
- Live Home Assistant delivery to phones: requires `HA_TOKEN` on the server; until then tests use the fake HA server.
- Deployment on the Mac mini: scripts are tested locally; the first real install happens with the owner.
- **Frame times above are a regression tripwire, not an acceptance result.** They come from a
  software rasteriser (SwiftShader) in headless Chromium, where the orbit p95 of 22.6 ms says more
  about the rasteriser than about the viewer. The acceptance numbers have to come from a manual run
  in a real browser on the target Mac mini.
- **Frame-rate figures cannot be read from a hidden preview pane.** The browser stops servicing
  `requestAnimationFrame` for a page that is not visible, so an in-app preview pane that is hidden
  (or a background tab) pauses the render loop entirely: `frameStats()` reports whatever it sampled
  before the pane went away, and an idle-frame or orbit measurement taken there is meaningless. Every
  number in this file was measured in a foreground headless page driven by Playwright.
- Equipment placement, infrastructure routes and the Home Assistant marker layer are unverified in a
  browser: the e2e bootstrap seeds no equipment and registers no model revision, so nothing in those
  layers has data to render. See the skips listed above.
- `test-results/` is cleared at the start of every Playwright run, so the screenshots and
  `house-measurements.json` always belong to the most recent run — they cannot both be present at
  once unless the two specs run in the same invocation.
