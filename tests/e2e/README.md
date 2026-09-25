# End-to-end tests (Playwright)

`playwright.config.ts` starts `tests/e2e/start-server.ts`, which:
1. creates a temporary `VH_DATA_DIR`, runs migrations, seeds the two household users with known
   passwords and installs the synthetic fixture model (`tests/fixtures/model/house-model`);
2. runs `next build` once (cached under `.next-e2e`) and `next start` on port 3011 with
   `NEXT_PUBLIC_VH_TEST_HOOK=1` so `window.__vh` is available for viewer assertions.

The server binds `127.0.0.1`, but the app's base URL (and every test's `baseURL`) is
`http://localhost:3011`: the passkey RP ID is the base URL's hostname, and WebAuthn rejects an IP
address as an RP ID. Only the `webServer` health probe uses `127.0.0.1` directly.

Projects: `desktop` (Chromium 1600×1000), `phone` (iPhone 14 Chromium), `webkit` (desktop Safari engine) and `phone-webkit` (iPhone 14 Safari engine). Install engines with `pnpm exec playwright install chromium webkit`.
Real household data is never used by default; the real model package is exercised only by
`house-real.spec.ts`, and only when you point it at a copy yourself (below).

## Specs

| Spec | Model | Projects | What it covers |
|---|---|---|---|
| `auth.spec.ts` | — | all four | Sign-in, private files, session revocation, deep links, open redirect. |
| `passkey.spec.ts` | — | Chromium (`desktop`, `phone`) | Register a passkey in Security, conditional-UI sign-in, "Sign in with passkey", rename, delete, refusal after delete. Uses the CDP virtual authenticator, which WebKit lacks. |
| `house.spec.ts` | fixture | desktop | Load integrity, selection + URL sync, click picking, colour isolation, visibility and views, explode offsets, on-demand rendering, asset auth/ETag, mount→unmount→mount disposal. |
| `house-real.spec.ts` | **real**, opt-in | desktop | The same numeric checks against the household's own package, plus load timing and orbit frame times. Writes `test-results/house-measurements.json`. |
| `screenshots.spec.ts` | fixture | desktop + phone | The `docs/design-notes/house-workspace-3d.md` §13.4 capture list, into `test-results/screenshots/`. Entries needing a placement, a route, a garage/structure asset, a Home Assistant connection or a seeded task are `test.skip` with the reason. |

`tests/e2e/helpers/house.ts` holds everything the house specs share: `openHouse`/`openHouseSession`,
the typed `vh(page)` wrappers over `window.__vh`, `measureLoad`, `idleFrames`,
`waitForStableFrames`, `orbitScripted` and the colour/diff helpers.

## Environment-gated specs

`pnpm test:e2e` is expected to be green on the Mac mini with nothing set. A few checks depend on
what the test browser can do rather than on the app; they probe for the capability and skip with a
grep-able reason instead of failing, and each has an opt-in to assert anyway:

