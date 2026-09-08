# End-to-end tests (Playwright)

`playwright.config.ts` starts `tests/e2e/start-server.ts`, which:
1. creates a temporary `VH_DATA_DIR`, runs migrations, seeds the two household users with known
   passwords and installs the synthetic fixture model (`tests/fixtures/model/house-model`);
2. runs `next build` once (cached under `.next`) and `next start` on port 3011 with
   `NEXT_PUBLIC_VH_TEST_HOOK=1` so `window.__vh` is available for viewer assertions.

Projects: `desktop` (Chromium 1600×1000) and `phone` (iPhone 14 viewport, Chromium engine).
Real household data is never used by default; the real model package is exercised only by
`house-real.spec.ts`, and only when you point it at a copy yourself (below).

## Specs

| Spec | Model | Projects | What it covers |
|---|---|---|---|
| `auth.spec.ts` | — | both | Sign-in, private files, session revocation, deep links, open redirect. |
| `house.spec.ts` | fixture | desktop | Load integrity, selection + URL sync, click picking, colour isolation, visibility and views, explode offsets, on-demand rendering, asset auth/ETag, mount→unmount→mount disposal. |
| `house-real.spec.ts` | **real**, opt-in | desktop | The same numeric checks against the household's own package, plus load timing and orbit frame times. Writes `test-results/house-measurements.json`. |
| `screenshots.spec.ts` | fixture | desktop + phone | The `docs/design-notes/house-workspace-3d.md` §13.4 capture list, into `test-results/screenshots/`. |

`tests/e2e/helpers/house.ts` holds everything the house specs share: `openHouse`/`openHouseSession`,
the typed `vh(page)` wrappers over `window.__vh`, `measureLoad`, `idleFrames`,
`waitForStableFrames`, `orbitScripted` and the colour/diff helpers.

## Running

```bash
pnpm exec playwright test                                     # everything, both projects
pnpm exec playwright test tests/e2e/house.spec.ts --project=desktop
pnpm exec playwright test tests/e2e/screenshots.spec.ts       # desktop + phone captures
```

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

That is only safe when `.next` is current *and* was produced with `NEXT_PUBLIC_VH_TEST_HOOK=1` —
public env vars are inlined at build time, so a build made without it has no `window.__vh` and
every house test fails at `waitForHook`. To make one by hand:

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
a living process — then installs the package through the app's real `installPackage()`. The running
server picks the new `current.json` up on its next re-check (`getCurrentPackage` stats the pointer at
most every 10 s), and `afterAll` re-installs the fixture so a later spec against the same reused
server is not looking at the real house. The temp data directory is deleted when the bootstrap exits.

## Notes and known gaps

- **No equipment, no placements, no routes.** The bootstrap seeds two users and the model package,
  and it does not call `registerRevision`, so `listPlacements()`/`listRoutes()` answer
  `NotPersistedError`. Every check that needs a placement — edit mode, the save-payload invariant,
  the equipment layer, the route editors, the Home Assistant marker styling — is `test.skip` with
  that reason rather than faked.
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
