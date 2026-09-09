"use client";
/**
 * The cutaway. Range comes from the manifest bounds, not from a hard-coded number, so a different
 * package still gets a usable slider.
 *
 * The cut face is deliberately **not** capped: every material is `DoubleSide`, so a cut wall shows
 * its interior faces, which is what reads correctly for a section. A stencil-buffer cap would need
 * `stencil: true` on the context, per-material stencil state and a second pass.
 */
import { cutRange } from "@/house/model/framingBoxes";
import { useHouseStore, useShallow } from "../hooks/useHouseStore";
import { ToolbarButton } from "./ViewToolbar";

export function CutawayControl() {
  const { cut, setCut, index, activeFloorId } = useHouseStore(
    useShallow((s) => ({
      cut: s.cut,
      setCut: s.setCut,
      index: s.index,
      activeFloorId: s.activeFloorId,
    })),
  );
  if (!index) return null;
  const range = cutRange(index);
  const bounds = index.manifest.bounds;

  return (
    <section className="flex flex-col gap-1" aria-label="Cutaway">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-3">Section</span>
        <ToolbarButton pressed={cut.enabled} onClick={() => setCut({ enabled: !cut.enabled })}>
          {cut.enabled ? "On (S)" : "Off (S)"}
        </ToolbarButton>
      </div>

      <label className="flex flex-col gap-1 text-xs text-ink-2">
        <span>
          Horizontal cut at <span className="font-mono">{cut.y.toFixed(2)} m</span>
          {activeFloorId ? (
            <span className="text-ink-3">
              {" "}
              ({(cut.y - (index.floors.get(activeFloorId)?.elevation ?? 0)).toFixed(2)} m above the
              floor)
            </span>
          ) : null}
        </span>
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={0.01}
          value={cut.y}
          onChange={(event) => setCut({ enabled: true, y: Number(event.currentTarget.value) })}
          className="h-11 md:h-6 w-full touch-manipulation"
          aria-label="Cut height in metres"
        />
      </label>

      <fieldset className="flex flex-col gap-1 text-xs text-ink-2">
        <legend className="sr-only">Vertical cut</legend>
        <div className="flex flex-wrap gap-1">
          <ToolbarButton
            pressed={cut.vertical === null}
            onClick={() => setCut({ vertical: null })}
          >
            No vertical cut
          </ToolbarButton>
          <ToolbarButton
            pressed={cut.vertical?.axis === "x"}
            onClick={() =>
              setCut({
                enabled: true,
                vertical: { axis: "x", v: midpoint(bounds.min[0], bounds.max[0]), sign: 1 },
              })
            }
          >
            Cut along X
          </ToolbarButton>
          <ToolbarButton
            pressed={cut.vertical?.axis === "z"}
            onClick={() =>
              setCut({
                enabled: true,
                vertical: { axis: "z", v: midpoint(bounds.min[2], bounds.max[2]), sign: 1 },
              })
            }
          >
            Cut along Z
          </ToolbarButton>
        </div>
        {cut.vertical ? (
          <>
            <label className="flex flex-col gap-1">
              <span>
                {cut.vertical.axis.toUpperCase()} ={" "}
                <span className="font-mono">{cut.vertical.v.toFixed(2)} m</span>
              </span>
              <input
                type="range"
                min={cut.vertical.axis === "x" ? bounds.min[0] : bounds.min[2]}
                max={cut.vertical.axis === "x" ? bounds.max[0] : bounds.max[2]}
                step={0.01}
                value={cut.vertical.v}
                onChange={(event) =>
                  setCut({
                    vertical: cut.vertical
                      ? { ...cut.vertical, v: Number(event.currentTarget.value) }
                      : null,
                  })
                }
                className="h-11 md:h-6 w-full touch-manipulation"
                aria-label={`Vertical cut position along ${cut.vertical.axis}`}
              />
            </label>
            <ToolbarButton
              onClick={() =>
                setCut({
                  vertical: cut.vertical
                    ? { ...cut.vertical, sign: cut.vertical.sign === 1 ? -1 : 1 }
                    : null,
                })
              }
            >
              Flip side
            </ToolbarButton>
          </>
        ) : null}
      </fieldset>
    </section>
  );
}

const midpoint = (a: number, b: number): number => Math.round(((a + b) / 2) * 100) / 100;
