"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  classifyVentilationFeedback, type VentilationFan, type VentilationFeedback,
  type VentilationFeedbackConfig,
} from "@/domain/ventilationFeedback";
import { ventilationStateKey } from "@/house/store/haSse";
import { haStore } from "@/house/store/haStore";

type FanFeedback = Record<VentilationFan, VentilationFeedback>;

const FeedbackContext = createContext<FanFeedback>({
  supply: { status: "illustrative" },
  extract: { status: "illustrative" },
});

function percentage(reading: VentilationFeedback): number | null {
  return "percentage" in reading ? reading.percentage : null;
}

export function VentilationFeedbackProvider({ config, children }: {
  config: VentilationFeedbackConfig;
  children: ReactNode;
}) {
  const { supply, extract } = config;
  const supplyReading = useStore(haStore, (state) => supply ? state.entities[ventilationStateKey(supply)] : undefined);
  const extractReading = useStore(haStore, (state) => extract ? state.entities[ventilationStateKey(extract)] : undefined);
  const connected = useStore(haStore, (state) =>
    Boolean((supply || extract) && state.connection === "open" && state.haConnected));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!supply && !extract) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [supply, extract]);

  const supplyFeedback = classifyVentilationFeedback(config, "supply", supplyReading, connected, now);
  const extractFeedback = classifyVentilationFeedback(config, "extract", extractReading, connected, now);
  const supplyStatus = supplyFeedback.status;
  const extractStatus = extractFeedback.status;
  const supplyPercentage = percentage(supplyFeedback);
  const extractPercentage = percentage(extractFeedback);
  const feedback = useMemo<FanFeedback>(() => ({
    supply: supplyStatus === "live" || supplyStatus === "stopped"
      ? { status: supplyStatus, percentage: supplyPercentage ?? 0 } : { status: supplyStatus },
    extract: extractStatus === "live" || extractStatus === "stopped"
      ? { status: extractStatus, percentage: extractPercentage ?? 0 } : { status: extractStatus },
  }), [supplyStatus, extractStatus, supplyPercentage, extractPercentage]);

  return <FeedbackContext.Provider value={feedback}>{children}</FeedbackContext.Provider>;
}

export function useVentilationFeedback(): FanFeedback {
  return useContext(FeedbackContext);
}
