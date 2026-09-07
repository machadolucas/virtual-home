I have the full package. Notable: I found several facts that change specific design details, including two surfaces that resolve to mesh-less nodes and cross-asset floor nodes.

Here is the design.

---

# Virtual-Home — 3D "House" workspace: implementation design

Target stack: Next.js 16 App Router, React 19.2, R3F 9.7, Drei 10.7, Three.js 0.185, zustand 5, WebGL2 baseline.
Model package: `house-model/` (schemaVersion `1.0`, modelId `example-house-1`), treated as immutable input.

## 0. Verified facts about the actual package (measured, not assumed)

I parsed `model.json` and the GLB JSON chunks directly. These are the load-bearing facts the implementation may rely on, plus the ones that contradict a naive reading of the brief.

| Fact | Value / consequence |
|---|---|
| Node transforms | **Zero** nodes carry `translation`/`rotation`/`scale`/`matrix` in any default asset. World = local = site frame. |
| Material sharing | **None.** Per asset, `#materials == #meshes` (house-ground 172/172, upper 105/105, garage-shell 46/46, …). Direct `mesh.material.color` mutation is safe. Still keep a load-time audit + clone fallback. |
| Geometry sharing | None. `accessors == 3·meshes + 2` (house-ground 515 = 171×3 + 2). Expect ~410 `BufferGeometry` after full default load. |
| Materials | All `MeshStandardMaterial`, `metalness 0`, `roughness 0.9`, `emissiveFactor [0,0,0]`, **`doubleSided: true` → `side: THREE.DoubleSide`**, `alphaMode OPAQUE`, **no textures, no glTF extensions**. |
| `defaultColor` ↔ `baseColorFactor` | `defaultColor` is the sRGB encoding of the linear `baseColorFactor` (0.69387 lin → 0xd9; manifest says `#d9c3a5`). With three's default `ColorManagement.enabled`, `material.color.set('#d9c3a5')` reproduces the shipped value. **This is a testable invariant** (§3, §13). |
| Node naming | Mesh node name **is** the `surfaceId`; element group node name **is** the `elementId`; floor node name is the `floorId`. No duplicate names within an asset. Every `surfaces[].nodeRefs[i].nodeName` resolves. |
| `nodeRefs` cardinality | Every one of the 405 surfaces has **exactly one** `nodeRef`. Code should still loop (schema allows N). |
| **Mesh-less surface nodes** | `garage-shell` contains `s-e-f-garage-ext-out-0-upper` and `s-e-f-garage-ext-out-2-upper` as **empty `Object3D`s with no mesh and no children** (degenerate timber band — garage brick runs to the wall top). `nodes.get(name)` returns an object with **no `.material`**. Every colour/highlight/visibility path must tolerate this. Neither has a `roomId`, so room colouring is unaffected. |
| Hierarchy depth is **not** uniform | `house-ground`/`house-upper`/`garage-shell`: root → `b-*` → `f-*` → `e-*` → surface (depth 4). `house-roof`/`house-details`/`house-structure`/`garage-roof`: root → `b-*` → `e-*` → surface (depth 3). `terrain`: root → **`site`** → `e-*` → surface (no `buildingId` node). |
| **Floor nodes appear in more than one asset** | `f-upper` exists in `house-upper`, **`house-roof`** (child: `e-dormer-bath`) and **`house-structure`**. `f-ground` in `house-ground` and `house-structure`. `f-garage` in `garage-shell` and **`garage-structure`**. Floor isolation/explode must index **all** loaded assets by floor node name. |
| **Elements outside any floor node** | `house-ground/b-house` has `e-g-fire-door-landing`, `e-g-bay-door-landing`, `e-outdoor-fireplace` as siblings of `f-ground`. Hiding node `f-ground` does **not** hide the whole ground asset. |
| Edges nodes | `edges-<assetId>` is a **direct child of the asset root** (sibling of `b-*`/`site`), primitive `mode: 1` (LINES) → `THREE.LineSegments` + `LineBasicMaterial`, one per asset, with its own material. It is **one object for the whole asset** and cannot be split per floor. |
| Room surface filter | Room-facing surfaces = `roomId === room.id && kind ∈ {floor, wall, ceiling}`. Cross-tab proof: room-owning surfaces are only `(floor,–)×24`, `(wall,–)×111`, `(wall,dormer-front-wall)×1`, `(ceiling,–)×24`, `(ceiling,dormer-ceiling)×1`, `(other,–)×4`. **Do not exclude by role** — `dormer-front-wall` and `dormer-ceiling` are legitimate room surfaces, and every excluded role (`reveal`, `door-leaf`, `railing`, `step`, `wall-top`, `plinth`, `exterior`, `exterior-ledge`) already has `kind: "other"` or no `roomId`. Filtering by `kind` alone is exactly correct. |
| Room `kind` enum | Data uses `closet` (`r-g-closet-entrance`) in addition to `room`/`attic`/`void`. The brief said three; the schema and data say four. Zod must accept all four. |
| `certainty` enum | Schema allows `measured|derived|inferred|unknown`; the data currently uses only `measured` (116) / `inferred` (54). Accept all four. |
| Draw calls / bytes | Full default load: **410 draw objects** (401 meshes + 9 edge LineSegments), 21 258 tris, **3.09 MB**. Shell-only tier: **349 objects, 3 350 tris, 900 kB**. (The brief's "~330 draw calls" was measured on an earlier revision.) |
| Living-room datum | `r-g-living.floorElevation = -0.3`. Framing/snapping must read `room.floorElevation`, never `floor.elevation`. |
| Programs | Expect 2–3 GLSL programs total (standard/doubleSide/2 clip planes; line basic/2 clip planes). Colour and emissive changes are uniform updates — **no recompiles**. |

---

## 1. File / module structure

```
src/house/
  index.ts                        # public surface of the viewer module

  model/                          # PURE. no three, no react. 100% unit-testable.
    schema.ts                     # zod mirror of manifest.schema.json
    crossref.ts                   # cross-reference checks -> ManifestDiagnostics
    types.ts                      # z.infer types + branded ids (SurfaceId, RoomId, …)
    manifestIndex.ts              # ManifestIndex: id -> record Maps, room->surfaces, floor->rooms
    geometry2d.ts                 # ring bbox / area / centroid / point-in-ring / label anchor
    colorPlan.ts                  # planRoomColors(), planAllSurfaces()  (pure)
    visibilityPlan.ts             # computeVisibility()                  (pure)
    explodeGroups.ts              # explodeGroupOf(), EXPLODE_POLICY table (pure)
    framingBoxes.ts               # roomBox/floorBox/buildingBox/propertyBox from manifest
    reconcile.ts                  # persisted ids vs manifest -> orphan report

  scene/                          # imperative three.js. no react.
    SceneIndex.ts                 # the Maps (§1.2); built once from loaded roots
    loadAssets.ts                 # tiered GLTFLoader orchestration + AbortController
    materialAudit.ts              # shared-material guard + clone fallback + originals
    clipGroups.ts                 # per-explode-group Plane pairs, assigned at load
    applyColors.ts                # NodeColorPlan -> scene
    applyVisibility.ts            # VisibilityPlan -> scene (+ rebuild pickables)
    highlight.ts                  # emissive tint + EdgesGeometry outline for selection
    picker.ts                     # Picker: cached pickables, clip filter, touch multi-ray
    framing.ts                    # Box3 builders incl. equipment/route
    wallFrame.ts                  # wall surface -> {origin, u, v, n, uRange, vRange}
    markers.ts                    # per-floor InstancedMesh manager (equipment anchors)
    routes.ts                     # per-style batched LineSegments / TubeGeometry
    explode.ts                    # apply explode offsets to shell + overlay groups
    dispose.ts                    # full teardown + assertions

  store/
    createHouseStore.ts           # zustand 5, slices, subscribeWithSelector
    slices/{model,selection,view,color,layer,edit,route}.ts
    haStore.ts                    # zustand/vanilla, keyed by entityId
    haSse.ts                      # EventSource client, backoff, coalescing
    urlSync.ts                    # ?sel= / ?floor= / ?view= via history.replaceState

  hooks/
    useHouseStore.ts              # typed hook + useShallow re-export
    useSceneIndex.ts              # non-reactive context accessor
    useSceneSync.ts               # store.subscribe -> imperative scene updates
    useCameraApi.ts               # fitRoom/fitFloor/overview/frameSelection
    useDemandFrames.ts            # invalidate() pump for camera-controls
    useReducedMotion.ts
    useKeyboardShortcuts.ts
    useLabelProjection.ts

  components/
    HouseWorkspace.tsx            # 'use client' shell: tree | canvas | inspector
    HouseCanvasLazy.tsx           # next/dynamic(ssr:false) boundary
    HouseCanvas.tsx               # <Canvas> + providers + overlay container
    SceneRoot.tsx                 # mounts imperative subtree, runs useSceneSync
    Rig.tsx                       # Perspective|Orthographic camera + CameraControls
    Lighting.tsx
    MarkerLayer.tsx               # InstancedMesh per floor group
    RouteLayer.tsx
    LabelOverlay.tsx              # DOM overlay, sibling of <Canvas>
    ViewToolbar.tsx  CutawayControl.tsx  ExplodeControl.tsx
    PropertyTree.tsx
    inspector/{RoomInspector,SurfaceInspector,ElementInspector,EquipmentInspector,RouteInspector}.tsx
    edit/{PlacementEditor,NumericPlacementFields,SnapIndicator,UndoBar}.tsx
    routeEditor/{PlanEditor2D,WallElevationEditor2D,RoutePath3D}.tsx
    phone/{LocateSheet,PhoneHouse}.tsx
    SetupState.tsx                # invalid/missing assets + unresolved issues
    HouseErrorBoundary.tsx

  test/testHook.ts                # window.__vh (gated by env flag)
```

Server side (outside `src/house/`, but part of this design):

```
src/server/house-model/package.ts          # resolve dir, stat, sha256, pkgHash cache
src/app/api/house-model/[modelId]/manifest/route.ts
src/app/api/house-model/[modelId]/assets/[assetId]/route.ts
src/app/api/house-model/[modelId]/status/route.ts
src/app/(app)/house/page.tsx               # server component -> <HouseWorkspace/>
```

### 1.1 Validation (zod + cross-references)

`model/schema.ts` mirrors `manifest.schema.json` field-for-field. Root and record objects use **loose** objects (`z.looseObject` in zod 4, `.passthrough()` in zod 3) because the JSON Schema sets `additionalProperties: true` — a future r18 revision must not fail validation.

```ts
const Id     = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Vec3   = z.tuple([z.number(), z.number(), z.number()]);
const Vec2   = z.tuple([z.number(), z.number()]);
const Ring   = z.array(Vec2).min(3);
const Color  = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Certainty = z.enum(['measured', 'derived', 'inferred', 'unknown']);
const NodeRef = z.object({ assetId: Id, nodeName: z.string().min(1) });

const Surface = z.looseObject({
  id: Id, kind: z.enum(['floor', 'wall', 'ceiling', 'other']),
  roomId: Id.optional(), elementId: Id.optional(),
  nodeRefs: z.array(NodeRef).min(1),
  defaultColor: Color, role: z.string().optional(),
});

const Room = z.looseObject({
  id: Id, floorId: Id, buildingId: Id.optional(),
  name: z.string(), nameFi: z.string().nullable().optional(),
  aliases: z.array(z.string()).default([]),
  kind: z.enum(['room', 'attic', 'void', 'closet']).optional(),   // 'closet' IS used
  floorElevation: z.number(), ceilingHeight: z.number().optional(),
  certainty: Certainty.optional(), area: z.number().optional(), color: Color.optional(),
  footprint: z.object({ outer: Ring, holes: z.array(Ring).default([]) }),
  surfaceIds: z.array(Id).default([]),
});
// … Building, Floor, Asset, Element, Source, Issue similarly
export const Manifest = z.looseObject({
  schemaVersion: z.literal('1.0'), modelId: Id, /* … */
});
```

`model/crossref.ts` returns diagnostics rather than throwing, so a partially broken package still yields a useful setup state:

```ts
export type Severity = 'error' | 'warning';
export interface Diagnostic { severity: Severity; code: string; message: string; ids?: string[] }

export function crossCheck(m: Manifest): Diagnostic[] {
  // errors (block interactive use)
  //  E_FLOOR_BUILDING     floors[].buildingId ∈ buildings
  //  E_ROOM_FLOOR         rooms[].floorId ∈ floors ; rooms[].buildingId matches floor's building
  //  E_ASSET_PATH         assets[].path matches ^assets/[A-Za-z0-9._-]+\.glb$
  //  E_NODEREF_ASSET      every nodeRefs[].assetId ∈ assets
  //  E_NODEREF_DUP        (assetId, nodeName) unique across ALL surfaces AND elements
  //  E_SURFACE_ROOM       surfaces[].roomId ∈ rooms   (when present)
  //  E_SURFACE_ELEMENT    surfaces[].elementId ∈ elements
  //  E_ROOM_SURFACE       rooms[].surfaceIds ⊆ surfaces
  //  E_ELEMENT_SURFACE    elements[].surfaceIds ⊆ surfaces
  //  E_FLOOR_ASSET        floors[].assetIds ∪ scanAssetIds ⊆ assets
  //  E_BOUNDS             bounds.min[i] < bounds.max[i]
  // warnings (informational, shown in setup state)
  //  W_ROOM_NO_FLOOR_SURF room has no kind:'floor' surface   (expected for kind:'void' → downgrade to info)
  //  W_ROOM_NO_CEILING    room has no kind:'ceiling' surface
  //  W_ORPHAN_SURFACE     surface with roomId not listed in that room's surfaceIds
  //  W_ASSET_UNREFERENCED asset referenced by no surface/element
}
```

**Asset existence is checked server-side only** (the client cannot `fs.stat`): `/api/house-model/[modelId]/status` returns `{ pkgHash, assets: [{ id, path, present, bytes, sha256 }], diagnostics }`. The client merges that with its own zod + crossref result. Runs of the same checks live in a Node test (`model.spec.ts`) against the real package so a package swap fails CI, not the browser.

`model/reconcile.ts` handles the "model correction" requirement: given `{ modelId, pkgHash }` plus the set of `surfaceId`/`roomId`/`elementId`/`floorId` referenced by persisted overrides, placements, routes and annotations, it returns `{ unknownSurfaceIds, unknownRoomIds, …, coordinateSystemChanged }`. Any non-empty result opens an explicit reconciliation screen; nothing is auto-migrated.

### 1.2 Scene graph indexing

`SceneIndex` is built once, after each asset finishes loading (incrementally), and lives **outside React state** — in a `useRef` exposed through a non-reactive context.

```ts
export interface AssetEntry {
  id: AssetId;
  root: THREE.Group;                    // gltf.scene, added directly to scene
  nodes: Map<string, THREE.Object3D>;   // name -> object (all levels, incl. edges + mesh-less)
  meshes: THREE.Mesh[];                 // surface meshes only
  edges: THREE.LineSegments | null;     // node `edges-<assetId>`
  disposables: { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material> };
}

export interface SceneIndex {
  assets: Map<AssetId, AssetEntry>;

  surfaceNode: Map<SurfaceId, THREE.Object3D>;        // 405 entries; 2 have no .material
  surfaceMesh: Map<SurfaceId, THREE.Mesh>;            // 403 entries (mesh-less excluded)
  elementGroup: Map<ElementId, THREE.Object3D[]>;     // element node may exist in >1 asset
  floorNodes: Map<FloorId, THREE.Object3D[]>;         // f-upper -> [house-upper, house-roof, house-structure]
  buildingNodes: Map<BuildingId, THREE.Object3D[]>;
  roomSurfaces: Map<RoomId, SurfaceId[]>;             // from manifest, kind-filtered variants cached
  meshSurfaceId: WeakMap<THREE.Object3D, SurfaceId>;  // reverse lookup for picking

  originalColor: Map<SurfaceId, number>;              // hex int, from material at load
  clipGroupOf: Map<SurfaceId, ExplodeGroup>;          // which Plane pair the material uses

  overlay: {
    floorGroups: Map<ExplodeGroup, THREE.Group>;      // app-owned; hosts markers/routes/anchors
    markerMeshes: Map<ExplodeGroup, THREE.InstancedMesh>;
  };

  pickables: THREE.Object3D[];                        // rebuilt by applyVisibility
}
```

`elementGroup` is a list because `e-*` node names recur across assets in principle; `floorNodes` is a list because they demonstrably do (verified above). Everything is keyed by manifest IDs — never by node index, array position or display name.

Picking uses `meshSurfaceId` first, falling back to `object.userData.surfaceId` and then walking parents for `elementId`/`roomId`/`floorId`/`buildingId`, exactly as the reference viewer does. GLTFLoader copies glTF `extras` onto `object.userData`, so `userData.role`, `userData.material` (`brick`/`wood`) and `userData.glazed` are available without a manifest lookup.

### 1.3 Store slices (zustand 5)

One store, sliced, with `subscribeWithSelector`. **Only IDs, enums and primitives** go in the store; no `Object3D`, no `Material`, no `Vector3` instances.

```ts
interface ModelSlice   { phase: 'idle'|'validating'|'loading'|'interactive'|'enriching'|'ready'|'degraded'|'failed';
                         modelId: string | null; pkgHash: string | null;
                         diagnostics: Diagnostic[]; failedAssetIds: AssetId[]; loadedAssetIds: AssetId[]; }
interface SelectionSlice { selection: Selection | null; hover: Selection | null; }
interface ViewSlice    { viewMode: 'overview'|'floor'|'plan'|'section';
                         activeFloorId: FloorId | null; projection: 'perspective'|'ortho';
                         cut: { enabled: boolean; y: number; vertical: null | {axis:'x'|'z'; v:number; sign:1|-1} };
                         explode: { enabled: boolean; gap: number };
                         roofVisible: boolean; ceilingsVisible: boolean; edgesVisible: boolean; }
interface LayerSlice   { layers: Record<LayerId, boolean>; renovationDate: string | null; }
interface ColorSlice   { overrides: Record<SurfaceId, string>; dirty: SurfaceId[]; saveState: 'clean'|'saving'|'error'; }
interface EditSlice    { editing: null | EditDraft; snap: SnapConfig; undo: UndoEntry[]; redo: UndoEntry[]; }
```

`Selection` is a discriminated union: `{kind:'room'|'surface'|'element'|'equipment'|'route'|'routePoint'|'annotation', id: string}`.

**zustand 5 pitfall:** v5 dropped the implicit shallow comparison for object-returning selectors. Every multi-field selector must use `useShallow`:

```ts
const { viewMode, activeFloorId } = useHouseStore(useShallow(s => ({ viewMode: s.viewMode, activeFloorId: s.activeFloorId })));
```
`useHouseStore.ts` re-exports `useShallow` and lint-bans bare object selectors.

---

## 2. Loading strategy

### 2.1 Server routes (authenticated, not `public/`)

Package lives at `${HOUSE_MODEL_DIR}` (e.g. `data/house-model/`), outside the Next `public/` tree.

```
GET /api/house-model/example-house-1/status                 -> ModelPackageStatus (JSON)
GET /api/house-model/example-house-1/manifest?v=<pkgHash>   -> model.json
GET /api/house-model/example-house-1/assets/house-ground?v=<pkgHash> -> GLB
```

All three handlers, in order:

1. `const { modelId } = await params;` — **Next 15/16 route params are a Promise**. Forgetting the `await` is a silent bug.
2. Better Auth session check → 401 with no body detail. No client redirect substitutes for this.
3. `modelId` must equal the configured id; `assetId` must appear in the manifest's `assets[]` (allow-list). Never join user input into a path — resolve `path` from the manifest entry and assert the resolved absolute path is inside `HOUSE_MODEL_DIR`.
4. ETag / caching (below).
5. Stream the file: `new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers })`. `Content-Type: model/gltf-binary` for GLBs, `application/json` for the manifest. `Content-Length` from `stat`.

### 2.2 Caching

`pkgHash` is computed by `src/server/house-model/package.ts`: sha256 over the sorted list of `"<relpath>:<bytes>:<sha256>"` for `model.json`, `manifest.schema.json` and every `assets/*.glb`. It is computed on first use and cached in module scope; a `stat`-only mtime/size re-check runs at most once per 10 s and invalidates the cache. An ingest script can pre-write `house-model.lock.json` so production boot does not hash 26 MB.

Because `pkgHash` is in the query string, responses are content-addressed:

```
Cache-Control: private, max-age=31536000, immutable
ETag: "<pkgHash>-<assetId>"
Vary: Cookie
```

`If-None-Match` match → `304` with no body. `private` (never `public`) because these are authenticated household files. The `status` endpoint is `Cache-Control: private, no-store` — it is the discovery hop that hands the client the current `pkgHash`.

Client flow: `GET /status` (no-store) → gives `pkgHash` + server-side asset presence → all subsequent requests carry `?v=<pkgHash>` and hit the disk cache on repeat visits. A package swap changes `pkgHash`, changes every URL, and needs no cache purge.

### 2.3 Client loading: tiers, parallelism, progressive readiness

`loadByDefault` is honoured as the package's statement of intent, but the client schedules it in **priority tiers**. This is a client-side scheduling decision, not a contract reinterpretation, and is documented as such in the repo.

| Tier | Assets | Bytes | Tris | Objects | Gate |
|---|---|---|---|---|---|
| 0 shell | `house-ground`, `house-upper`, `house-roof`, `house-details`, `garage-shell`, `garage-roof` | 900 kB | 3 350 | 349 | blocks `interactive` |
| 1 site | `terrain` | 709 kB | 8 300 | 8 | after `interactive` |
| 2 structure | `house-structure`, `garage-structure` | 1 479 kB | 9 608 | 49 | only when the **structure layer** is enabled (off by default); prefetched at idle otherwise |
| 3 scan | `scan-reference-lower`, `scan-reference-upper` | 9 963 kB | 120 000 | 2 | explicit opt-in only (`loadByDefault: false`) |

Tier 0 at 900 kB over LAN plus ~350 GLTFLoader mesh constructions comfortably clears the <3 s interactive goal; tier 1+2 arrive within a second or two more without blocking interaction.

```ts
export async function loadTier(
  tier: AssetManifest[], base: string, pkgHash: string, signal: AbortSignal,
  onAsset: (id: AssetId, root: THREE.Group) => void,
  onFail:  (id: AssetId, err: unknown) => void,
): Promise<void> {
  const loader = new GLTFLoader();                       // plain: no DRACO, no meshopt, no KTX2
  loader.setRequestHeader({});                           // cookies ride along same-origin
  const results = await Promise.allSettled(tier.map(async a => {
    const url = `${base}/assets/${a.id}?v=${pkgHash}`;
    const gltf = await loader.loadAsync(url);            // parallel; browser caps concurrency
    if (signal.aborted) { disposeRoot(gltf.scene); return; }
    onAsset(a.id, gltf.scene as THREE.Group);            // add to scene + index incrementally
  }));
  results.forEach((r, i) => { if (r.status === 'rejected') onFail(tier[i].id, r.reason); });
}
```

Notes:

- **No DRACO/meshopt.** The GLBs are plain, uncompressed, indexed `POSITION`+`NORMAL`. Adding a decoder would add a WASM download and a worker for no benefit. `GLTFLoader` alone, no `setDRACOLoader`, no `setMeshoptDecoder`, no `setKTX2Loader`.
- **`Promise.allSettled`, never `Promise.all`.** One failed asset must degrade, not fail. `onFail` pushes to `failedAssetIds`; phase becomes `degraded` if a tier-0 asset failed, and the setup state names it.
- **No `useLoader` / `useGLTF`.** Both cache globally by URL: after the workspace unmounts, drei's cache would still hold ~410 geometries alive, `useGLTF.clear()` must be called manually, and Suspense-based loading makes per-asset error isolation and abort awkward. Imperative `loadAsync` in an effect gives us abort, per-asset failure, deterministic disposal and tier ordering.
- **React 19 StrictMode double-mount.** The load effect creates an `AbortController` and a monotonically increasing `loadToken`. Cleanup aborts and disposes anything already added. Any `onAsset` for a stale token disposes instead of inserting. This must be tested in dev StrictMode, otherwise the second mount silently doubles geometry count and draw calls.
- **Scene insertion is imperative.** Loaded roots go to `scene.add(root)` directly, **not** through `<primitive object={root} />`. Consequences (deliberate): R3F's event system never traverses 400 objects on every pointer move; there is exactly one picking implementation (ours, clip-aware); and React never reconciles the shell. R3F is used for the render loop, camera, controls, lights, marker/route layers and React integration.

### 2.4 Progressive readiness

```
idle → validating ─(errors)→ failed
     → loading(tier0) ─(all tier0 fail)→ failed
                       ─(some fail)→ degraded (interactive)
     → interactive ──→ enriching(tier1,2) ──→ ready
```

`interactive` is announced the moment tier 0 is indexed, colours are applied and the overview camera pose is set. The UI shows a determinate progress bar driven by `loadedAssetIds.length / tier0.length` (byte-accurate progress is available via `GLTFLoader.load`'s `onProgress`, but per-asset counting is steadier and needs no `Content-Length` guarantees).

Failure isolation: `<HouseErrorBoundary>` wraps `<HouseCanvasLazy>` only. `failed` renders `<SetupState>` — the diagnostics list, the missing/invalid assets by id and path, and the manifest's own `issues[]` (29 of them, grouped by severity: 3 medium, 8 low, 18 info) — never a blank canvas. The rest of the app (Today, Supplies, History) is unaffected because the viewer is a lazily-imported leaf.

### 2.5 Code splitting

```tsx
// src/app/(app)/house/page.tsx  — server component
export default function HousePage() { return <HouseWorkspace />; }

// src/house/components/HouseCanvasLazy.tsx
'use client';
import dynamic from 'next/dynamic';
export const HouseCanvasLazy = dynamic(() => import('./HouseCanvas').then(m => m.HouseCanvas), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});
```

`ssr: false` is only legal inside a Client Component in Next 15/16 — hence the separate `'use client'` wrapper. `HouseWorkspace` (tree + inspector chrome) can render on the server; only the `HouseCanvas` chunk pulls in three/R3F/drei (~600 kB gzipped, well isolated from maintenance screens).

---

## 3. Colouring

### 3.1 Load-time material audit (the guard)

```ts
export function auditMaterials(entry: AssetEntry): MaterialAudit {
  const users = new Map<THREE.Material, THREE.Mesh[]>();
  entry.root.traverse(o => {
    if (!(o as THREE.Mesh).isMesh && !(o as THREE.LineSegments).isLineSegments) return;
    const m = (o as THREE.Mesh).material as THREE.Material;
    (users.get(m) ?? users.set(m, []).get(m)!).push(o as THREE.Mesh);
  });
  let cloned = 0;
  for (const [mat, meshes] of users) {
    if (meshes.length === 1) continue;
    for (let i = 1; i < meshes.length; i++) { meshes[i].material = mat.clone(); cloned++; }
  }
  return { assetId: entry.id, materialCount: users.size, cloned };
}
```

Measured today: `cloned === 0` for every asset. The audit result is asserted in a unit test against the real package and surfaced in `__vh` so a regression in a future package revision is caught rather than silently producing cross-room bleed. Cost: one traverse per asset at load.

`originalColor` is captured in the same pass, as a hex int per `surfaceId`. It is **not** used as the reset value — `surface.defaultColor` from the manifest is, so the reset path is testable against the contract rather than against whatever happened to load. The two must agree; a unit test asserts `hexFromLinear(baseColorFactor) === defaultColor` for all 405 surfaces (this is the invariant verified in §0).

### 3.2 The pure colour plan

```ts
export type NodeColorPlan = ReadonlyArray<{ surfaceId: SurfaceId; hex: string; source: 'override' | 'default' }>;

const ROOM_SURFACE_KINDS = new Set(['floor', 'wall', 'ceiling'] as const);

/** Colour plan for one room. Pure: no three, no DOM. */
export function planRoomColors(
  room: Room,
  surfacesById: ReadonlyMap<SurfaceId, Surface>,
  overrides: Readonly<Record<SurfaceId, string>>,
  opts: { kinds?: ReadonlySet<Surface['kind']> } = {},
): NodeColorPlan {
  const kinds = opts.kinds ?? ROOM_SURFACE_KINDS;
  const out: Array<{ surfaceId: SurfaceId; hex: string; source: 'override' | 'default' }> = [];
  for (const sid of room.surfaceIds) {
    const s = surfacesById.get(sid);
    if (!s) continue;                       // manifest inconsistency -> diagnostic elsewhere
    if (s.roomId !== room.id) continue;     // defensive: never touch a neighbour's face
    if (!kinds.has(s.kind)) continue;       // excludes reveal/door-leaf/railing/... (all kind:'other')
    const ov = overrides[sid];
    out.push(ov ? { surfaceId: sid, hex: normalizeHex(ov), source: 'override' }
                : { surfaceId: sid, hex: s.defaultColor,   source: 'default' });
  }
  return out;
}

/** Whole-model plan: every surface, override or default. Used at load and on reset. */
export function planAllSurfaces(
  surfaces: readonly Surface[], overrides: Readonly<Record<SurfaceId, string>>,
): NodeColorPlan { /* same shape, no room filter */ }
```

Why `kind` and not `role`: proven in §0. `role` exclusion would wrongly skip `dormer-front-wall` (a real bathroom wall) and `dormer-ceiling`.

Why the `s.roomId !== room.id` guard: `room.surfaceIds` is authored data. If a future revision lists a shared-wall surface under the wrong room, this guard keeps the neighbour's face untouched and the mismatch shows up as a `W_ORPHAN_SURFACE` diagnostic instead of a visible colour bleed.

Unit tests (pure, fast, run against the real `model.json`):
- `planRoomColors(r-g-fireplace)` returns exactly 6 entries (4 wall + 1 floor + 1 ceiling), and **not** `s-e-g-fireplace` / `s-e-g-fireplace-column` (`kind: 'other'`).
- `planRoomColors(r-g-sauna)` contains `s-w-g-sauna-e--r-g-sauna` and **not** `s-w-g-sauna-e--r-g-shower` or `--r-g-fireplace`.
- Every room's plan is disjoint from every other room's plan (405-surface set intersection = ∅ pairwise). This is the "colour never leaks" property, proven once as a data property.
- `planRoomColors(r-u-stairwell)` (kind `void`) has no `floor` entry — expected, not a bug.

### 3.3 Application

```ts
export function applyColors(plan: NodeColorPlan, index: SceneIndex, invalidate: () => void) {
  let touched = 0;
  for (const { surfaceId, hex } of plan) {
    const mesh = index.surfaceMesh.get(surfaceId);
    if (!mesh) continue;                                   // the 2 mesh-less garage surfaces land here
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat?.color) continue;
    mat.color.set(hex);                                    // sRGB hex -> linear working space
    touched++;
  }
  if (touched) invalidate();
}
```

`material.color.set('#rrggbb')` is correct with three's default `ColorManagement.enabled = true`: the hex is interpreted as sRGB and converted to the linear working colour space, matching how GLTFLoader assigned `baseColorFactor`. No `setStyle(..., LinearSRGBColorSpace)`, no manual conversion. `material.needsUpdate` is **not** set — colour is a uniform.

Persistence: overrides are per-`surfaceId` hex, saved with `{ modelId, pkgHash }`. Reset writes `surface.defaultColor` and deletes the row. Optimistic local apply → `invalidate()` → PATCH; on error, revert to the previous value and toast. The UI exposes "room floor" and each room-facing wall surface independently, as required, using `planRoomColors(room, …, { kinds: new Set(['wall']) })` to enumerate the wall pickers.

### 3.4 Selection and hover highlighting — recommendation: **emissive tint**

Recommended: mutate `material.emissive` + `material.emissiveIntensity` on the selected/hovered surface's material. Rationale, in order of importance:

1. **It cannot fight colour overrides.** `emissive` is an additive channel independent of `color`; the override remains the single writer of `color`. There is no "who owns this material" ambiguity, no save/restore of the base colour, and therefore no class of bug where a highlight leaks into persisted colour.
2. **Zero new machinery.** Every material is already `MeshStandardMaterial` with `emissiveFactor [0,0,0]`, so the emissive path is already compiled into the shader. Changing the colour is a uniform write — no program recompile, no extra draw call, no render target.
3. **It composes with everything else.** Works under `DoubleSide`, under clipping planes, in ortho, under `frameloop="demand"` (one `invalidate()`), and while exploded.

Rejected alternatives and why:

- **Postprocessing outline pass** (`EffectComposer` + `OutlinePass`): adds render targets, a full-screen pass and a second scene traversal; interacts awkwardly with `localClippingEnabled` and ortho; and it changes the render path for every frame including idle-wakeup frames. Too much machinery for a highlight on a 21k-triangle scene.
- **Drei `<Outlines>`**: builds an inverted-hull duplicate of the geometry per outlined object. Our surfaces are thin slabs (a wall face is a near-degenerate box), where inverted-hull outlines look wrong; it also needs the clipping planes copied onto its own material or the outline survives the cutaway.
- **Swapping to a highlight material**: requires save/restore of the original, which is exactly the fight with overrides we want to avoid.

Implementation:

```ts
const SELECT_EMISSIVE = 0x2f6fd0, HOVER_EMISSIVE = 0x2f6fd0;
const SELECT_INTENSITY = 0.55,    HOVER_INTENSITY = 0.22;

export class Highlighter {
  private sel: SurfaceId[] = [];
  private hov: SurfaceId | null = null;
  private outline: THREE.LineSegments | null = null;      // one, reused

  set(index: SceneIndex, selection: SurfaceId[], hover: SurfaceId | null) {
    for (const id of this.sel) this.tint(index, id, 0x000000, 0);
    if (this.hov) this.tint(index, this.hov, 0x000000, 0);
    for (const id of selection) this.tint(index, id, SELECT_EMISSIVE, SELECT_INTENSITY);
    if (hover && !selection.includes(hover)) this.tint(index, hover, HOVER_EMISSIVE, HOVER_INTENSITY);
    this.sel = selection; this.hov = hover;
    this.updateOutline(index, selection);                 // crisp edge on the primary selection only
  }
  private tint(i: SceneIndex, id: SurfaceId, hex: number, k: number) {
    const m = i.surfaceMesh.get(id)?.material as THREE.MeshStandardMaterial | undefined;
    if (!m?.emissive) return;
    m.emissive.setHex(hex); m.emissiveIntensity = k;
  }
}
```

Secondary signal for the *primary* selection: one reused `LineSegments` built from `new THREE.EdgesGeometry(mesh.geometry, 25)`, positioned at the mesh's world matrix, `depthTest: false`, `renderOrder: 999`, and given the same clip-plane array as the mesh's material. One extra draw call, rebuilt only when the selection changes (never per frame). This is what makes a thin wall face readable when selected from an oblique angle.

**Room selection** highlights the room's floor + walls (the plan from `planRoomColors`, kind-filtered) at a lower intensity, plus the outline on the floor surface. **Element selection** highlights all of `element.surfaceIds`.

---

## 4. Visibility and views

### 4.1 One declarative resolver (the central reliability decision)

The reference viewer mutates `.visible` from many independent handlers, and its own "Show all"/"Dollhouse" buttons desynchronise the checkboxes. With floor isolation × roof × ceilings × edges × layers × cutaway × dollhouse, imperative toggling is the single largest source of "the model is in a weird state" bugs.

Therefore: **visibility is a pure function of view state, re-resolved and re-applied in full on every change.** ~500 objects × a boolean write is microseconds; correctness is worth far more than the saved work.

```ts
export interface VisibilityInput {
  viewMode: 'overview' | 'floor' | 'plan' | 'section';
  activeFloorId: FloorId | null;
  roofVisible: boolean; ceilingsVisible: boolean; edgesVisible: boolean;
  layers: Record<LayerId, boolean>;
  loadedAssetIds: readonly AssetId[];
}
/** node-name-keyed decisions; pure, testable without three */
export interface VisibilityPlan {
  assets: Map<AssetId, boolean>;          // asset root
  nodes:  Map<string, boolean>;           // floor nodes, element nodes, edges nodes (by name, per asset)
}
export function computeVisibility(m: ManifestIndex, v: VisibilityInput): VisibilityPlan;
```

Resolution order (later rules override earlier):

1. **Asset roots**: `loadedAssetIds` ∩ layer gating. `house-structure`/`garage-structure` ← `layers.structure`; `scan-reference-*` ← `layers.scanReferences`; `terrain` ← `layers.yard`.
2. **Floor isolation** (`viewMode ∈ {floor, plan, section}` with `activeFloorId`): for every floor `f ≠ activeFloorId`, set every node in `floorNodes.get(f)` to `false` — **across all assets** (this is why `f-upper` in `house-roof` and `house-structure`, and `f-garage` in `garage-structure`, are handled correctly). Assets whose manifest `floorId` is a hidden floor are hidden at the root as well.
3. **Floor-less nodes.** Element nodes that are children of a building node but of no floor node (`e-g-fire-door-landing`, `e-g-bay-door-landing`, `e-outdoor-fireplace`, the roof/terrace/stair elements, `terrain/site/*`) get an explicit policy from a static table, keyed by element id, mapping to a floor or to `'site'`:

   | Nodes | Assigned to | Isolation behaviour |
   |---|---|---|
   | `house-ground`: `e-g-fire-door-landing`, `e-g-bay-door-landing`, `e-outdoor-fireplace` | `f-ground` | hidden with the ground floor |
   | `house-roof`: `e-roof-house`, `e-chimney-*`, `e-roof-ladder-*`, `e-roof-walkway-*`, `e-exit-ladder-guest` | `roof` | hidden when `!roofVisible`; visible in floor isolation only if `roofVisible` |
   | `house-roof`: `f-upper` → `e-dormer-bath` | `f-upper` | follows the upper floor, **not** the roof toggle |
   | `house-details`: `e-terrace`, `e-terrace-*-steps`, `e-outdoor-stair` | `site` | governed by `layers.outdoor`, unaffected by floor isolation |
   | `terrain`: `e-terrain`, `e-paving-*`, `e-deck-west` | `site` | governed by `layers.yard` |
   | `garage-roof`: `e-roof-garage` | `roof` | with `roofVisible` |

   This table lives in `model/explodeGroups.ts` alongside the explode policy (they answer the same question) and is asserted complete by a test that enumerates every node under a building/site node in every default asset and fails on an unclassified one. That test is what protects us against a future package revision adding a new floor-less element.
4. **Ceilings**: when `!ceilingsVisible`, every surface with `kind === 'ceiling'` (25 of them) is hidden by node name. Per-floor variant: hide only ceilings whose `floorId === activeFloorId`. Element-node alternative `e-<floorId>-ceiling` exists but the surface-level rule also covers `dormer-ceiling`, so use the surface rule.
5. **Edges**: `edges-<assetId>` ← `edgesVisible && assetVisible`.
6. **Dollhouse** is a *preset*, not a mode: `{ roofVisible: false, ceilingsVisible: false, viewMode: 'overview' }`. It writes store fields, so the checkboxes stay in sync by construction. Same for "overview/reset": a preset write plus a camera call.

`applyVisibility` then does one traverse per asset, writes `.visible`, and rebuilds `index.pickables` (visible meshes only, computed with an ancestor-visibility walk — the reference viewer's `isVisibleUp`). Rebuilding the pickable array here rather than per click is what keeps selection under 100 ms.

### 4.2 Top-down orthographic plan for a floor

- Switch `projection` to `'ortho'`.
- Lock the rig: `controls.minPolarAngle = controls.maxPolarAngle = 0`; `controls.azimuthRotateSpeed = 0`; `mouseButtons.left = ACTION.TRUCK`, `mouseButtons.wheel = ACTION.ZOOM`. This prevents tumbling out of plan, which is the main way an ortho plan view becomes confusing.
- Fit: `controls.fitToBox(floorBoxPadded, { paddingTop: 0.5, paddingBottom: 0.5, paddingLeft: 0.5, paddingRight: 0.5, cover: false })`, where `floorBoxPadded` is the union of the floor's rooms' footprint boxes (§5), expanded 0.4 m for wall thickness.
- Pair it with a cutaway at `activeFloor.elevation + 1.2 m` (standard plan cut) so walls read as a plan and furniture-height geometry is removed. This reproduces the validated previews `06-plan-ground-cut-1.5m.png` / `07-plan-upper-cut-4.3m.png`.
- North is up and the mapping is direct: screen +x = model +X (plan-east), screen +y = model +Z (plan-south). No axis flip, matching the manifest's own convention. True north is 26.3° (certainty `inferred`) — show it as a north arrow rotated by `-26.3°` with an "inferred" marker, and never silently rotate the plan.

### 4.3 Cutaway with clipping planes

Established at load, never restructured:

```ts
// clipGroups.ts
export type ExplodeGroup = FloorId | 'site' | 'roof';

export class ClipGroups {
  readonly planes = new Map<ExplodeGroup, [THREE.Plane, THREE.Plane]>();  // [horizontal, vertical]
  constructor(groups: ExplodeGroup[]) {
    for (const g of groups) this.planes.set(g, [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), OFF_H),  // keep y <= constant
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), OFF_V),  // keep x <= constant (axis swapped on demand)
    ]);
  }
  /** assigned once per material at load; array LENGTH never changes -> one shader program */
  attach(mesh: THREE.Object3D, group: ExplodeGroup) {
    const m = (mesh as THREE.Mesh).material as THREE.Material | undefined;
    if (!m) return;
    m.clippingPlanes = this.planes.get(group)!;
    m.clipIntersection = false;                 // fragment clipped if outside ANY plane => AND of half-spaces
    m.clipShadows = false;                      // no shadows
  }
  setCut(group: ExplodeGroup, y: number | null, vertical: VerticalCut | null, explodeOffsetY: number) { … }
}
```

Key decisions:

- **`renderer.localClippingEnabled = true`** — set in `<Canvas onCreated={({gl}) => { gl.localClippingEnabled = true }}>`.
- **Always allocate exactly two planes per group, even when the cutaway is off.** Three.js keys the shader program on `clippingPlanes.length`; changing the array length forces a recompile of every affected material (a visible hitch on ~400 materials). "Off" = push `constant` beyond the model bounds (`OFF_H = 1e4`). Only `plane.constant` and `plane.normal` change at runtime — no recompile, no `needsUpdate`.
- **`clipIntersection = false`** gives exactly the desired semantics: a fragment is clipped if it fails *any* plane, so the visible region is the intersection of the kept half-spaces — a horizontal cut AND an optional vertical cut.
- **Per-`ExplodeGroup` plane pairs (4–5 pairs)** rather than one global pair. Clipping planes are evaluated in **world** space; if a floor is translated for an exploded view, a single global plane would cut it at the wrong physical height. With per-group planes, `constant = cutY + explodeOffsetY(group)`, so cutaway and exploded view compose correctly instead of being mutually exclusive. `clipGroupOf(surfaceId)` uses the same static table as the explode policy. (Fallback if this proves fiddly in practice: make cutaway and explode mutually exclusive in the UI. The per-group version is preferred and is barely more code.)
- Cut range: Y from `-6.5` (garage footings, per the reference viewer) to `7.0` (above the ridge at 6.2). Vertical cut: axis `x` or `z`, sign selectable, range from `bounds`.
- The cut face is **not** capped. All materials are `DoubleSide`, so a cut wall shows its interior faces — which is what reads correctly for a section, and matches the validated preview `08-section-stair-x6.7.png`. A stencil-buffer cap would need `stencil: true` on the context, per-material stencil state and a second pass; explicitly out of scope.

### 4.4 Picking that ignores clipped-away geometry

```ts
export interface PickResult {
  surfaceId: SurfaceId | null; elementId: string | null; roomId: string | null;
  floorId: string | null; buildingId: string | null;
  point: THREE.Vector3; object: THREE.Object3D; distance: number;
}

export class Picker {
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  pick(cx: number, cy: number, rect: DOMRect, camera: THREE.Camera,
       index: SceneIndex, clip: ClipGroups): PickResult | null {
    // touch tolerance: centre ray first, then a small ring of offsets
    const offsets = this.touch ? [[0,0],[-9,0],[9,0],[0,-9],[0,9]] : [[0,0]];
    for (const [dx, dy] of offsets) {
      this.ndc.set(((cx + dx - rect.left) / rect.width) * 2 - 1,
                  -((cy + dy - rect.top)  / rect.height) * 2 + 1);
      this.ray.setFromCamera(this.ndc, camera);
      const hits = this.ray.intersectObjects(index.pickables, false);
      for (const h of hits) {
        const g = index.clipGroupOf.get(index.meshSurfaceId.get(h.object)!) ?? 'site';
        const [ph, pv] = clip.planes.get(g)!;
        if (ph.distanceToPoint(h.point) < 0) continue;   // clipped away by the horizontal cut
        if (pv.distanceToPoint(h.point) < 0) continue;   // ... or the vertical cut
        return resolveOwnership(h, index);               // userData, then walk parents
      }
    }
    return null;
  }
}
```

- `index.pickables` is precomputed by `applyVisibility` (visible meshes with all ancestors visible), so a click does no traversal. `intersectObjects(list, false)` — `recursive: false`, the list is already flat.
- The clip filter is per hit and per clip group, matching the reference viewer's validated approach but generalised to the per-floor planes.
- `DoubleSide` means back faces are hit. That is correct and desirable in a cutaway (you want the inside face of the far wall) and harmless otherwise, because the nearest kept hit wins.
- Click vs drag: record pointerdown position; ignore the pointerup pick if the pointer moved > 4 px (reference viewer's rule; raise to 8 px for touch).
- Double-click → `frameSelection()`. Click on nothing → clear selection.
- **Sub-100 ms feedback path**: the pointerup handler (a) picks, (b) writes the emissive tint + outline and calls `invalidate()` synchronously, then (c) writes `setSelection(...)` to the store. The visual acknowledgement is bounded by one frame (~16 ms) and is independent of however long the React inspector takes to render.

### 4.5 Exploded floors

Two categories of object must move together, by the same offset:

1. **Shell geometry** — set `.position.y = offset` on the objects listed for that group. Since every node has an identity transform, this is safe and reversible.
2. **App overlays** — equipment markers, route geometry, annotation anchors and label anchors live under `index.overlay.floorGroups.get(group)`, an app-owned `THREE.Group` per `ExplodeGroup` added directly to the scene. Its `.position.y = offset`. **Children keep physical coordinates**, so nothing in the data ever encodes the presentation offset.

Explode policy table (`model/explodeGroups.ts`), derived from the verified hierarchy:

| Asset | Objects offset | Group |
|---|---|---|
| `house-ground` | node `f-ground`; nodes `e-g-fire-door-landing`, `e-g-bay-door-landing`, `e-outdoor-fireplace`; node `edges-house-ground` | `f-ground` |
| `house-upper` | node `f-upper`; node `edges-house-upper` | `f-upper` |
| `house-roof` | node `f-upper` (dormer) | `f-upper` |
| `house-roof` | nodes `e-roof-house`, `e-chimney-*`, `e-roof-*`, `e-exit-ladder-guest`; node `edges-house-roof` | `roof` (offset = upper-floor offset + 1 gap) |
| `house-details` | asset root | `site` (offset 0) |
| `garage-shell` | node `f-garage`; `edges-garage-shell` | `f-garage` |
| `garage-roof` | asset root | `roof` |
| `terrain` | nothing | `site` (offset 0) |
| `house-structure` | nodes `f-ground`, `f-upper` separately; all other `e-*` (trusses, footings, plinths) | `f-ground`/`f-upper`/`site` by element |
| `garage-structure` | node `f-garage`; footing/plinth/truss elements | `f-garage`/`site` |

Offsets: `offset(group) = index(group) * gap`, with the group order `f-garage (0) < site (0) < f-ground (1) < f-upper (2) < roof (3)` and `gap` configurable (default 2.5 m, range 0–6 m). The garage floor sits 5 m below the house; it is not part of the house stack, so it stays put and only the house stack separates. `f-garage` gets its own optional offset when the garage building is the isolation target.

**Edges caveat (from §0):** `edges-<assetId>` is a single object for a whole asset and cannot be split. For `house-ground`, `house-upper`, `garage-shell`, `house-roof`, `garage-roof` the asset's edges belong to one group and move with it. For **`house-structure`** and **`garage-structure`**, whose edges span two groups, edges are **hidden while `explode.enabled && explode.gap > 0`**; the layer checkbox shows a small "edges hidden while exploded" note. This is stated in the design because the alternative (rebuilding edge geometry per floor) would mean regenerating 14 596 line segments client-side for a presentation nicety.

After changing any offset: `obj.updateMatrixWorld(true)` on each moved object, `clip.setCut(...)` re-applied with the new offsets, `index.overlay.floorGroups` offsets set, and `invalidate()`.

**Save invariant — recommendation: disable exploded mode during edit.** Entering edit mode animates `explode.gap → 0` (instantly under reduced motion), sets `explode.locked = true` and disables the control with the tooltip "Exploded view is off while placing equipment." Reasons: it removes an entire class of "we saved the presentation position" bug rather than relying on a transform being inverted correctly on every save path; it also removes the visual ambiguity of dragging an object across a 2.5 m gap. As defence in depth, the save path never reads `object.position` — it reads the edit draft's `physical: [x, y, z]`, and a dev-only assertion checks `worldOf(draftObject).y - offset(group) ≈ draft.physical[1]` before the mutation is dispatched. A unit test asserts that a draft created while `gap = 2.5` (with the lock forcibly bypassed) still serialises the physical Y.

---

## 5. Camera

### 5.1 Controls — recommendation: Drei **`CameraControls`** (wrapping `camera-controls`), with `makeDefault`

Justification against `OrbitControls`:

| Need | `CameraControls` | `OrbitControls` |
|---|---|---|
| Smooth transition to a pose | `setLookAt(px,py,pz, tx,ty,tz, true)` returns a Promise, damped | none; hand-rolled tweening of position + target |
| Frame a room / floor / selection | `fitToBox(box3, {padding…})`, `fitToSphere` — **preserves current view direction**, which is exactly the "preserve orientation" requirement | none; hand-rolled fit math per projection |
| Orthographic | supported (dollies via `camera.zoom`), `fitToBox` correct in ortho | zoom works but no fit |
| Deterministic reset | `saveState()` / `reset(true)` | `saveState()` / `reset()` (no transition) |
| Trackpad / touch | `touches.*` and `mouseButtons.*` action mapping incl. `TRUCK`, `ZOOM`, `DOLLY`, `OFFSET` | fixed mapping, `enablePan/enableZoom` only |
| Per-mode locking (plan view) | `minPolarAngle/maxPolarAngle`, `azimuthRotateSpeed = 0` | polar limits yes, azimuth lock no |

The framing algorithms and the plan-view lock are the deciding factors: with `OrbitControls` we would reimplement `fitToBox` for two projections and a tween system, which is precisely the kind of bespoke code this project should avoid.

Pitfalls to handle explicitly (R3F 9 / React 19 / Drei 10.7):

1. **`frameloop="demand"` starves the damping.** `camera-controls` integrates over time in `update(delta)`; drei calls that from `useFrame`, but under demand the loop stops after one frame and the camera freezes mid-transition. Fix — a dedicated pump:

```tsx
function useDemandFrames(controlsRef: React.RefObject<CameraControlsImpl | null>) {
  const invalidate = useThree(s => s.invalidate);
  useFrame(() => {
    const c = controlsRef.current;
    if (c && (c.active || c.currentAction !== ACTION.NONE)) invalidate();  // keep the chain alive
  });
  useEffect(() => {
    const c = controlsRef.current; if (!c) return;
    const wake = () => invalidate();
    c.addEventListener('control', wake);
    c.addEventListener('transitionstart', wake);
    c.addEventListener('update', wake);
    return () => { c.removeEventListener('control', wake);
                   c.removeEventListener('transitionstart', wake);
                   c.removeEventListener('update', wake); };
  }, [invalidate]);
}
```
   `useFrame` only runs on rendered frames, so one `invalidate()` per frame while `active` sustains the animation and stops the instant it settles. The event listeners are what start it (a wheel tick or a `setLookAt` call while idle).

2. **`useFrame(cb, priority)` with `priority > 0` disables R3F's automatic render.** Every `useFrame` in this codebase uses the default priority 0. Ordering (controls before label projection) is achieved by **mount order**: `<Rig>` mounts before `<LabelOverlay>`'s projection hook.

3. **`makeDefault` is required** so `useThree(s => s.controls)` resolves and so anything that wants to disable orbiting (edit-mode drag) can find it: `controls.enabled = false` on marker pointerdown, `true` on pointerup.

4. **Projection switching.** Mount exactly one of drei's `<PerspectiveCamera makeDefault>` / `<OrthographicCamera makeDefault>` and **key `<CameraControls>` on the projection** so it re-binds cleanly:

```tsx
{projection === 'perspective'
  ? <PerspectiveCamera makeDefault fov={45} near={0.05} far={500} />
  : <OrthographicCamera makeDefault near={-200} far={400} />}
<CameraControls key={projection} ref={ref} makeDefault
  smoothTime={reduced ? 0 : 0.25} draggingSmoothTime={reduced ? 0 : 0.125}
  minDistance={0.6} maxDistance={140} />
```
   On switch, capture `{position, target}` from the outgoing controls and `setLookAt(..., false)` on the incoming one — the view does not jump. Ortho `near` is negative so geometry behind the camera plane still renders in plan view (as in the reference viewer's `-100`).

5. **Wheel semantics:** perspective → `mouseButtons.wheel = ACTION.DOLLY`; ortho → `ACTION.ZOOM`. Leave `touches` at the library defaults (one finger rotate, two finger dolly+truck) and verify on a real trackpad and a real phone; do not hand-roll gesture handling.

### 5.2 Framing algorithms

All boxes are computed from the **manifest**, not from geometry bounds, so framing is deterministic, unit-testable and unaffected by what happens to be loaded.

```ts
const PAD = 0.35;   // wall thickness allowance, metres

export function roomBox(room: Room): THREE.Box3 {
  let x0 = +Infinity, x1 = -Infinity, z0 = +Infinity, z1 = -Infinity;
  for (const [x, z] of room.footprint.outer) {          // rings up to 18 points (r-g-living)
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const y0 = room.floorElevation;                        // -0.30 for r-g-living, NOT floor.elevation
  const y1 = y0 + (room.ceilingHeight ?? 2.5);
  return new THREE.Box3(new THREE.Vector3(x0 - PAD, y0 - 0.05, z0 - PAD),
                        new THREE.Vector3(x1 + PAD, y1 + 0.05, z1 + PAD));
}

export function floorBox(m: ManifestIndex, floorId: FloorId): THREE.Box3 {
  const b = new THREE.Box3();
  for (const r of m.roomsByFloor.get(floorId) ?? []) b.union(roomBox(r));
  return b.isEmpty() ? assetUnionBox(m, floorId) : b;    // fallback for floors with no rooms
}

export function buildingBox(m: ManifestIndex, buildingId: BuildingId): THREE.Box3 {
  const b = new THREE.Box3();
  for (const a of m.assetsByBuilding.get(buildingId) ?? [])
    if (a.kind !== 'scan-reference' && a.bounds) b.union(box3From(a.bounds));
  return b;
}

export function propertyBox(m: ManifestIndex): THREE.Box3 { return box3From(m.bounds); }

export function equipmentBox(p: Placement): THREE.Box3 {
  return new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(...p.position), new THREE.Vector3(1.6, 1.6, 1.6));  // ~1.6 m context sphere
}

export function routeBox(r: Route): THREE.Box3 {
  const b = new THREE.Box3();
  for (const p of r.points) b.expandByPoint(new THREE.Vector3(...p));
  return b.expandByScalar(0.5);
}
```

`assets[].bounds` is present for all 11 assets, so `buildingBox` needs no geometry. `propertyBox` uses `bounds` `min [-15.02,-5.85,-8.9] max [26.5,6.8,13.8]` (41.5 × 12.7 × 22.7 m).

Camera API:

```ts
export interface CameraApi {
  overview(): Promise<void>;                     // canonical pose, deterministic
  fitBox(box: THREE.Box3, opts?: FitOpts): Promise<void>;
  frameRoom(roomId: RoomId): Promise<void>;
  frameFloor(floorId: FloorId): Promise<void>;
  frameBuilding(id: BuildingId): Promise<void>;
  frameSelection(): Promise<void>;
  frameEquipment(id: string): Promise<void>;
  planFor(floorId: FloorId): Promise<void>;      // ortho + lock + fit + cut
}
```

- **`fitBox`** → `controls.fitToBox(box, { paddingLeft: 0.6, paddingRight: 0.6, paddingTop: 0.6, paddingBottom: 0.6, cover: false }, { enableTransition: !reducedMotion })`. `fitToBox` fits along the **current** view direction, which satisfies "preserve orientation" for free — no azimuth bookkeeping. Room framing additionally clamps the polar angle into `[15°, 70°]` first (`controls.rotatePolarTo`) so a room framed from straight overhead in the middle of a plan view does not produce a confusing pose.
- **`overview()`** is an explicit, deterministic pose rather than `controls.reset()`, so "reset" always lands in the same place no matter what happened before: target `(5.65, 1.5, 5.05)` (the house centre used by the validated previews), position `target + (16, 14, 18)`, plus `roofVisible: true, ceilingsVisible: true, viewMode: 'overview', projection: 'perspective', cut.enabled: false, explode.enabled: false`. `saveState()` is still called once after the first `overview()` so `controls.reset()` remains available as a secondary escape hatch.
- **Reduced motion**: `useReducedMotion()` watches `matchMedia('(prefers-reduced-motion: reduce)')` (with a `change` listener, not a one-shot read). When reduced, every call passes `enableTransition: false` and the rig sets `smoothTime = 0` and `draggingSmoothTime = 0`. Result: instant cuts, no damping tail.
- **Search → frame** (the "low-battery door sensor" flow) is one orchestrated action so it cannot half-apply:

```ts
async function focusTarget(t: FocusTarget) {
  const floorId = resolveFloorId(t);                       // placement.floorId / surface.floorId / route segment
  set({ activeFloorId: floorId, viewMode: 'floor', selection: t.selection });
  await nextVisibilityApplied();                           // isolation lands before the fit
  await camera.fitBox(boxFor(t), { padding: 0.6 });
  announce(`${labelFor(t)} — ${floorLabel(floorId)}`);     // aria-live
}
```

---

## 6. Semantic zoom and labels

### 6.1 Recommendation: a **single custom DOM overlay**, not Drei `<Html>`

`<Html>` is a reasonable choice for ≤ 25 room labels in isolation, but the requirement is ≤ 25 room labels **plus up to ~200 equipment markers** with clustering, HA state badges and battery badges. `<Html>` creates a React portal and a DOM node per label, each transformed by its own subscription; 200 portals is 200 React subtrees to reconcile whenever anything changes, `transform` mode adds CSS3D matrices, and `occlude="blending"` / `occlude={[refs]}` adds per-label raycasts or a depth-buffer read. Mixing two label systems (Html for rooms, custom for equipment) also means two occlusion policies and two clustering rules.

So: **one `LabelOverlay`** — an absolutely-positioned `<div>` sibling of `<Canvas>` (`inset: 0; pointer-events: none`, children `pointer-events: auto`) with a **fixed recycled pool** of DOM nodes (48 elements: 28 label slots + 20 cluster badges), written **imperatively**.

```tsx
export function LabelOverlay() {
  const host = useRef<HTMLDivElement>(null);
  const pool = useRef<LabelPool>();                     // created once; 48 divs, all display:none
  // anchors are recomputed only when data changes (rooms, placements, floor groups, explode)
  const anchors = useLabelAnchors();                    // {id, kind, world:Vector3, group:ExplodeGroup, text}
  useLabelProjection(host, pool, anchors);              // useFrame(default priority) -> pure DOM writes
  return <div ref={host} className="vh-labels" aria-hidden={false} />;
}
```

`useLabelProjection` runs in `useFrame` (priority 0, mounted after `<Rig>`) and does **zero React work**:

```ts
const v = new THREE.Vector3();
useFrame(({ camera, size }) => {
  const tier = tierFor(camera, target);                  // §6.2
  const cells = new Map<number, Candidate>();            // screen-space cluster grid
  for (const a of anchors.current) {
    if (!tier.kinds.has(a.kind)) continue;
    if (!isGroupVisible(a.group)) continue;              // floor hidden -> label hidden
    const [ph, pv] = clip.planes.get(a.group)!;
    if (ph.distanceToPoint(a.world) < 0) continue;       // cut away -> label hidden
    if (pv.distanceToPoint(a.world) < 0) continue;
    v.copy(a.world).add(groupOffset(a.group)).project(camera);
    if (v.z < -1 || v.z > 1) continue;                   // behind / beyond
    const x = (v.x * 0.5 + 0.5) * size.width;
    const y = (-v.y * 0.5 + 0.5) * size.height;
    if (x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40) continue;
    const cell = (Math.floor(x / CELL) << 12) ^ Math.floor(y / CELL);   // CELL = 72 px
    const prev = cells.get(cell);
    if (!prev || v.z < prev.depth) cells.set(cell, { a, x, y, depth: v.z, n: (prev?.n ?? 0) + 1 });
    else prev.n++;
  }
  pool.current!.write(cells);                            // style.transform / textContent / className
}, 0);
```

`pool.write` sorts by depth, assigns the nearest N candidates to pooled elements, writes `transform: translate3d(Xpx, Ypx, 0)`, `textContent` and a state class, and hides the rest. Any cell with `n > 1` gets a "+N" badge instead of a label. Because everything is a direct DOM write on a pre-existing node, there is no React re-render, no layout thrash beyond the transform (compositor-only), and no allocation in the hot path.

Anchors (`useLabelAnchors`) are memoised and only recomputed when rooms/placements/floor-group offsets change:
- Room anchor = the room footprint's **pole of inaccessibility** (largest inscribed circle centre, computed by grid refinement in `geometry2d.ts`) at `floorElevation + min(ceilingHeight * 0.6, 1.6)`. A plain centroid falls outside the 11-point hall ring and the 18-point living-room ring; the pole of inaccessibility does not. Computed once per room at load (25 rooms, a few ms) and cached in `ManifestIndex`.
- Equipment anchor = `placement.position` + `[0, 0.12, 0]`.

### 6.2 Semantic zoom tiers

Distance from the camera to the controls target, with hysteresis so a label set does not flicker at a boundary:

| Tier | Range | Shown |
|---|---|---|
| A | > 26 m | Building labels (2): "Main house", "Garage" |
| B | 9–26 m | Room labels for visible floors (≤ 25), name + `nameFi` on hover |
| C | 3.5–9 m | Room labels demoted to small pills; equipment labels for the visible floor |
| D | < 3.5 m | Equipment labels with HA state + battery badge; route endpoint labels |

Hysteresis: entering a tier requires crossing its boundary by 12 %; leaving requires crossing back by 12 % the other way. Hard cap: at most **28** labels + **20** cluster badges on screen, ever, regardless of tier — enforced by the pool size, so a label cloud is structurally impossible.

### 6.3 Occlusion — recommendation: **logical rules only, no per-label raycast**

Cheap rules cover the cases that actually matter and cost nothing:

1. Anchor's `ExplodeGroup` is hidden → hide.
2. Anchor is on the clipped-away side of either active plane → hide.
3. Anchor is behind the camera or outside the frustum → hide (the `v.z` / margin checks above).
4. **Interior anchor with an exterior camera and an intact envelope** → hide: if the anchor is inside `buildingBox(b)` and the camera position is outside `buildingBox(b)` expanded by 0.4 m, and `roofVisible && ceilingsVisible && !cut.enabled` for that building, then the label is behind a wall. This single rule removes the "labels floating over the closed exterior" problem that motivates occlusion in the first place.

Per-label raycast occlusion is explicitly **not** implemented in v1. If it proves necessary, the extension is a round-robin of ≤ 8 rays per frame against `index.pickables` with a 250 ms cache per anchor and a two-frame debounce before flipping visibility — but rule 4 makes it unlikely to be needed, and 200 raycasts per frame is exactly the kind of hidden cost that breaks the 60 fps goal.

### 6.4 No re-render storms

- Labels never live in React state. Text, position, class and visibility are DOM writes.
- HA state reaches labels via `haStore.subscribe` writing into a `dirtyEntities: Set<string>` which the next projection frame consumes (§9). A sensor update touches one `textContent` and one `className`.
- A React re-render of the label layer happens only when the *anchor set* changes (a placement added, a floor isolated) — a handful of times per session.
- Labels are keyboard-reachable: each pooled element is a `<button>` with `tabIndex={-1}`, and a hidden, ordered `<ul>` of the same items (rendered by React, updated only on anchor-set change) provides the real tab order and screen-reader semantics. Clicking either dispatches the same `setSelection`.

---

## 7. Edit mode (equipment placement)

### 7.1 Recommendation: **custom drag against a snap target + numeric inspector as the authority**, not `TransformControls`

Drei's `<TransformControls>` is rejected because: its gizmo translates along world axes with `translationSnap` only (no surface snapping, no wall-normal rotation, no mounting height semantics); it raycasts its own gizmo planes against the whole scene and needs the `makeDefault` controls-disable dance; it temporarily re-parents the controlled object (dangerous when the object lives under a floor group whose offset encodes presentation); and the gizmo handles are ~10 px targets, unusable on touch. The required behaviours (snap to floor at the room's own elevation, snap to a wall with normal alignment, 5 cm grid, mounting height, 15° rotation) are all snapping semantics that a generic gizmo does not have.

### 7.2 Draft model and snapping

```ts
export interface EditDraft {
  placementId: string | null;              // null = new
  equipmentId: string; modelId: string;
  physical: [number, number, number];      // ALWAYS physical site coords, metres
  rotationYDeg: number;
  mount: { kind: 'floor'; height: number } | { kind: 'wall'; surfaceId: SurfaceId; height: number; offset: number };
  floorId: FloorId; roomId: RoomId | null;
  locationNote: string; photoId: string | null;
  original: Omit<EditDraft, 'original'> | null;   // for cancel
}
export interface SnapConfig { grid: number /* 0.05 */; rotationStep: number /* 15 */; enabled: boolean; wallSnap: boolean }
```

Snapping resolution, run on every pointermove during a drag (and on every numeric-field commit):

```ts
export function resolveSnap(hit: PickResult | null, cfg: SnapConfig, m: ManifestIndex, draft: EditDraft): SnapSolution {
  // 1. WALL SNAP — hit surface is kind 'wall' with a roomId
  if (cfg.wallSnap && hit && m.surfaces.get(hit.surfaceId!)?.kind === 'wall' && hit.roomId) {
    const frame = wallFrame(hit.object as THREE.Mesh);        // §8.3: {origin,u,v,n,uRange,vRange}
    const local = frame.toLocal(hit.point);                   // (u, v, 0)
    const u = snap(local.u, cfg.grid);
    const room = m.rooms.get(hit.roomId)!;
    const v = snap(draft.mount.kind === 'wall' ? draft.mount.height : local.v - room.floorElevation, cfg.grid);
    const p = frame.toWorld(u, room.floorElevation + v, WALL_STANDOFF);   // 0.02 m clear of the face
    // face out of the wall, into the room: n points away from the surface
    const rotY = THREE.MathUtils.radToDeg(Math.atan2(frame.n.x, frame.n.z));
    return { physical: p.toArray(), rotationYDeg: snap(rotY, cfg.rotationStep),
             mount: { kind: 'wall', surfaceId: hit.surfaceId!, height: v, offset: WALL_STANDOFF },
             floorId: room.floorId, roomId: room.id, indicator: { kind: 'wall', frame, u, v } };
  }
  // 2. FLOOR SNAP — hit surface is kind 'floor'
  if (hit && m.surfaces.get(hit.surfaceId!)?.kind === 'floor' && hit.roomId) {
    const room = m.rooms.get(hit.roomId)!;                    // r-g-living -> -0.30, not 0.0
    const x = snap(hit.point.x, cfg.grid), z = snap(hit.point.z, cfg.grid);
    const h = draft.mount.kind === 'floor' ? draft.mount.height : 0;
    return { physical: [x, room.floorElevation + h, z], rotationYDeg: snap(draft.rotationYDeg, cfg.rotationStep),
             mount: { kind: 'floor', height: h }, floorId: room.floorId, roomId: room.id,
             indicator: { kind: 'floor', y: room.floorElevation, x, z } };
  }
  // 3. FREE — plane at the active floor's elevation; roomId from point-in-ring over that floor's rooms
  const y = m.floors.get(draft.floorId)!.elevation;
  const p = intersectHorizontalPlane(currentRay, y);
  return { physical: [snap(p.x, cfg.grid), y + heightOf(draft), snap(p.z, cfg.grid)],
           roomId: roomAt(m, draft.floorId, p.x, p.z), … };   // point-in-ring incl. holes
}
```

Details that matter:

- `snap(v, 0.05)` = `Math.round(v / 0.05) * 0.05`, then `Math.round(x * 1000) / 1000` to avoid float dust in persisted values. All persisted coordinates are rounded to millimetres.
- **Mounting height is measured from the room's own floor**, `room.floorElevation` — not the floor datum. The living room at -0.30 makes this a real, testable distinction.
- Ray candidates during a drag are restricted to the active floor's `floor`/`wall` surfaces (typically 20–30 meshes), so drag raycasting is trivially cheap and cannot snap to a ceiling or a roof by accident.
- `roomAt` uses even-odd point-in-ring including `footprint.holes`, over the rooms of the drafted floor only. Rings up to 18 points; 13 rooms max per floor; well under a millisecond.
- Held **Alt** temporarily disables grid snapping; held **Shift** constrains the drag to the dominant axis; the snap indicator (`<SnapIndicator>`) draws the 5 cm grid patch, the wall frame outline and the snapped point as a small ring, and shows the numeric readout next to the cursor.
- `controls.enabled = false` on drag start, restored on drag end, so the camera never orbits mid-placement.
- `explode.gap` is forced to 0 and locked (§4.5).

### 7.3 Numeric inspector and mobile fallback

The right-hand inspector shows, and accepts, the authoritative values: X / Y / Z in metres (3 decimals, step 0.05), rotation Y in degrees (step 15, free entry allowed), mount kind, mounting height, wall offset, room (derived, read-only with an override), location note, close-up photo. Editing a field re-runs `resolveSnap` in "numeric" mode (no ray), so the drag path and the typing path converge on the same code.

**On phones, drag placement is not offered.** The phone edit sheet is numeric-only plus "place at room centre" and "nudge" buttons (±5 cm / ±15°), consistent with the brief's guidance that complex geometry editing may favour desktop.

### 7.4 Undo, save, cancel — recommendation: a simple explicit stack

```ts
type UndoEntry =
  | { t: 'draft';   before: EditDraft; after: EditDraft }
  | { t: 'commit';  placementId: string; before: Placement | null; after: Placement }
  | { t: 'delete';  placement: Placement };
```

A bounded stack (50) in the edit slice, with `undo()` / `redo()`. **Not** zustand's temporal middleware (`zundo`): it snapshots whole store slices on every change, which would capture unrelated view/selection churn and make "undo" mean something the user did not intend. An explicit stack of semantic entries is smaller, predictable and testable.

Semantics:
- Drag/typing mutates the draft and pushes a `draft` entry, coalescing entries within 400 ms so a continuous drag is one undo step.
- **Save** validates (room resolved, inside the floor's bounds, no NaN), PATCHes the placement, pushes a `commit` entry, exits edit mode, and re-enables the explode control. Failure keeps edit mode open with the draft intact and an inline error.
- **Cancel** (or Esc) restores `draft.original` (or removes the new marker) and exits. If the draft is dirty, a confirm dialog fires — Esc twice discards.
- Undo after save issues the inverse PATCH; a redo re-applies. Both are idempotent by placement id.

---

## 8. Route editing (infrastructure)

### 8.1 Data contract (client-side)

```ts
export interface Route {
  id: string; modelId: string;
  system: 'ventilation' | 'water' | 'electrical' | 'network' | 'heating' | 'drainage' | 'other';
  kind: 'duct' | 'pipe' | 'cable' | 'valve' | 'outlet' | 'switch' | 'junction' | 'access-point' | 'other';
  points: Array<[number, number, number]>;                       // physical site coords, metres
  segments: Array<{ floorId: FloorId | null; roomId: RoomId | null }>; // length = points.length - 1
  certainty: 'measured' | 'observed' | 'inferred' | 'unknown';
  lifecycle: 'planned' | 'installed' | 'removed';
  widthM?: number; diameterM?: number;
  depthM?: number;                                               // into the structure (negative = behind face)
  offsetFrom?: { surfaceId: SurfaceId; kind: 'wall' | 'floor' | 'ceiling'; offsetM: number };
  endpoints: Array<{ kind: 'equipment'; placementId: string } | { kind: 'surface'; surfaceId: SurfaceId; uv: [number, number] } | { kind: 'free' }>;
  installedAt?: string; removedAt?: string; renovationId?: string;
  photoIds: string[]; note?: string;
}
```

`segments` carries floor/room per span, so a riser between floors is representable and each span renders under the right `ExplodeGroup` (a cross-floor span is split at the floor boundary for rendering only; the stored polyline is untouched).

### 8.2 Three editors, one coordinate authority

The stored `points` in physical site coordinates are always the source of truth. Each editor is a bijection to and from them.

**(a) 3D polyline editing** — draggable handles (small `InstancedMesh` spheres, r = 0.05, one per point, under the segment's floor group), reusing `resolveSnap` so points snap to wall/floor surfaces and the 5 cm grid. Insert on segment double-click (splits at the projected nearest point), delete on handle `Delete`. Good for coarse routing, deliberately not the primary editor.

**(b) 2D plan editor** (`PlanEditor2D.tsx`) — SVG over the floor footprint, with dimensions.

```
viewBox in centimetres:  "minX*100  minZ*100  (maxX-minX)*100  (maxZ-minZ)*100"
screen x = X * 100      (plan-east  -> right)
screen y = Z * 100      (plan-south -> down)
```
No axis flip is needed: the manifest states a north-up plan reads X right and Z down, which is exactly SVG's coordinate sense. The room outlines are the footprint `outer` rings (and `holes`) drawn as `<polygon>`; wall thickness is not modelled in 2D, so the shell is drawn additionally as the projected outline of the floor's `wall` surfaces (their AABBs flattened to XZ) for context. Route points become `<circle>` handles; drag → `x = clamp(snap(evt.x/100, 0.05))`, `z = …`, `y` unchanged (edited in the elevation editor or the numeric field). Live dimension chains (`<text>` with leader lines) show each segment length and the perpendicular distance from the two nearest wall faces — which is what makes a plan editor more precise than freehand 3D.

**(c) Wall-elevation editor** (`WallElevationEditor2D.tsx`) — pick a wall surface; edit in its own plane. Horizontal axis = along the wall, vertical = height above the room floor.

### 8.3 Wall frame extraction

```ts
export interface WallFrame {
  origin: THREE.Vector3;   // the u=0, v=0 corner, on the surface plane
  u: THREE.Vector3;        // unit, horizontal, along the wall
  v: THREE.Vector3;        // unit, world up (0,1,0)
  n: THREE.Vector3;        // unit, out of the surface (towards the room)
  uRange: [number, number]; vRange: [number, number];   // metres
  toLocal(p: THREE.Vector3): { u: number; v: number; d: number };
  toWorld(u: number, v: number, d: number): THREE.Vector3;
}

export function wallFrame(mesh: THREE.Mesh): WallFrame {
  // 1. normal: area-weighted mean of the triangle normals, then snapped to the dominant one.
  //    Wall surfaces are near-planar quads, so a single dominant normal is well defined.
  const n = dominantNormal(mesh.geometry);              // uses index + POSITION; NORMAL attr as a tiebreak
  n.y = 0; n.normalize();                               // walls are vertical; drop any numerical tilt
  // 2. basis
  const v = new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(v, n).normalize();
  // 3. extents: project every POSITION vertex (world space; identity transforms, so local == world)
  let u0=+Inf,u1=-Inf,v0=+Inf,v1=-Inf,d=0;
  forEachVertex(mesh.geometry, p => { u0=min(u0,p.dot(u)); u1=max(u1,p.dot(u));
                                      v0=min(v0,p.y);      v1=max(v1,p.y);      d += p.dot(n); });
  const dPlane = d / vertexCount;                       // mean signed plane offset
  const origin = new THREE.Vector3().addScaledVector(u,u0).addScaledVector(v,v0).addScaledVector(n,dPlane);
  return { origin, u, v, n, uRange:[0,u1-u0], vRange:[v0,v1], toLocal, toWorld };
}
```

Notes:
- Projecting the **vertices** rather than the AABB corners is important: several wall surfaces are non-axis-aligned (the guest room's diagonal wall from (5.31, 4.785), the living-room bay's 18-point ring), where an AABB would overstate the extents by up to a metre. Vertex projection is exact and costs a few dozen dot products on a 4–20 triangle mesh.
- Identity transforms mean local == world, but `toWorld` still applies `mesh.matrixWorld` so the code stays correct if a future package revision introduces transforms.
- `n` is oriented towards the room: compare `n` against `roomCentroid(surface.roomId) − origin` and flip if negative. Because materials are `DoubleSide`, the geometric winding cannot be trusted for this.
- The editor draws a `uRange × vRange` rectangle in SVG (viewBox in centimetres again), overlays the openings that belong to this wall (`elements` with `properties.wallId === surface.elementId`, using their `properties.width/sill/head` — all present in the data, e.g. `e-o-g-n-kitchen-win`: width 1.20, sill 1.00, head 2.14), and lets points be placed relative to them. Snapping to jamb and sill lines is what makes "the cable runs 20 cm above the window head" recordable.
- Round trip: `toWorld(snap(u), room.floorElevation + snap(v), offset)` → physical point. A unit test asserts `toLocal(toWorld(u,v,d)) ≈ (u,v,d)` within 1e-6 for all 154 wall surfaces in the real package.

### 8.4 Uncertainty and lifecycle styling

Geometry is identical regardless of confidence; only style differs, and the legend states this explicitly ("Line position is drawn; confidence is shown by style. A solid line is not proof of a verified concealed installation.").

| Axis | Value | Style |
|---|---|---|
| certainty | `measured` | solid, full opacity, 2 px |
| | `observed` | solid, 0.85 opacity |
| | `inferred` | **dashed** (2 cm on / 4 cm off, in world units) |
| | `unknown` | dashed + 0.45 opacity + `?` badge on the route |
| lifecycle | `planned` | 0.6 opacity, cool-neutral hue regardless of system, "planned" pill |
| | `installed` | full system hue |
| | `removed` | 0.3 opacity, thin, desaturated; hidden unless the renovation date filter includes its `removedAt` |
| system | ventilation / water / electrical / network / heating / drainage | fixed hue per system, colour-blind-safe set, each also distinguished by endpoint glyph so hue is never the only channel |

Dashing uses `LineDashedMaterial` and **requires `geometry.computeLineDistances()`** after building each `LineSegments` — a classic omission that yields silently solid lines; it is asserted in a unit test.

Rendering budget: routes are batched into one `LineSegments` per (system, lifecycle, certainty) style bucket per `ExplodeGroup`. With 6 systems × 3 lifecycles × 4 certainties the theoretical bucket count is large, but real data occupies ~8–12 buckets → ~12–36 draw calls, rebuilt only when route data or the date filter changes. Where a duct's `diameterM` is known and the ventilation layer is on, that route is additionally drawn as a `TubeGeometry` (radial segments 6, one mesh per duct, a few dozen at most) so a 125 mm duct reads at its real size. WebGL ignores `LineBasicMaterial.linewidth`, so anything needing true width must be a tube or drei's `<Line>` (`Line2`); tubes are preferred because they are depth-correct and need no resolution uniform updates on resize.

---

## 9. Home Assistant live layer

### 9.1 A separate vanilla store

```ts
export interface EntityState {
  entityId: string; state: string;                 // 'on' | 'off' | '23.4' | 'unavailable' | 'unknown'
  lastUpdated: number;                             // epoch ms, parsed once on ingest
  battery?: number | null; batteryType?: string | null;
  unit?: string | null; deviceClass?: string | null;
}
export interface HaStore {
  connection: 'connecting' | 'open' | 'retrying' | 'closed';
  lastEventAt: number | null;
  entities: Record<string, EntityState>;
  applyBatch(events: EntityState[]): void;
  setConnection(c: HaStore['connection']): void;
}
export const haStore = createStore<HaStore>()(subscribeWithSelector((set) => ({ /* … */ })));
```

Deliberately a **`zustand/vanilla`** store, separate from the React house store, for two reasons: HA traffic must never be able to invalidate a selector in the view/selection store; and the label overlay needs imperative subscription from outside React.

`applyBatch` replaces only the changed keys:

```ts
applyBatch: (events) => set(s => {
  let next: Record<string, EntityState> | null = null;
  for (const e of events) {
    const prev = s.entities[e.entityId];
    if (prev && prev.state === e.state && prev.lastUpdated === e.lastUpdated && prev.battery === e.battery) continue;
    (next ??= { ...s.entities })[e.entityId] = e;
  }
  return next ? { entities: next, lastEventAt: Date.now() } : {};   // no-op returns {} -> no notify
}),
```

The `{}` early-out matters: a duplicate event must not notify subscribers.

### 9.2 SSE transport

`GET /api/ha/stream` (Server-Sent Events), cookie-authenticated (`EventSource` cannot set headers; same-origin cookies work).

- On connect the server sends `event: hello` with a snapshot of the linked entities only (a few hundred, not 3 300) — the app subscribes to what its equipment links to, never the whole registry.
- Then `event: state` frames, **coalesced server-side to ≤ 10 Hz** and batched as arrays, so a burst of sensor updates is one client `applyBatch`.
- `retry: 3000` plus a client backoff (1 s → 2 s → 4 s → 8 s → 15 s cap, ±20 % jitter). `onerror` → `setConnection('retrying')`; three consecutive failures → `'closed'` with an explicit "Reconnect" action.
- The connection indicator is a small React component subscribing to `connection` and `lastEventAt` only.
- HA credentials never reach the browser: the server holds the token, the client only sees `EventSource` frames.

### 9.3 Marker subscription without re-render storms

Two consumers, two mechanisms:

1. **Inspector / lists (React)** — `useStore(haStore, s => s.entities[entityId])`. Selector is per entity, so a temperature change re-renders only the one card showing it. Never `s => s.entities`.
2. **3D markers and labels (imperative)** — `LabelOverlay` subscribes once:

```ts
useEffect(() => haStore.subscribe(s => s.entities, (next, prev) => {
  for (const id in next) if (next[id] !== prev[id]) dirty.current.add(id);
  if (dirty.current.size) { needsBadgeWrite.current = true; invalidateIfAnchorColorChanged(); }
}), []);
```
   The next projection frame drains `dirty` and writes `textContent` / `className` on the pooled DOM nodes. `invalidate()` is called **only** when something 3D changes (an anchor's `instanceColor`), not for DOM-only badge changes — a temperature reading must not wake the GPU.

### 9.4 Availability, staleness, batteries

State classification, in order:

| Condition | Class | Presentation |
|---|---|---|
| no linked entity | `unlinked` | plain marker, no state dot |
| `connection !== 'open'` | `disconnected` | hollow dot, greyed; a single banner, not 200 badges |
| `state === 'unavailable'` | `unavailable` | hollow dot, strike-through label |
| `state === 'unknown'` | `unknown` | hollow dot, "—" |
| `now − lastUpdated > staleMs(deviceClass)` | `stale` | dot with a dotted ring, relative age in the tooltip |
| otherwise | `live` | filled dot; on/off or value |

`staleMs` is per device class and configurable, defaulting to `battery: 26 h`, `temperature/humidity: 2 h`, `binary_sensor (door/window/motion): 24 h`, `default: 6 h` — event-driven binary sensors legitimately go quiet for a day. Staleness is recomputed by a **single 30 s interval** that sets `needsBadgeWrite`; it never touches the store and never re-renders React.

Battery badge: shown when `battery` is a number. **`null`/`undefined` is never rendered as 0 %** — it renders as "battery unknown". Thresholds are configurable (default low ≤ 20 %, critical ≤ 10 %) with 3 pp hysteresis to stop flapping. `batteryType` (e.g. "CR2032") is shown when known so the locate flow can say which cell to bring. Recovery of telemetry after a battery change is not treated as evidence of maintenance — that remains a recorded completion.

**Fan / flow presentation:** where only on/off is known, the marker shows a static two-state glyph plus the caption "running — flow not measured". A slow 1.2 s pulse plays **only** while that marker is hovered or selected, driven by a bounded `invalidate()` loop that stops when the interaction ends. No continuous animation, no particles travelling along ducts, no speed mapped to an unmeasured quantity.

---

## 10. Rendering and resource management

### 10.1 Canvas configuration

```tsx
<Canvas
  frameloop="demand"
  dpr={dprRange}                                     // [1, 2] or [1, 1.5]; see below
  gl={{ antialias: true, alpha: false, powerPreference: 'high-performance',
        stencil: false, depth: true, preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false }}
  onCreated={({ gl, scene }) => {
    gl.localClippingEnabled = true;                  // required for per-material clippingPlanes
    gl.toneMapping = THREE.NoToneMapping;            // flat architectural look; keep colours literal
    gl.setClearColor(0xf4f4f2, 1);
    scene.background = new THREE.Color(0xf4f4f2);
    scene.matrixWorldAutoUpdate = true;
  }}
  camera={undefined}                                  // cameras are mounted explicitly in <Rig/>
>
```

- `alpha: false` — opaque canvas, cheaper composite, and the background is a deliberate warm off-white matching the validated previews.
- `stencil: false`, `preserveDrawingBuffer: false` — nothing needs them (no stencil caps, screenshots come from Playwright).
- `antialias: true` — MSAA is essentially free at 21k triangles and matters a lot for a line-heavy architectural look with `edges-*` overlays.
- `NoToneMapping` — ACES would shift the pale surfaces and make persisted hex colours not match what the user picked. `outputColorSpace` stays R3F's default `SRGBColorSpace`.
- **Pixel ratio policy:** `dpr={[1, cap]}` with `cap = 2`, dropping to `1.5` when the canvas CSS area exceeds 1.6 Mpx (≈ 1600 × 1000) — a `ResizeObserver` on the canvas host recomputes the cap and R3F re-applies it. Under `frameloop="demand"` a dpr change triggers one re-render, not a loop. An additional manual "Performance mode" toggle pins `dpr` to 1 for the rare case of a large external display on a busy machine.

### 10.2 On-demand rendering: the complete `invalidate()` inventory

`frameloop="demand"` means nothing renders unless something asks. Every one of these must call `invalidate()`:

| Trigger | Where |
|---|---|
| camera-controls active / transitioning | `useDemandFrames` (§5.1) — the frame pump |
| pointer move producing a hover change | picker → `Highlighter.set` → `invalidate` |
| selection change | selection subscription |
| colour override applied / reset | `applyColors` (only if it touched something) |
| visibility plan applied | `applyVisibility` |
| cut height / vertical cut change | `ClipGroups.setCut` |
| explode gap change (per animation frame while tweening) | `explode.ts` tween |
| asset finished loading and was indexed | `loadAssets` `onAsset` |
| layer toggles, route/marker data change | data subscriptions |
| marker instance colour change from HA | `haStore` subscription, **only** when an `instanceColor` actually changed |
| canvas resize / dpr change | R3F handles; verify with a resize test |
| edit-mode draft change | edit subscription |

Everything else — label text, badge classes, inspector rendering, tooltips — is DOM-only and must **not** invalidate. `__vh.invalidateCount()` is exposed so the idle test (§13) can assert that a 2 s idle period with live HA traffic produces zero extra frames.

### 10.3 Lighting recipe (no shadows)

Taken from the validated reference viewer, which produced the calm, readable previews:

```tsx
<hemisphereLight args={[0xffffff, 0x88806a, 1.1]} />
<directionalLight position={[12, 20, -8]} intensity={1.6} />   {/* key, from plan-north-east */}
<directionalLight position={[-10, 8, 12]} intensity={0.5} />   {/* fill, from plan-south-west */}
```

No `<Environment>`, no HDRI (an extra 1–2 MB download and a PMREM pass for a scene with `metalness: 0` and `roughness: 0.9`, where an IBL is nearly indistinguishable from the hemisphere light). No `<SoftShadows>`, no `<AccumulativeShadows>`.

**Shadows are off.** Justification: enabling `shadowMap` doubles the draw calls (410 → ~820 per frame) for a shadow pass; a single directional light covering the 41.5 × 22.7 m site needs either a very large ortho shadow camera (blocky, useless at room scale) or CSM; and the whole point of the view is interior legibility, where a cast shadow across a floor actively hurts. Drei `<ContactShadows>` is also rejected: it renders the scene to an off-screen target every frame, which fights `frameloop="demand"` and adds cost for a soft blob under a house that is already grounded by the terrain mesh. If grounding ever reads poorly, the cheap fix is a static radial-gradient decal on the terrain, authored once — not a per-frame render.

Depth of the interior is carried instead by the `edges-*` overlays (already in the package, 9 extra draw calls) and the per-surface base colours.

### 10.4 Static matrices

After each asset is indexed:

```ts
entry.root.traverse(o => { o.matrixAutoUpdate = false; });
entry.root.updateMatrixWorld(true);
```

This removes ~410 per-frame matrix compositions. When an explode offset changes, the moved node gets `obj.updateMatrix(); obj.updateMatrixWorld(true);` explicitly. Overlay groups (markers, routes, edit handles) keep `matrixAutoUpdate = true` since they move. A dev assertion checks that no static node's `position` was mutated without a matrix update.

### 10.5 `three-mesh-bvh` — not needed, and here is why

- Total default geometry is **21 258 triangles across 401 meshes** (average 53 triangles per mesh; the largest single mesh is a terrain patch).
- A raycast first tests each mesh's bounding sphere and AABB. For a click ray, a handful of meshes survive that test; the triangle loop then runs over a few hundred triangles at most.
- Even the pathological case — a ray along the long axis of the site hitting everything — is ~21k triangle intersections, which is well under 5 ms in JS and happens **once per click**, not per frame.
- Costs avoided: BVH construction for 401 geometries (allocation + time at load, directly against the 3 s budget), roughly 1.5–2× extra index memory per geometry, and an extra dependency with its own three-version compatibility surface.
- The one case that would change this analysis is the scan references (60 000 triangles each in a single mesh). They are `loadByDefault: false`, evidence-only, and are marked **non-pickable** (`raycast = () => {}` and excluded from `index.pickables`) — so they never enter a ray test at all.

### 10.6 Equipment markers — recommendation: **one `InstancedMesh` per `ExplodeGroup`** plus the DOM overlay

| Option | Draw calls @200 | Verdict |
|---|---|---|
| 200 × `<mesh>` | 200 | rejected — draw calls, 200 React components, 200 matrix updates |
| 200 × `<Sprite>` | 200 | rejected — same, plus sprites need per-frame scaling for constant screen size |
| `THREE.Points` | 1 | rejected — no per-instance picking granularity worth relying on, no rotation, gl_PointSize caps |
| drei `<Instances>` + 200 `<Instance>` | 1 | works, but 200 React components and drei's own per-instance matrix bookkeeping |
| **`InstancedMesh` per floor group (4)** | **4** | **recommended** |

```ts
const geo = new THREE.SphereGeometry(0.06, 10, 8);            // 160 tris, shared across all 4 meshes
const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
const im  = new THREE.InstancedMesh(geo, mat, 256);
im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(256 * 3), 3);
im.count = 0;                                                  // set to the actual placement count
im.frustumCulled = false;                                      // instances span the whole floor
clipGroups.attach(im, group);                                  // markers respect the cutaway too
overlay.floorGroups.get(group)!.add(im);                       // explode offset applies for free
```

Per group: 1 draw call, ≤ 256 instances, `instanceColor` encoding HA state (live / unavailable / stale / low-battery / unlinked). Picking: raycast against the four instanced meshes, `hit.instanceId` → `instanceIds[group][instanceId]` → placement id.

The **primary hit target is the DOM marker**, not the 3D dot: a 0.06 m sphere is a ~6 px target at typical distances, which fails both the hit-target and the accessibility requirements. The 3D instance provides the depth-correct dot (it is occluded by walls, clipped by the cutaway, moves with the explode) and a secondary pick path; the DOM marker provides a 24 px (desktop) / 44 px (touch) focusable button. This split is what makes the marker layer both cheap and usable.

### 10.7 Disposal and memory checks

```ts
export function disposeViewer(index: SceneIndex, scene: THREE.Scene) {
  for (const entry of index.assets.values()) {
    scene.remove(entry.root);
    entry.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose();
    });
  }
  for (const g of index.overlay.floorGroups.values()) { scene.remove(g); disposeTree(g); }
  disposeTree(highlighter.outlineNode);
  index.assets.clear(); index.surfaceNode.clear(); index.surfaceMesh.clear();
  index.pickables.length = 0;
}
```

Order on unmount: abort in-flight loads → `disposeViewer` → record `renderer.info.memory` into `__vh.disposedInfo` → let R3F dispose the renderer and lose the WebGL context. Because we never use `useLoader`/`useGLTF`, there is no global cache to clear. `haSse` closes the `EventSource` and the 30 s stale interval is cleared.

Expected steady-state numbers (asserted in tests):
- `renderer.info.memory.geometries` = 349 (tier 0) / 357 (+ terrain) / 406 (+ structure). `textures` = 0.
- `renderer.info.programs.length` ≤ 4.
- `renderer.info.render.calls` ≈ 349 / 357 / 406 with edges on; ≈ 6–9 fewer with edges off.
- After dispose: `geometries === 0`, `textures === 0`.
- JS heap: sampled via `performance.memory` (Chromium) before load, at `ready`, and after a mount/unmount/mount cycle; a third mount must not exceed the second by more than 10 % — this is the leak test, and it is the one that catches a StrictMode double-mount regression.

---

## 11. Accessibility and keyboard

### 11.1 Focus model

Three landmark regions, each a tab stop group: `PropertyTree` (`role="tree"`), canvas region (`role="application"`, `tabIndex={0}`, `aria-label="House 3D view"`, `aria-describedby` pointing at a shortcut summary), `Inspector` (`role="region" aria-label="Inspector"`). `F6` cycles regions forwards, `Shift+F6` backwards; `Tab` behaves normally inside a region.

- `PropertyTree` uses a **roving `tabIndex`**: one tab stop for the whole tree, arrows navigate (`↑/↓` sibling, `→` expand/enter, `←` collapse/parent), `Home/End` jump, `Enter`/`Space` selects, typing jumps to a matching label. Selecting in the tree writes the store; the canvas highlight follows.
- The canvas is not a focus trap. Focus enters it deliberately (`Tab` or clicking it); arrow keys then drive the camera rather than the page, and this is announced in the description.
- Selection changes announce through a polite `aria-live` region: "Fireplace room, ground floor, 10.58 square metres, 4 wall surfaces" or "Front door sensor, upper hall, battery 14 percent, low".
- Labels/markers: the visible pooled DOM buttons have `tabIndex={-1}`; a visually hidden, React-rendered `<ul>` mirrors the currently visible label set in document order and carries the real tab stops, so a keyboard user can reach every visible marker without the pool's recycling breaking focus.
- Every 3D-only capability has a non-3D route: the tree isolates floors and selects rooms; search + list select equipment; the inspector edits placements numerically; the colour picker lists room surfaces by name. The 3D view is never the only way to do something.

### 11.2 Shortcuts

| Key | Action |
|---|---|
`1` / `2` / `3` | isolate `f-ground` / `f-upper` / `f-garage`
`0` | all floors (overview)
`R` | reset to property overview (deterministic pose + preset)
`F` | frame current selection
`Esc` | clear selection; in edit mode, cancel (twice if dirty); close a sheet
`E` | toggle edit mode (placement)
`P` | top-down orthographic plan of the active floor
`S` | toggle section / cutaway
`X` | toggle exploded floors (disabled in edit mode)
`H` | roof visibility
`G` | ceilings visibility
`B` | architectural edges
`D` | dollhouse preset
`[` / `]` | cut height −/+ 0.10 m (`Shift` = 0.01 m)
`,` / `.` | rotate selection −/+ 15° (edit mode)
`↑↓←→` | orbit 5° (canvas focused); `Shift+` = truck; `+` / `−` = dolly
`/` | focus search
`?` | shortcut help dialog

Shortcuts are suppressed while focus is in a text input, a `contenteditable`, or a `<select>`, and are registered on a single `keydown` listener on the workspace root (not `window`), so the rest of the app is unaffected.

### 11.3 Reduced motion, contrast, hit targets

- `prefers-reduced-motion: reduce` → all camera transitions instant (`enableTransition: false`, `smoothTime: 0`), explode changes instant, no marker pulse, no cross-fades. Watched live via a `change` listener.
- Selection is never conveyed by colour alone: emissive tint **plus** the edge outline **plus** the tree/inspector state **plus** the live-region announcement. Route confidence uses dash pattern in addition to opacity. HA state uses dot fill style (filled / hollow / dotted ring) in addition to hue.
- Hit targets: DOM markers and label buttons ≥ 24 × 24 px desktop, ≥ 44 × 44 px on touch; toolbar buttons ≥ 32 px desktop / 44 px touch; the cut and explode sliders get 44 px thumbs on touch and full keyboard stepping.
- All chrome text meets WCAG AA against the panel background; labels over the 3D view sit on a translucent chip with a solid backdrop (never text directly on the render, where contrast is unpredictable).

---

## 12. Phone mode

Single-column flow; the 3D view is present but demoted and simplified.

**What is shown** (top to bottom): task/equipment header → "Locate" card → instructions/steps → photos → supplies → completion action. Ordinary maintenance work never requires the 3D view.

**Simplifications when `matchMedia('(max-width: 767px)')`:**
- `dpr` capped at 1.5; `antialias: true` retained (cheap at this triangle count and important for legibility).
- Tier 2 (structure, 1.48 MB) and tier 3 (scan) are **not** loaded and their layers are hidden from the layer list.
- Route tubes degrade to lines; label pool shrinks to 16 + 8 badges; equipment labels only in tier D.
- Edit mode is numeric-only (§7.3); the 2D route editors are read-only with a "edit on desktop" note.
- Explode is unavailable (it needs precise orbiting to be legible).

**"Locate equipment"** — one tap on the Locate card runs a single orchestrated action:

```ts
async function locate(placementId: string) {
  const p = placements.get(placementId)!;
  set({ activeFloorId: p.floorId, viewMode: 'plan', projection: 'ortho',
        roofVisible: false, ceilingsVisible: false,
        cut: { enabled: true, y: floorElevationOf(p.floorId) + 1.6, vertical: null },
        explode: { enabled: false, gap: 0 },
        layers: { ...onlyRelevantLayers(p) }, selection: { kind: 'equipment', id: placementId } });
  await nextVisibilityApplied();
  await camera.fitBox(new THREE.Box3().setFromCenterAndSize(vec(p.position), vec3(4.5, 3, 4.5)));
}
```

Result: a top-down plan of just that floor, cut at 1.6 m, roof and ceilings off, the marker pulsing once, the room name and `nameFi` labelled, plus — below the canvas and always visible without interacting with the 3D at all — the **`locationNote`** verbatim ("behind the utility-room door, top shelf") and the **close-up photo**. The written note and the photo are the primary locating aids; the plan is context. Touch: one finger pans (`ACTION.TRUCK`, because in a locked plan view rotation is not wanted), two fingers pinch to zoom, double-tap re-frames the marker. A "Show in 3D" secondary button unlocks the orbit for users who want it.

Camera streams are not part of this design; the equipment inspector shows a placeholder tile with an explicit "Open stream" action that mounts nothing until tapped.

---

## 13. Verification plan

### 13.1 The test hook

```ts
// src/house/test/testHook.ts — mounted only when NEXT_PUBLIC_VH_TEST_HOOK === '1'
export interface VhHook {
  ready: Promise<void>;                                  // resolves at phase 'interactive'
  settled: Promise<void>;                                // resolves at phase 'ready' | 'degraded'
  status(): { phase: string; loadedAssetIds: string[]; failedAssetIds: string[]; diagnostics: Diagnostic[] };
  materialHex(surfaceId: string): string | null;         // sRGB hex, null if no material (the 2 garage surfaces)
  allMaterialHex(): Record<string, string>;              // 403 entries; the isolation test's workhorse
  materialAudit(): Array<{ assetId: string; materialCount: number; cloned: number }>;
  visible(assetId: string, nodeName: string): boolean;
  worldY(assetId: string, nodeName: string): number;
  pickables(): number;
  select(sel: Selection | null): void;
  selection(): Selection | null;
  camera(): { position: [number,number,number]; target: [number,number,number]; projection: string };
  screenOf(world: [number,number,number]): [number, number];   // CSS px in the canvas rect
  roomAnchor(roomId: string): [number, number, number];        // pole of inaccessibility
  pick(cssX: number, cssY: number): PickResult | null;
  renderInfo(): { calls: number; triangles: number; geometries: number; textures: number; programs: number };
  frameStats(): { frames: number; avgMs: number; p95Ms: number; reset(): void };
  invalidateCount(): number;
  lastSavePayload(): unknown;                            // for the exploded-save invariant
  disposedInfo(): { geometries: number; textures: number } | null;
}
declare global { interface Window { __vh?: VhHook } }
```

The hook is attached inside a `useEffect` in `SceneRoot`, gated on the build-time env flag, and stripped from production bundles by dead-code elimination. It only reads and dispatches actions already available to the UI; it is not a back door around auth.

### 13.2 Playwright checks

Setup: an authenticated storage state, `--enable-unsafe-swiftshader` disabled in favour of a real GPU where CI allows, plus a `--force-device-scale-factor=1` run for stable screen coordinates.

**Load and integrity**
1. `phase === 'interactive'` within **3 000 ms** of `page.goto('/house')`; `failedAssetIds` empty; `status().diagnostics` has no `severity: 'error'`.
2. `materialAudit()` reports `cloned === 0` for all 9 default assets (the no-shared-materials guarantee still holds).
3. `allMaterialHex()` has 403 entries and each equals the manifest's `defaultColor` for that surface (the `baseColorFactor` ↔ `defaultColor` invariant, end to end through GLTFLoader and three's colour management).
4. `renderInfo()` after `settled`: `geometries === 406`, `textures === 0`, `programs <= 4`, `calls` within ±2 of 406.

**Selection**
5. Click at `screenOf(roomAnchor('r-g-living'))` after the dollhouse preset → `pick()` returns `surfaceId === 's-r-g-living-floor'`, `roomId === 'r-g-living'`, `point.y ≈ -0.30 ± 0.02` (the living-room datum).
6. Same target selected from the room list → `selection()` is identical to the click result's room selection; the inspector heading reads "Living room"; `?sel=` in the URL matches. Then reload the page and assert the selection is restored from the URL.
7. Selection latency: instrument `performance.mark` at pointerup and at the first `invalidate()`; assert **< 100 ms**, and separately that the inspector heading is present within 300 ms.
8. Click at a point above the ridge with the cutaway at `y = 1.5` → `pick()` does **not** return a `house-roof` surface; it returns a ground-floor surface (clip-aware picking).

**Colour isolation** (the highest-value check)
9. Snapshot `allMaterialHex()`. Set an override on `s-r-g-fireplace-floor` = `#ff0000`. Re-read. Assert the diff is **exactly one key**, and that key's value is `#ff0000`.
10. Shared wall: override `s-w-g-sauna-e--r-g-sauna`; assert `s-w-g-sauna-e--r-g-shower` and `s-w-g-sauna-e--r-g-fireplace` are unchanged (the three faces of one physical wall).
11. Reset the room → every entry equals its `defaultColor`; the diff against the original snapshot is empty.
12. Selecting a room does **not** change any `materialHex()` value (proving the emissive highlight does not fight overrides), while `renderInfo().programs` stays constant (proving no shader recompile).

**Visibility and views**
13. Isolate `f-upper` → `visible('house-ground','f-ground') === false`, `visible('house-structure','f-ground') === false`, `visible('house-upper','f-upper') === true`, `visible('house-roof','f-upper') === true` (the dormer follows the floor), `visible('house-roof','e-roof-house')` follows `roofVisible`. `visible('house-ground','e-outdoor-fireflace')` per the policy table.
14. Ceilings off → all 25 ceiling surfaces invisible; `pickables()` drops by 25; a downward ray from above enters the room.
15. Dollhouse preset then "reset" → every asset root and node visible again, and the store's checkbox fields agree with the scene (the desync bug the resolver exists to prevent). Assert by comparing `computeVisibility(...)` output against the actual `.visible` for all indexed nodes.
16. Plan view for `f-upper`: `projection === 'ortho'`, polar angle 0, and the fitted box contains all 9 upper-floor rooms' footprint boxes.

**Explode and the save invariant**
17. `gap = 3` → `worldY('house-upper','f-upper') === 3`, `worldY('house-ground','f-ground') === 1 * 3 / 2`… (assert against `offset(group)` from the policy table), and `visible('house-structure','edges-house-structure') === false` (the cross-floor edges rule).
18. An upper-floor marker's world position shifts by the upper offset while its stored `position` is byte-identical.
19. Enter edit mode while exploded → `explode.gap === 0` and the control is disabled. Then move a marker, save, and assert `lastSavePayload().position` equals the physical, un-offset coordinates and lies on the 5 cm grid, with `y === room.floorElevation + mount.height`.

**Search**
20. Type "low battery door sensor" → the first result's `Enter` yields: `activeFloorId` = that sensor's floor, `selection.kind === 'equipment'`, camera target within 0.5 m of the marker, the inspector showing the linked task and `battery` + `batteryType`, and an `aria-live` announcement containing the room name.

**On-demand rendering**
21. `frameStats().reset()`, idle 2 000 ms with the HA SSE stream pushing 20 state changes → `frameStats().frames <= 1` and `invalidateCount()` unchanged. This is the check that catches an accidental continuous animation or a stray `invalidate()`.
22. During a scripted 2 s orbit (`controls.rotate` in 60 steps), `frameStats().p95Ms` is reported (target ≤ 16.7 ms) alongside `renderInfo().calls`.

**Resilience**
23. Route-level fault injection returns 404 for `assets/terrain` → `phase === 'degraded'`, `failedAssetIds === ['terrain']`, the setup panel names it, and rooms are still selectable.
24. Corrupt `model.json` (drop `rooms`) → `phase === 'failed'`, `<SetupState>` lists the zod error path, and navigating to `/supplies` and `/today` still works (error-boundary containment).
25. `/api/house-model/.../assets/house-ground` without a session → 401, no bytes. With a session and a matching `If-None-Match` → 304.

**Lifecycle**
26. Mount → unmount → mount → unmount. `disposedInfo()` reports `geometries === 0` both times; the JS heap after the second cycle is within 10 % of the first.
27. Dev StrictMode run: after the double mount, `renderInfo().geometries` equals the single-mount value (no duplicate scene).

### 13.3 Timing and fps measurement

- `performance.mark`/`measure` around: `vh:status`, `vh:manifest-parse`, `vh:validate`, `vh:tier0-fetch`, `vh:tier0-index`, `vh:interactive`, `vh:ready`. Playwright reads them via `performance.getEntriesByType('measure')` and writes a JSON artefact per run so regressions are visible over time.
- `frameStats` is a rAF sampler installed by the test hook, recording frame deltas into a ring buffer; `avgMs`/`p95Ms` are computed on read. It samples only while frames are actually produced, which is the meaningful measure under `frameloop="demand"`.
- Throughput is measured on three scripted interactions: orbit, cut-height sweep (`[`/`]` × 30), and floor isolation toggles (`1`/`2`/`0` × 10).
- Honest caveat recorded with the results: headless/CI GPU numbers are not a substitute for the target machine. The acceptance numbers come from a manual run in the real browser on the Mac mini, with the CI numbers used only as a regression tripwire.

### 13.4 Screenshot list

Desktop **1600 × 1000**, dpr 1:
1. Property overview (all default assets, edges on)
2. Dollhouse — ground floor
3. Dollhouse — upper floor
4. Floor isolation, `f-upper`, perspective
5. Top-down ortho plan, `f-ground`, cut at 1.5 m, with dimensions
6. Top-down ortho plan, `f-upper`, cut at 4.3 m
7. Section, vertical cut at X 6.7 (through the stair)
8. Exploded floors, gap 2.5 m
9. Garage isolated (`f-garage`), roof off
10. Room selected (`r-g-fireplace`) with inspector open — highlight + outline visible
11. Colour override applied to one room, neighbours visibly unchanged
12. Equipment layer on, semantic-zoom tier C, clustering badges visible
13. Ventilation + water layers, mixed certainty (dashed inferred vs solid measured) and lifecycle styling
14. Edit mode: wall snap, snap indicator, numeric fields, explode control disabled
15. 2D plan route editor with dimensions
16. Wall-elevation route editor with window openings shown
17. Structure layer on (trusses/footings), edges on
18. Scan reference on (opt-in), shell semi-context
19. Setup state: one missing asset (degraded)
20. Setup state: invalid manifest (failed)
21. HA disconnected banner with `unavailable`/`stale` marker styling
22. Reduced-motion run of screenshot 4 (identical framing, no transition artefacts)

Phone **390 × 844**, dpr 2 (captured at 1.5 cap):
23. Task detail with Locate card collapsed
24. Locate mode: plan + marker + room label
25. Locate mode scrolled to the location note + close-up photo
26. Equipment inspector with battery + linked task
27. Numeric placement sheet
28. Supplies list reached from a task (proving the non-3D path)

Screenshots are captured after `__vh.settled` plus an explicit "no pending frames" wait (`invalidateCount()` stable for 250 ms) so `frameloop="demand"` cannot produce a half-rendered capture. They are compared with a small pixel tolerance and reviewed manually on change — they are a regression aid, not an automated pass/fail gate for a GPU render.

---

## 14. Open items and honest caveats

1. **Exploded + cutaway composition** relies on per-`ExplodeGroup` clipping-plane pairs. This is correct in principle (clipping is world-space, and per-group planes track the group's offset) but it is the one piece of §4 with no precedent in the validated reference viewer. If it misbehaves, the fallback is one line of UI logic: make the two view modes mutually exclusive.
2. **Two mesh-less surfaces** (`s-e-f-garage-ext-out-0-upper`, `s-e-f-garage-ext-out-2-upper`) are handled defensively everywhere, but the package's own `assets[].stats.surfaces` count (47 for `garage-shell`) counts them while `materials` (46) does not. Worth reporting back to the model producer as a cosmetic manifest-stats inconsistency; it does not affect the app.
3. **`edges-<assetId>` cannot be split by floor**, so the structure assets' edges are hidden while exploded. Stated in the UI rather than worked around.
4. **True north is `inferred`** (26.3°). Plans render in model orientation with an explicitly-labelled inferred north arrow; nothing is silently rotated.
5. **Garage placement is `verified` in the manifest but `iss-01` (medium) still lists ±0.5 m / ±2° uncertainty** from the earlier OSM-derived estimate. The garage's inspector surfaces `iss-01` so an equipment placement recorded there is understood to inherit that uncertainty.
6. **Client tiering deviates from `loadByDefault` ordering** (structure deferred behind its layer). Documented as a scheduling decision in the repo, with `loadByDefault` still governing *whether* an asset is part of the default set.
7. **Performance figures in §0 and §10.7 are computed from the package** (byte counts, mesh counts, triangle counts) and from the producer's measured reference-viewer run. They are budgets to validate on the Mac mini, not results already achieved by this implementation.

---

### Critical Files for Implementation

- `/Users/machadolucas/git/empty/2026-09-07/house-model-project/house-model/model.json` — the manifest the zod schema, `ManifestIndex`, colour plans, framing boxes and visibility/explode policy tables are all derived from; the source of every ID used in the verification plan.
- `/Users/machadolucas/git/empty/2026-09-07/house-model-project/house-model/manifest.schema.json` — the exact contract `src/house/model/schema.ts` must mirror, including the `closet` room kind and the `derived` certainty value that the brief's summary omitted.
- `/Users/machadolucas/git/empty/2026-09-07/house-model-project/house-model/viewer/index.html` — the validated plain-Three.js reference: the clipping-plane cutaway, the `distanceToPoint >= 0` pick filter, `isVisibleUp`, the `if (!obj || !obj.material) continue` guard for mesh-less surfaces, and the lighting values reused verbatim in §10.3.
- `/Users/machadolucas/git/empty/2026-09-07/house-model-project/house-model/README.md` — the authoritative statements on loading at identity, picking/ownership, per-room colouring, visibility conventions and exploded views, plus the r1–r17 revision history that explains why several elements sit outside their floor node.
- `/Users/machadolucas/git/empty/2026-09-07/house-model-project/house-model/validation-report.md` — §6 mesh/material statistics, §7 measured consumer load/interaction/recolour/picking tests and §10 known limitations; the baseline the §13 assertions are calibrated against.
- `/Users/machadolucas/git/empty/2026-09-07/house-model-project/house-model/assets/` — the nine default GLBs whose hierarchy irregularities (`terrain/site`, cross-asset `f-upper`/`f-garage`/`f-ground` nodes, floor-less elements under `b-house`, per-asset `edges-*` roots, `doubleSided: true`, 1:1 materials) drive §1.2, §4.1 and §4.5.