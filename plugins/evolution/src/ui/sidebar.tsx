import { useHostNavigation, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

export function EvolutionSidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return (
    <a {...nav.linkProps("/evolution")}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="6" cy="6" r="3" /><path d="M6 9v12M18 15V3M6 15h6a6 6 0 0 0 6-6" />
        <circle cx="18" cy="18" r="3" />
      </svg>
      <span>Evolution</span>
    </a>
  );
}
