/** Scoped stylesheet (prefix .jph) built on host theme tokens. Injected once per mounted slot root. */
export const styles = `
.jph{--jph-muted:var(--muted-foreground);--jph-soft:var(--muted);--jph-line:var(--border);--jph-bad:#b91c1c;
  color:var(--foreground);font-size:14px;line-height:1.5;box-sizing:border-box;width:100%;max-width:100%;min-width:0}
.dark .jph{--jph-bad:#f87171}
.jph *,.jph *::before,.jph *::after{box-sizing:border-box}
.jph a{color:inherit}
.jph button,.jph input{font:inherit;color:inherit}
.jph-stack{display:grid;gap:20px}
.jph-section{display:grid;gap:10px}
.jph-h2{margin:0;font-size:13px;font-weight:600;color:var(--jph-muted);text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:baseline;gap:8px}
.jph-title{margin:0;font-size:1.25rem;font-weight:650;letter-spacing:-0.01em}
.jph-muted{color:var(--jph-muted)}
.jph-small{font-size:12.5px}
.jph-path{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
.jph-path a{text-decoration:none}
.jph-path a:hover{text-decoration:underline;text-underline-offset:2px}
.jph-sep{color:var(--jph-muted)}
.jph-current{font-weight:600}
.jph-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.jph-card{border:1px solid var(--jph-line);border-radius:var(--radius);overflow:hidden;background:var(--card)}
.jph-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--jph-line);min-width:0}
.jph-item:last-child{border-bottom:0}
.jph-item:hover{background:var(--jph-soft)}
.jph-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
.jph-name:hover{text-decoration:underline;text-underline-offset:2px}
.jph-dot{width:10px;height:10px;border-radius:3px;flex:none;background:var(--jph-line)}
.jph-pill{font-size:11.5px;padding:1px 8px;border-radius:999px;border:1px solid var(--jph-line);color:var(--jph-muted);white-space:nowrap}
.jph-count{font-size:12px;color:var(--jph-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.jph-toggle{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;border-radius:4px;cursor:pointer;color:var(--jph-muted);flex:none}
.jph-toggle:hover{background:var(--jph-soft);color:var(--foreground)}
.jph-toggle svg{transition:transform .15s ease}
.jph-toggle[aria-expanded="true"] svg{transform:rotate(90deg)}
.jph-spacer{width:18px;flex:none}
.jph-btn{border:1px solid var(--jph-line);background:transparent;border-radius:calc(var(--radius) * .8);padding:4px 10px;font-size:12.5px;cursor:pointer;white-space:nowrap}
.jph-btn:hover:not(:disabled){background:var(--jph-soft)}
.jph-btn:disabled{opacity:.55;cursor:default}
.jph-field{border:1px solid var(--jph-line);background:var(--background);border-radius:calc(var(--radius) * .8);padding:5px 8px;min-width:0}
.jph-btn:focus-visible,.jph-field:focus-visible,.jph-toggle:focus-visible,.jph-name:focus-visible{outline:2px solid var(--ring,var(--foreground));outline-offset:2px}
.jph-error{color:var(--jph-bad);font-size:12.5px}
.jph-state{padding:20px;border:1px dashed var(--jph-line);border-radius:var(--radius);color:var(--jph-muted);display:grid;gap:4px}
.jph-state strong{color:var(--foreground)}
.jph-nav{display:flex;align-items:center;gap:8px;width:100%;color:inherit;text-decoration:none!important;padding:6px 10px;border-radius:calc(var(--radius) * .8)}
.jph-nav:hover{background:var(--jph-soft)}
.jph-icon{width:16px;height:16px;flex:none}
.jph-page{display:grid;gap:16px;padding:16px}
`;
