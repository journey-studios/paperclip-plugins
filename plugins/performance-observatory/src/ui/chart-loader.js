/** @type {Promise<import("echarts/core")> | undefined} */
let pending;

/** @returns {Promise<import("echarts/core")>} */
export function loadCharts() {
  if (globalThis.JourneyPerformanceECharts) return Promise.resolve(globalThis.JourneyPerformanceECharts);
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch("/api/plugins/ui-contributions");
    if (!response.ok) throw new Error("CHART_ASSET_DISCOVERY_FAILED");
    const contributions = await response.json();
    if (!Array.isArray(contributions)) throw new Error("CHART_ASSET_DISCOVERY_FAILED");
    const entry = contributions.find((item) => item && typeof item === "object" && Reflect.get(item, "pluginKey") === "journey-studios.performance-observatory");
    const id = entry && Reflect.get(entry, "pluginId");
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("CHART_ASSET_DISCOVERY_FAILED");
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/_plugins/${encodeURIComponent(id)}/ui/echarts.js?v=0.1.4`;
      script.async = true;
      script.onload = () => {
        if (globalThis.JourneyPerformanceECharts) return resolve(globalThis.JourneyPerformanceECharts);
        script.remove();
        reject(new Error("CHART_LIBRARY_UNAVAILABLE"));
      };
      script.onerror = () => { script.remove(); reject(new Error("CHART_LIBRARY_UNAVAILABLE")); };
      document.head.append(script);
    });
  })().catch((error) => { pending = undefined; throw error; });
  return pending;
}
