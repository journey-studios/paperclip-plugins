/** Scoped stylesheet (prefix .jpd) built on host theme tokens. Injected once per mounted slot root. */
export const styles = `
.jpd{--jpd-ok:#15803d;--jpd-warn:#b45309;--jpd-bad:#b91c1c;--jpd-info:#1d4ed8;--jpd-muted:var(--muted-foreground);
  --jpd-soft:var(--muted);--jpd-line:var(--border);--jpd-gap:16px;
  container-type:inline-size;container-name:jpd;color:var(--foreground);font-size:14px;line-height:1.5;
  font-variant-numeric:tabular-nums;box-sizing:border-box;width:100%;max-width:100%;min-width:0}
.dark .jpd{--jpd-ok:#4ade80;--jpd-warn:#fbbf24;--jpd-bad:#f87171;--jpd-info:#60a5fa}
.jpd *,.jpd *::before,.jpd *::after{box-sizing:border-box}
.jpd a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.jpd button,.jpd select,.jpd input{font:inherit;color:inherit}
.jpd-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.jpd-page{display:grid;gap:24px;padding:0 0 32px}
.jpd-head{display:grid;gap:8px}
.jpd-title{margin:0;font-size:clamp(1.5rem,1.1rem + 1.6vw,2.1rem);line-height:1.15;font-weight:650;letter-spacing:-0.02em;font-family:ui-serif,Georgia,"Times New Roman",serif}
.jpd-summary{max-width:78ch;color:var(--foreground)}
.jpd-meta{color:var(--jpd-muted);font-size:12.5px}
.jpd-meta>p{margin:0}
.jpd-section{display:grid;gap:12px}
.jpd-h2{margin:0;font-size:1.15rem;font-weight:600;letter-spacing:-0.01em}
.jpd-note{color:var(--jpd-muted);font-size:13px;max-width:80ch}
.jpd-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--jpd-gap);align-items:start}
.jpd-grid[data-cols="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.jpd-grid[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.jpd-grid[data-cols="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
.jpd-grid>[data-span="2"]{grid-column:span 2}.jpd-grid>[data-span="3"]{grid-column:span 3}.jpd-grid>[data-span="4"]{grid-column:span 4}
.jpd-card{container-type:inline-size;container-name:jpdcard;background:var(--card);color:var(--card-foreground,var(--foreground));border:1px solid var(--jpd-line);border-radius:var(--radius);padding:16px;min-width:0;display:grid;gap:12px}
.jpd-card-title{margin:0;font-size:14px;font-weight:600}
.jpd-card-note{color:var(--jpd-muted);font-size:12.5px}
.jpd-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--jpd-gap)}
.jpd-kpi{display:grid;gap:4px;align-content:start}
.jpd-kpi-label{font-size:12px;color:var(--jpd-muted);text-transform:uppercase;letter-spacing:.04em}
.jpd-kpi-value{font-family:ui-serif,Georgia,"Times New Roman",serif;font-size:clamp(1.7rem,1.2rem + 1.8vw,2.4rem);line-height:1.1;font-weight:600;overflow-wrap:anywhere}
.jpd-kpi-of{font-family:inherit;font-size:.5em;font-weight:400;color:var(--jpd-muted)}
.jpd-kpi-caption{font-size:12.5px;color:var(--jpd-muted)}
.jpd-tone-ok{color:var(--jpd-ok)}.jpd-tone-warn{color:var(--jpd-warn)}.jpd-tone-bad{color:var(--jpd-bad)}.jpd-tone-info{color:var(--jpd-info)}.jpd-tone-muted{color:var(--jpd-muted)}
.jpd-callout{display:grid;gap:4px;border:1px solid currentColor;border-radius:var(--radius);padding:12px 14px;background:color-mix(in srgb,currentColor 8%,transparent)}
.jpd-callout>*{color:var(--foreground)}
.jpd-callout-tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.jpd-dot{display:inline-block;width:10px;height:10px;vertical-align:-1px;flex:none}
.jpd-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.jpd-prio{font-weight:600}
.jpd-table-wrap{display:grid;gap:10px;min-width:0}
.jpd-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.jpd-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--jpd-line);background:transparent;border-radius:999px;padding:3px 10px;font-size:12.5px;cursor:pointer}
.jpd-chip:hover{background:var(--jpd-soft)}
.jpd-chip[aria-pressed="true"]{background:var(--foreground);color:var(--background);border-color:var(--foreground)}
.jpd-chip-count{opacity:.7}
.jpd-field{border:1px solid var(--jpd-line);background:var(--background);border-radius:calc(var(--radius) * .8);padding:5px 8px;min-width:0;max-width:100%}
.jpd-field:focus-visible,.jpd-chip:focus-visible,.jpd-btn:focus-visible,.jpd-link:focus-visible,.jpd-bar:focus-visible{outline:2px solid var(--ring,var(--foreground));outline-offset:2px}
.jpd-count{margin-left:auto;font-size:12px;color:var(--jpd-muted)}
.jpd-scroll{overflow-x:auto;max-width:100%}
.jpd-table{width:100%;border-collapse:collapse;font-size:13px}
.jpd-table th{text-align:left;font-weight:600;font-size:12px;color:var(--jpd-muted);padding:6px 10px;border-bottom:1px solid var(--jpd-line);white-space:nowrap}
.jpd-table td{padding:8px 10px;border-bottom:1px solid var(--jpd-line);vertical-align:top}
.jpd-table tr:last-child td{border-bottom:0}
.jpd-nw{white-space:nowrap}
.jpd-nw .jpd-code{white-space:nowrap;overflow-wrap:normal}
.jpd-table td.jpd-wide{min-width:220px;overflow-wrap:anywhere}
.jpd-table td.jpd-num{text-align:right}
.jpd-table th.jpd-num{text-align:right}
.jpd-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--jpd-soft);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.jpd-muted{color:var(--jpd-muted)}.jpd-strong{font-weight:600}
.jpd-empty{padding:20px;text-align:center;color:var(--jpd-muted)}
.jpd-statuslist{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin:0;padding:0;list-style:none}
.jpd-statusitem{border:1px solid var(--jpd-line);border-radius:var(--radius);padding:12px;display:grid;gap:2px;min-width:0}
.jpd-statusitem-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.jpd-statusitem-name{font-weight:600;overflow-wrap:anywhere}
.jpd-statusitem-value{font-family:ui-serif,Georgia,serif;font-size:1.6rem;font-weight:600;line-height:1.2}
.jpd-chart{position:relative;min-width:0;display:grid;gap:8px}
.jpd-chart svg{display:block;width:100%;height:auto;overflow:visible}
.jpd-axis{stroke:var(--jpd-line);stroke-width:1}
.jpd-grid-line{stroke:var(--jpd-line);stroke-width:1;stroke-dasharray:2 3}
.jpd-tick{fill:var(--jpd-muted);font-size:11px;font-variant-numeric:tabular-nums}
.jpd-bar{transition:opacity .12s}
.jpd-bar-dim{opacity:.45}
.jpd-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--jpd-muted);margin:0;padding:0;list-style:none}
.jpd-legend li{display:inline-flex;align-items:center;gap:6px}
.jpd-swatch{width:10px;height:10px;border-radius:2px;flex:none}
.jpd-tooltip{position:absolute;z-index:5;pointer-events:none;background:var(--popover,var(--card));color:var(--popover-foreground,var(--foreground));border:1px solid var(--jpd-line);border-radius:calc(var(--radius) * .8);padding:6px 9px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.14);max-width:240px;display:grid;gap:2px}
.jpd-tooltip-title{font-weight:600}
.jpd-tooltip-row{display:flex;gap:6px;align-items:center;justify-content:space-between}
.jpd-tooltip-row span:last-child{font-variant-numeric:tabular-nums;font-weight:600}
.jpd-progress{display:grid;gap:10px}
.jpd-progress-row{display:grid;gap:4px}
.jpd-progress-top{display:flex;justify-content:space-between;gap:8px;font-size:13px}
.jpd-progress-track{height:8px;border-radius:999px;background:var(--jpd-soft);overflow:hidden}
.jpd-progress-fill{height:100%;border-radius:999px}
.jpd-progress-track{position:relative}
.jpd-goal{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--foreground);opacity:.7}
.jpd-sources{border:1px solid var(--jpd-line);border-radius:var(--radius);background:var(--card)}
.jpd-sources>summary{cursor:pointer;padding:12px 16px;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px}
.jpd-sources>summary::-webkit-details-marker{display:none}
.jpd-sources>summary::before{content:"";width:6px;height:6px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .12s}
.jpd-sources[open]>summary::before{transform:rotate(45deg)}
.jpd-sources-body{padding:0 16px 16px;display:grid;gap:12px}
.jpd-source{display:grid;gap:2px;border-top:1px solid var(--jpd-line);padding-top:10px}
.jpd-source-title{font-weight:600}
.jpd-source-line{font-size:12.5px;color:var(--jpd-muted);overflow-wrap:anywhere}
.jpd-list{display:grid;gap:20px}
.jpd-group{display:grid;gap:8px}
.jpd-group-title{margin:0;font-size:12px;color:var(--jpd-muted);text-transform:uppercase;letter-spacing:.05em;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.jpd-project-link{color:inherit}
.jpd-group-count{font-size:12px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--jpd-muted)}
.jpd-divider{border:0;border-top:1px solid var(--jpd-line);margin:8px 0}
.jpd-orphans{border:1px dashed var(--jpd-line);border-radius:var(--radius);padding:12px 16px;display:grid;gap:8px}
.jpd-orphans>summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.jpd-item-orphan{align-content:start}
.jpd-item-orphan .jpd-item-link{color:inherit;text-decoration:none}
.jpd-move{display:inline-grid;gap:4px;justify-items:start}
.jpd-orphan-warning{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;border:1px solid currentColor;border-radius:var(--radius);padding:8px 12px;font-size:13px}
.jpd-project-line{font-size:13px}
.jpd-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.jpd-item{display:grid;gap:4px;border:1px solid var(--jpd-line);border-radius:var(--radius);padding:12px 14px;background:var(--card);text-decoration:none!important;color:inherit}
.jpd-item:hover{background:var(--jpd-soft)}
.jpd-item-title{font-weight:600}
.jpd-item-sub{font-size:12.5px;color:var(--jpd-muted)}
.jpd-bar-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.jpd-btn{border:1px solid var(--jpd-line);background:transparent;border-radius:calc(var(--radius) * .8);padding:4px 10px;font-size:12.5px;cursor:pointer}
.jpd-btn:hover{background:var(--jpd-soft)}
.jpd-btn-danger{color:var(--jpd-bad)}
.jpd-state{padding:24px;border:1px dashed var(--jpd-line);border-radius:var(--radius);color:var(--jpd-muted);display:grid;gap:6px}
.jpd-state strong{color:var(--foreground)}
.jpd-error{color:var(--jpd-bad)}
.jpd-live{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:12px;color:var(--jpd-muted)}
.jpd-live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--jpd-ok);margin-right:6px}
.jpd-live-off .jpd-live-dot{background:var(--jpd-muted)}
.jpd-notice{color:var(--foreground);background:var(--jpd-soft);border-radius:999px;padding:2px 10px}
.jpd-stale-banner{display:inline-block;justify-self:start;font-size:12.5px;font-weight:600;border:1px solid currentColor;border-radius:999px;padding:2px 10px}
.jpd-badge-stale{margin-left:8px;font-size:11px;font-weight:600;color:var(--jpd-warn);border:1px solid currentColor;border-radius:999px;padding:1px 8px}
.jpd-history{display:grid;gap:6px;font-size:13px}
.jpd-history-row{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid var(--jpd-line);padding-top:6px}
.jpd-nav{display:flex;align-items:center;gap:8px;width:100%;color:inherit;text-decoration:none!important;padding:6px 10px;border-radius:calc(var(--radius) * .8)}
.jpd-nav:hover{background:var(--jpd-soft)}
.jpd-icon{width:16px;height:16px;flex:none}
.jpd .paperclip-markdown>*:first-child,.jpd-md>*:first-child{margin-top:0}
/* Small muted text keeps its size and color even when the host Markdown renderer sets its own. */
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown{font-size:inherit;line-height:inherit;color:inherit}
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown :is(p,li,ul,ol,blockquote,strong,em,code){font-size:inherit;line-height:inherit;color:inherit}
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown :is(p,ul,ol,blockquote){margin-top:.25em;margin-bottom:.25em}
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown li{margin:.1em 0}
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown code{padding:0 .25em}
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown > :is(:first-child){margin-top:0}
.jpd :is(.jpd-note,.jpd-card-note,.jpd-meta,.jpd-kpi-caption,.jpd-source-line) .paperclip-markdown > :is(:last-child){margin-bottom:0}
.jpd-md>*:last-child{margin-bottom:0}
@container jpd (max-width:760px){
  .jpd-grid[data-cols="3"],.jpd-grid[data-cols="4"]{grid-template-columns:repeat(2,minmax(0,1fr))}
  .jpd-grid>[data-span="3"],.jpd-grid>[data-span="4"]{grid-column:span 2}
}
@container jpd (max-width:520px){
  .jpd-grid,.jpd-grid[data-cols]{grid-template-columns:minmax(0,1fr)}
  .jpd-grid>[data-span]{grid-column:auto}
  .jpd-card{padding:12px}
  .jpd-count{margin-left:0;width:100%}
}
@container jpdcard (max-width:600px){
  .jpd-table.jpd-collapse thead{display:none}
  .jpd-table.jpd-collapse,.jpd-table.jpd-collapse tbody,.jpd-table.jpd-collapse tr,.jpd-table.jpd-collapse td{display:block;width:100%}
  .jpd-table.jpd-collapse tr{border:1px solid var(--jpd-line);border-radius:calc(var(--radius) * .8);margin-bottom:8px;padding:4px 0}
  .jpd-table.jpd-collapse td{border:0;padding:4px 10px;display:grid;grid-template-columns:minmax(80px,38%) 1fr;gap:8px;text-align:left!important}
  .jpd-table.jpd-collapse td::before{content:attr(data-label);color:var(--jpd-muted);font-size:12px}
  .jpd-table.jpd-collapse td.jpd-wide{min-width:0}
}
@media (prefers-reduced-motion:reduce){.jpd *{transition:none!important}}
`;
