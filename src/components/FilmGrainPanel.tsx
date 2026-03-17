import type { FilmGrainParams, GrainSize, GrainBlendMode } from "../types/filmGrain";

interface FilmGrainPanelProps {
  params: FilmGrainParams;
  onChange: (params: FilmGrainParams) => void;
  onClose: () => void;
}

export default function FilmGrainPanel({ params, onChange, onClose }: FilmGrainPanelProps) {
  const set = (patch: Partial<FilmGrainParams>) => onChange({ ...params, ...patch });

  return (
    <div className="vp-film-grain-panel" onClick={(e) => e.stopPropagation()}>
      <div className="vp-film-grain-panel-header">
        <span>Film grain</span>
        <button className="vp-film-grain-panel-close" onClick={onClose}>&times;</button>
      </div>

      <label className="vp-film-grain-row">
        <span>Intensity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={params.intensity}
          onChange={(e) => set({ intensity: Number(e.target.value) })}
        />
        <span className="vp-film-grain-value">{params.intensity}</span>
      </label>

      <label className="vp-film-grain-row">
        <span>Grain size</span>
        <select
          value={params.size}
          onChange={(e) => set({ size: e.target.value as GrainSize })}
        >
          <option value="fine">Fine</option>
          <option value="medium">Medium</option>
          <option value="coarse">Coarse</option>
        </select>
      </label>

      <label className="vp-film-grain-row">
        <span>Color</span>
        <select
          value={params.chromatic ? "chromatic" : "mono"}
          onChange={(e) => set({ chromatic: e.target.value === "chromatic" })}
        >
          <option value="mono">Monochromatic</option>
          <option value="chromatic">Chromatic</option>
        </select>
      </label>

      <label className="vp-film-grain-row">
        <span>Blend</span>
        <select
          value={params.blendMode}
          onChange={(e) => set({ blendMode: e.target.value as GrainBlendMode })}
        >
          <option value="additive">Additive</option>
          <option value="multiplicative">Multiplicative</option>
        </select>
      </label>

    </div>
  );
}
