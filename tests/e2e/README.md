# End-to-end tests (Playwright)

`playwright.config.ts` starts `tests/e2e/start-server.ts`, which:
1. creates a temporary `VH_DATA_DIR`, runs migrations, seeds the two household users with known
   passwords and installs the synthetic fixture model (`tests/fixtures/model/house-model`);
2. runs `next build` once (cached under `.next-e2e`) and `next start` on port 3011 with
   `NEXT_PUBLIC_VH_TEST_HOOK=1` so `window.__vh` is available for viewer assertions.

Projects: `desktop` (Chromium 1600×1000), `phone` (iPhone 14 Chromium), `webkit` (desktop Safari engine) and `phone-webkit` (iPhone 14 Safari engine). Install engines with `pnpm exec playwright install chromium webkit`.
Real household data is never used by default; the real model package is exercised only by
`house-real.spec.ts`, and only when you point it at a copy yourself (below).

## Specs

| Spec | Model | Projects | What it covers |
|---|---|---|---|
| `auth.spec.ts` | — | both | Sign-in, private files, session revocation, deep links, open redirect. |
| `house.spec.ts` | fixture | desktop | Load integrity, selection + URL sync, click picking, colour isolation, visibility and views, explode offsets, on-demand rendering, asset auth/ETag, mount→unmount→mount disposal. |
| `house-real.spec.ts` | **real**, opt-in | desktop | The same numeric checks against the household's own package, plus load timing and orbit frame times. Writes `test-results/house-measurements.json`. |
| `screenshots.spec.ts` | fixture | desktop + phone | The `docs/design-notes/house-workspace-3d.md` §13.4 capture list, into `test-results/screenshots/`. Entries needing a placement, a route, a garage/structure asset, a Home Assistant connection or a seeded task are `test.skip` with the reason. |

`tests/e2e/helpers/house.ts` holds everything the house specs share: `openHouse`/`openHouseSession`,
the typed `vh(page)` wrappers over `window.__vh`, `measureLoad`, `idleFrames`,
`waitForStableFrames`, `orbitScripted` and the colour/diff helpers.

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

- **No equipment, no placements, no routes.** The bootstrap seeds two users and the model package,
  and it does not call `registerRevision`, so `listPlacements()`/`listRoutes()` answer
  `NotPersistedError`. Every check that needs a placement — edit mode, the save-payload invariant,
  the equipment layer, the route editors, the Home Assistant marker styling — is `test.skip` with
  that reason rather than faked. `house-real.spec.ts` gets a revision anyway, by importing through
  `vh-admin` (above); the fixture harness would need `start-server.ts` to do the same, plus one
  seeded equipment asset, before those skips could become real tests.
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
