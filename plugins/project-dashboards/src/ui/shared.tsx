import { useEffect, useRef } from "react";
import type { DashboardSettings } from "../contracts.js";
import type { Translate } from "./i18n.js";
import type { Formatter } from "./model.js";

export interface Localized {
  settings: DashboardSettings;
  t: Translate;
  fmt: Formatter;
}

/**
 * Run `tick` every `seconds` while the page is visible (0 = never), and once
 * when the page becomes visible again. Timers are removed on unmount.
 */
export function usePolling(seconds: number, tick: () => void): void {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  });
  useEffect(() => {
    if (seconds <= 0 || typeof document === "undefined") {
      return undefined;
    }
    const run = () => {
      if (document.visibilityState === "visible") {
        latest.current();
      }
    };
    const timer = setInterval(run, seconds * 1000);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [seconds]);
}

export function State({ title, body }: { title: string; body?: string }) {
  return (
    <div className="jpd-state">
      <strong>{title}</strong>
      {body ? <span>{body}</span> : null}
    </div>
  );
}
