/** Per search invocation. Rejected checks are recorded only after an independent point has
 * actually been compared in 3D. A fit from two walls by itself has no check residual. */
export interface AlignmentSearchDiagnostics {
  fittedPairs: number;
  independentChecks: number;
  bestCheckM: number | null;
  bestTraceGapM: number | null;
  traceComparisons: number;
  contradictedWall: boolean;
  contradictedOpening: boolean;
}
export interface AlignmentSearchOptions {
  selectedRoom?: boolean;
  diagnostics?: AlignmentSearchDiagnostics;
}
export function newAlignmentSearchDiagnostics(): AlignmentSearchDiagnostics {
  return { fittedPairs: 0, independentChecks: 0, bestCheckM: null, bestTraceGapM: null, traceComparisons: 0,
    contradictedWall: false, contradictedOpening: false };
}
export function recordIndependentCheck(diagnostics: AlignmentSearchDiagnostics | undefined, errorM: number) {
  if (!diagnostics || !Number.isFinite(errorM)) return;
  diagnostics.independentChecks++;
  diagnostics.bestCheckM = Math.min(diagnostics.bestCheckM ?? Infinity, errorM);
}