| Gate | Where | Skips when | Reason text (grep for it) | Force it |
|---|---|---|---|---|
| WebGL 2 | every House spec, via `openHouse()` / `openHouseSession()` (`requireWebGL()` in `helpers/house.ts`) | the browser cannot create a `webgl2` context (a container with no GPU and no software rasteriser) | `needs WebGL 2 in the test browser` | `VH_E2E_REQUIRE_WEBGL=1` fails instead of skipping |
| Offline service-worker navigation | `pwa.spec.ts` › "offline, a household page falls back…" | on WebKit, `page.goto()` under `context.setOffline(true)` fails with "WebKit encountered an internal error" (Playwright's WebKit harness, not Safari); the navigation itself is the probe | `needs service-worker offline navigation` | `VH_E2E_WEBKIT_OFFLINE=1` asserts on WebKit too |
| Real model package | `house-real.spec.ts` | `VH_REAL_MODEL_DIR` is unset | (described below) | set `VH_REAL_MODEL_DIR` |
| Browser engines | `playwright.config.ts` projects; route-audit's WebKit phone audit | `VH_E2E_BROWSERS` does not list the engine | `browser engine excluded by VH_E2E_BROWSERS` | `VH_E2E_BROWSERS=all` (the default) |

Headless Chromium and Playwright's WebKit both have WebGL 2 on the Mac mini, so no House spec is
skipped there for rendering. Nothing needs a Home Assistant connection: the harness blanks
`HA_URL`/`HA_TOKEN`, seeds synthetic registry rows (one set per project, `E2E_HA_FIXTURE_KEYS` in
`fixtures.ts`) and drives live state through `helpers/liveHa.ts`'s synthetic event stream.

The remaining skips are by design, not environment: desktop-only interactions skip the two phone
projects (`project.name.includes("phone")`), the passkey spec needs Chromium's CDP virtual
authenticator, and `screenshots.spec.ts` captures only on `desktop`/`phone` with the §13.4 entries
it cannot stage marked individually.

### Rules the suite depends on

- **Every House spec signs in from its own client address.** `openHouse()` gives the page a random
  `x-forwarded-for`, so specs using Playwright's `page` fixture no longer share one 5-per-minute
  sign-in bucket (they used to hit "Too many attempts, wait a minute" when several ran back to back).
- **No service worker in the House specs.** Once `/sw.js` controls a WebKit page, `page.route()`
  stops seeing the page's API requests, so synthetic `/placements`, `/controls` or `/furnishings`
  responses were silently replaced by real, empty ones. `openHouse()` refuses registration before
  the first navigation; `pwa.spec.ts` is where the worker is tested.
- **View settings is a popover over the canvas.** Close it (`closeViewSettings()`) before a
  scripted drag or an element screenshot of the canvas, and reopen it (`openViewSection()`) after
  clicking anything outside it — an outside click dismisses it. `openViewSection()` waits for a
  dismissed popover to finish animating out, because deciding against that ghost made the next click
  wait forever.
- **Start drags on bare canvas.** Room labels are buttons and the view bar wraps at 1280 px, so a
  hard-coded start point can land on a control; `bareCanvasPoint()` finds an uncovered point.
- **A timed-out test leaks its rows.** Teardown closes the context before a `finally` can delete
  what the test created, and the suite shares one database; later specs then miss a seeded
  "Not placed yet" asset or see extra geometry. Fix the first failure in a run before the rest.

### Running on a shared 16 GB home server

Playwright's WebKit with WebGL is by far the heaviest part of the suite. On a 16 GB host that also
runs other services, WebKit runs pushed swap from 0 to 8 GB within an hour and took the host down,
so run **Chromium only** there, one worker (the config's default), serialised with any other heavy
job:

```bash
VH_E2E_BROWSERS=chromium pnpm test:e2e      # desktop + phone projects; no WebKit is launched
```

`VH_E2E_BROWSERS` is a comma-separated list of `chromium` and/or `webkit` (default `all`: every
project). It drops the projects of engines not listed, and `route-audit.spec.ts`'s
`webkit-phone` layout audit — which launches its own WebKit browser inside any project — skips with
`browser engine excluded by VH_E2E_BROWSERS`. Run the WebKit projects on a machine with memory to
spare (`VH_E2E_BROWSERS=webkit`, or the default).

Headless Chromium renders WebGL with SwiftShader (software), so shader-heavy specs are slower there
than on WebKit's GPU path; `isSoftwareWebGL()` lets a spec size its budget from the renderer instead
of the project name.

## Running

The harness uses `.next-e2e` by default and permits the installed service checkout only with that
exact separate build directory (not a symlink). It never overwrites production `.next`. Stop every
synthetic server using `.next-e2e` before rebuilding it; use different ports and temporary data
directories for independent suites, then `VH_E2E_SKIP_BUILD=1` to reuse the verified build.

```bash
pnpm exec playwright test                                     # everything, both projects
pnpm exec playwright test tests/e2e/house.spec.ts --project=desktop
pnpm exec playwright test tests/e2e/screenshots.spec.ts       # desktop + phone captures
pnpm exec playwright test tests/e2e/auth.spec.ts --project=desktop   # one project at a time — see below
```

The full sequence behind the numbers in `docs/verification.md`, in the order that leaves both
artefacts on disk:

```bash
pnpm exec playwright test tests/e2e/house.spec.ts --project=desktop          # builds .next once
VH_E2E_SKIP_BUILD=1 VH_REAL_MODEL_DIR="$HOME/virtual-home-data/model-incoming/house-model" \
  pnpm exec playwright test tests/e2e/house-real.spec.ts --project=desktop   # → house-measurements.json
VH_E2E_SKIP_BUILD=1 pnpm exec playwright test tests/e2e/screenshots.spec.ts \
  --output=test-results/pw-artifacts                                         # → screenshots/*.png
```

`--output=` on the later runs is what keeps them: `test-results/` is Playwright's `outputDir` and is
wiped at the start of every run, so without it the screenshot run deletes
`test-results/house-measurements.json` (and vice versa). Pointing `outputDir` at a subdirectory moves
the wipe there.

Every house test opens its **own browser context**. Sign-in is rate limited to 5 attempts per
minute per client address, so each context claims its own `x-forwarded-for` (see `fixtures.ts`), and
a fresh context is also a fresh store — no test can inherit another's colour overrides.
`browser.newContext()` inherits nothing from the config, so the helper copies the running project's
device shape across explicitly; without that the phone project would silently run at desktop size
and the workspace would never take its `PhoneHouse` branch.

### Build behaviour

`start-server.ts` rebuilds on every run unless `VH_E2E_SKIP_BUILD=1` is set **and** it can see an
existing build:

```bash
VH_E2E_SKIP_BUILD=1 pnpm exec playwright test tests/e2e/house.spec.ts --project=desktop
```

`VH_E2E_SKIP_BUILD=1` reuses whatever is already in `.next` (the bootstrap only checks that
`.next/BUILD_ID` exists). That is only safe when `.next` is current *and* was produced with
`NEXT_PUBLIC_VH_TEST_HOOK=1` — public env vars are inlined at build time, so a build made without it
has no `window.__vh` and every house test fails at `waitForHook`. Use it for the second and later
runs of a session, once one full run has produced the build; use a plain run (which rebuilds) after
any change to `src/`. To make a reusable build by hand:

```bash
NEXT_PUBLIC_VH_TEST_HOOK=1 pnpm exec next build
```

`VH_E2E_KEEP_DATA_DIR=1` leaves the temporary data directory behind for inspection.

### The real model package

`house-real.spec.ts` skips entirely unless `VH_REAL_MODEL_DIR` names a directory containing
`model.json`:

```bash
VH_REAL_MODEL_DIR="$HOME/virtual-home-data/model-incoming/house-model" \
  pnpm exec playwright test tests/e2e/house-real.spec.ts --project=desktop
```

Nothing is copied into the repository. The spec finds the bootstrap's live temporary data directory
the same way the bootstrap's own sweeper does — a `vh-e2e-*` directory whose `.bootstrap-pid` names
a living process — and then shells out to the household's own import command against that directory:

```bash
VH_DATA_DIR=<harness dir> pnpm exec tsx scripts/vh-admin.ts model-import <VH_REAL_MODEL_DIR>
```

That is the real path — `validatePackageDir` → `installPackage` → **`registerRevision`**
(`scripts/vh-admin.ts:264-277`) — and the revision registration is the part that matters: the
bootstrap's own `installFixtureModel()` calls `installPackage` *only*, so on the plain fixture
harness nothing that needs a `model_revision` persists. Going through `vh-admin` is what gives this
spec real colour persistence (and is what makes the saved-colour bug reproducible here and nowhere
else). It runs as a child process rather than an in-process import because `src/server/**` is
written for Next's `react-server` condition.

The running server picks the new `current.json` up on its next re-check (`getCurrentPackage` stats
the pointer at most every 10 s), and `afterAll` re-installs the fixture so a later spec against the
same reused server is not looking at the real house, then writes
`test-results/house-measurements.json`. The temp data directory is deleted when the bootstrap exits,
so no household geometry, database row or render survives the run.

## Notes and known gaps

- **Seeded data.** The bootstrap registers the fixture revision and seeds the unplaced equipment in
  `E2E_PLACEABLE_NAMES` plus synthetic Home Assistant registry rows per project. Specs that place
  one of those assets delete the placement afterwards, which returns it to "Not placed yet" for the
  next spec (several specs share a name, so a leaked placement cascades — see the rule above).
- **Screenshots are reviewed by eye.** No pixel comparison: a software-rasterised headless render is
  not the target machine's GPU. Each capture is still taken only after `__vh.settled` and 250 ms of
  unchanged `invalidateCount()`, so `frameloop="demand"` cannot yield a half-drawn frame.
- **`frameStats()` cannot prove an idle demand loop.** The hook's own sampler is a self-scheduling
  `requestAnimationFrame` loop, which keeps the browser producing frames whether or not three.js
  renders anything; `frames` therefore counts browser animation frames, not draws. The idle test
  asserts on `invalidateCount()`, which is the signal that actually distinguishes "nothing asked to
  render" from "something is animating".
- **A fatal package has no test hook.** `WorkspaceBody` short-circuits to `<SetupState>` before the
  canvas mounts, so `window.__vh` never exists in that state. The invalid-manifest capture asserts
  on the rendered panel instead of through the hook.
- **A room's anchor is covered by its own label.** The label overlay draws each room name as a real
  `<button>` centred on `roomAnchor(roomId)` with `pointer-events: auto`, so a click at exactly
  `screenOf(roomAnchor(…))` selects the room through the DOM rather than through the 3D pick (and
  re-frames the camera). `findCanvasPick()` in the helper finds a nearby bare-canvas point over the
  same surface; use it whenever a test needs a real click to go through the raycaster.
- **`test-results/` is wiped at the start of every run.** It is Playwright's `outputDir`, so the
  screenshots and `house-measurements.json` belong to whichever spec ran last unless you move the
  wipe with `--output=<dir>` — see the sequence under **Running**.
- **Every context claims a random `x-forwarded-for`** (`fixtures.ts`'s `nextClientIp()`, which
  `houseClientIp()` now simply calls). Not a counter: it restarts with each Playwright worker
  process — one per project — so the second project, or a rerun a minute later against a reused
  server, would hand out the same addresses and inherit their rate-limit buckets.
- **Known app bugs the suite records rather than works around** (plan-view camera, pose loss on a
  projection switch, saved colours never reaching the scene) are written up in `docs/verification.md`
  and carried as `test.fixme` with the same notes. To re-verify one, flip its `test.fixme` to `test`,
  run it, read the failure, and flip it back — that is how the 2026-09-08 figures in
  `docs/verification.md` (polar 63.83°; `#d9c3a5` in the scene against `#ff00ff` in the inspector)
  were taken.
- **`auth.spec.ts` passes 16/16 with both projects in one invocation** (fixed 2026-09-08). It used
  to fail `changing the password retires the old one` on `phone`, because `nextClientIp()` was a
  per-process counter and the second project reused the first's addresses — and with them its
  `/change-password` rate-limit bucket (3 per 10 s per address + path). Random addresses per context
  fixed it; `docs/verification.md` carries the write-up. What still fails, by design, is
  `--workers=2`: the two projects then run in parallel against one database and one pair of seeded
  users, and "sign out others" in one project ends the other's session. Hence `workers: 1`.
- **The scripted orbit is ~25 key steps in 2 s, not §13.3's 60.** Each Playwright key press costs
  ~80 ms against a rendering page, so the sampled p95 blends orbit frames with idle rAF cadence and
  is a floor on the real per-frame cost. `orbitScripted()` uses `page.keyboard.press()` after a
  single `focus()` for this reason — `locator.press()` re-resolves and re-focuses every call, and
  managed only 11 steps.
