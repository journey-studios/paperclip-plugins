import {
  useHostLocation,
  useHostNavigation,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

export function EvolutionSidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname === "/evolution" || location.pathname.startsWith("/evolution/");

  return (
    <button
      type="button"
      onClick={() => nav.navigate("/evolution")}
      style={{
        width: "100%",
        border: 0,
        borderRadius: 7,
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--accent-foreground)" : "var(--foreground)",
        textAlign: "left",
        padding: "7px 9px",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      Evolution
    </button>
  );
}
