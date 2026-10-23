import { useMemo } from "react";
import ReactECharts from "echarts-for-react/esm/core.js";
import { useEffect, useState } from "react";
import { loadCharts } from "./chart-loader.js";
type EChartsModule = typeof import("echarts/core");
declare global { var JourneyPerformanceECharts: EChartsModule | undefined; }

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
      values.push([new Date(run.created_at_display).getTime(), numeric]);
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
 const [attempt, setAttempt] = useState(0);
 const options = useMemo(() => chartOptions(runs, metric), [runs, metric]);
 useEffect(() => { let mounted = true; setError(false); loadCharts().then((value) => { if (mounted) setLibrary(value); }).catch(() => { if (mounted) setError(true); }); return () => { mounted = false; }; }, [attempt]);
 if (error) return <div><p role="alert">Não foi possível carregar o gráfico. As métricas continuam disponíveis na tabela.</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></div>;
 if (!library) return <p>Carregando gráfico…</p>;
 let theme;
 if (document.documentElement.classList.contains("dark")) theme = "dark";
 return <ReactECharts echarts={library} option={options} theme={theme} notMerge style={{height:360}}/>;
}
