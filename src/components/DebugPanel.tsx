import { useState, useEffect, useRef } from "react";

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function getMemory(): MemoryInfo | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mem = (performance as any).memory as MemoryInfo | undefined;
  return mem ?? null;
}

function fmt(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

interface DebugPanelProps {
  filmstripZoom?: number;
}

export default function DebugPanel({ filmstripZoom }: DebugPanelProps) {
  const [mem, setMem] = useState<MemoryInfo | null>(getMemory);
  const prevUsedRef = useRef(mem?.usedJSHeapSize ?? 0);
  const [delta, setDelta] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!getMemory()) return;

    const id = setInterval(() => {
      const m = getMemory();
      if (!m) return;
      setDelta(m.usedJSHeapSize - prevUsedRef.current);
      prevUsedRef.current = m.usedJSHeapSize;
      setMem(m);
    }, 1000);

    return () => clearInterval(id);
  }, []);

  if (!mem) {
    return (
      <div className="vp-debug-panel" style={panelStyle}>
        <span style={labelStyle}>performance.memory not available (Chrome only)</span>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="vp-debug-panel" style={panelStyle} onClick={(e) => { e.stopPropagation(); setCollapsed(false); }}>
        <span style={labelStyle}>DBG</span>
        <span style={{ ...valueStyle, marginLeft: 4 }}>{fmt(mem.usedJSHeapSize)} MB</span>
        <span style={trendStyle(delta)}>{delta > 0 ? " +" : " "}{fmt(delta)}</span>
      </div>
    );
  }

  const pct = (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100;

  return (
    <div className="vp-debug-panel" style={panelStyle} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={labelStyle}>JS Heap</span>
        <span
          style={{ cursor: "pointer", opacity: 0.5, fontSize: 9, marginLeft: 8 }}
          onClick={() => setCollapsed(true)}
        >
          [–]
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Used</span>
        <span style={valueStyle}>
          {fmt(mem.usedJSHeapSize)} MB
          <span style={trendStyle(delta)}>{delta > 0 ? " +" : " "}{fmt(delta)}</span>
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Allocated</span>
        <span style={valueStyle}>{fmt(mem.totalJSHeapSize)} MB</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Limit</span>
        <span style={valueStyle}>{fmt(mem.jsHeapSizeLimit)} MB</span>
      </div>
      <div style={barBg}>
        <div
          style={{
            ...barFg,
            width: `${Math.min(100, pct)}%`,
            backgroundColor: pct > 80 ? "#e74c3c" : pct > 50 ? "#f39c12" : "#2ecc71",
          }}
        />
      </div>
      {filmstripZoom != null && filmstripZoom > 0 && (
        <div style={{ ...rowStyle, marginTop: 4, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 3 }}>
          <span style={labelStyle}>Filmstrip zoom</span>
          <span style={valueStyle}>{filmstripZoom.toFixed(1)} px/s</span>
        </div>
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 48,
  right: 4,
  zIndex: 9999,
  background: "rgba(0, 0, 0, 0.8)",
  color: "#ccc",
  fontSize: 10,
  fontFamily: "monospace",
  padding: "4px 8px",
  borderRadius: 4,
  pointerEvents: "auto",
  cursor: "default",
  minWidth: 120,
  lineHeight: 1.5,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};

const labelStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.5)",
};

const valueStyle: React.CSSProperties = {
  color: "#fff",
  textAlign: "right",
};

const trendStyle = (delta: number): React.CSSProperties => ({
  color: delta > 100_000 ? "#e74c3c" : delta < -100_000 ? "#2ecc71" : "rgba(255,255,255,0.3)",
  fontSize: 9,
});

const barBg: React.CSSProperties = {
  marginTop: 3,
  height: 3,
  borderRadius: 1.5,
  background: "rgba(255,255,255,0.1)",
  overflow: "hidden",
};

const barFg: React.CSSProperties = {
  height: "100%",
  borderRadius: 1.5,
  transition: "width 1s, background-color 1s",
};
