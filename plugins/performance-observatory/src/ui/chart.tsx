import { useMemo } from "react";
import ReactECharts from "echarts-for-react/esm/core.js";
import { useEffect, useState } from "react";
type EChartsModule = typeof import("echarts/core");
declare global { var JourneyPerformanceECharts: EChartsModule | undefined; }
let pending: Promise<EChartsModule> | undefined;
function loadCharts(): Promise<EChartsModule> {
 if (globalThis.JourneyPerformanceECharts) return Promise.resolve(globalThis.JourneyPerformanceECharts);
 if (pending) return pending;
 pending = (async () => {
  const response = await fetch("/api/plugins/ui-contributions");
  if (!response.ok) throw new Error("CHART_ASSET_DISCOVERY_FAILED");
  const contributions: unknown = await response.json();
  if (!Array.isArray(contributions)) throw new Error("CHART_ASSET_DISCOVERY_FAILED");
  const entry = contributions.find((item) => item && typeof item === "object" && Reflect.get(item, "pluginKey") === "journey-studios.performance-observatory");
  const id = entry && Reflect.get(entry, "pluginId");
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("CHART_ASSET_DISCOVERY_FAILED");
  return new Promise<EChartsModule>((resolve, reject) => {
   const script = document.createElement("script");
   script.src = `/_plugins/${encodeURIComponent(id)}/ui/echarts.js?v=0.1.2`;
   script.async = true;
   script.onload = () => { if (globalThis.JourneyPerformanceECharts) resolve(globalThis.JourneyPerformanceECharts); else reject(new Error("CHART_LIBRARY_UNAVAILABLE")); };
   script.onerror = () => reject(new Error("CHART_LIBRARY_UNAVAILABLE"));
   document.head.append(script);
  });
 })();
 return pending;
}

import type { Run } from "./contracts.js";
const metrics: Record<string,string> = { score: "Performance · 0–100", lcp: "LCP · ms", fcp: "FCP · ms", tbt: "TBT · ms", cls: "CLS", bytes: "Transferência · bytes", requests: "Requisições", uiReadyMs: "Interface pronta · ms" };
function chartOptions(runs: Run[], metric: string) {
  const groups = new Map<string, [number, number | null][]>();
  for (const run of [...runs].reverse()) {
    if (!run.result) continue;
    for (const cohort of run.result.cohorts) {
      const label = `${run.target_key} · ${run.environment} · ${run.scenario} · ${run.profile} · ${cohort.cache} · LH ${run.result.lighthouseVersion} · ${run.result.chromeVersion}`;
      const values = groups.get(label) ?? [];
      const value = Reflect.get(cohort, metric);
      let numeric = null;
      if (typeof value === "number") numeric = value;
      values.push([new Date(run.created_at).getTime(), numeric]);
      groups.set(label, values);
    }
  }
  const foreground = getComputedStyle(document.body).color;
  return { animation: false, aria: { enabled: true }, backgroundColor: "transparent", textStyle: { color: foreground },
    tooltip: { trigger: "axis", renderMode: "richText" }, legend: { type: "scroll", top: 0, formatter: (name: string) => name.slice(0, 70), textStyle: { color: foreground } },
    grid: { left: 54, right: 24, bottom: 40, top: 70 }, xAxis: { type: "time" }, yAxis: { type: "value", name: metrics[metric] },
    series: [...groups].map(([name, data]) => ({ name, type: "line", data, connectNulls: false, symbolSize: 7, lineStyle: { width: 2 } })),
  };
}
export default function Chart({runs, metric}: {runs: Run[]; metric: string}) {
 const [library, setLibrary] = useState<EChartsModule | null>(null);
 const [error, setError] = useState(false);
 const options = useMemo(() => chartOptions(runs, metric), [runs, metric]);
 useEffect(() => { let mounted = true; loadCharts().then((value) => { if (mounted) setLibrary(value); }).catch(() => { if (mounted) setError(true); }); return () => { mounted = false; }; }, []);
 if (error) return <p role="alert">Não foi possível carregar o gráfico. As métricas continuam disponíveis na tabela.</p>;
 if (!library) return <p>Carregando gráfico…</p>;
 let theme;
 if (document.documentElement.classList.contains("dark")) theme = "dark";
 return <ReactECharts echarts={library} option={options} theme={theme} notMerge style={{height:360}}/>;
}
