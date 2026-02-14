import { render } from "@testing-library/react";
import {
  PlayIcon,
  PauseIcon,
  VolumeHighIcon,
  VolumeMuteIcon,
  MonitorIcon,
  SpeedIcon,
  FullscreenIcon,
  ExitFullscreenIcon,
  AudioIcon,
  SubtitleIcon,
  CopyLinkIcon,
  StatsNerdIcon,
  AudioLevelsIcon,
  FilmstripIcon,
  PipIcon,
} from "./icons";

const icons = [
  ["PlayIcon", PlayIcon],
  ["PauseIcon", PauseIcon],
  ["VolumeHighIcon", VolumeHighIcon],
  ["VolumeMuteIcon", VolumeMuteIcon],
  ["MonitorIcon", MonitorIcon],
  ["SpeedIcon", SpeedIcon],
  ["FullscreenIcon", FullscreenIcon],
  ["ExitFullscreenIcon", ExitFullscreenIcon],
  ["AudioIcon", AudioIcon],
  ["SubtitleIcon", SubtitleIcon],
  ["CopyLinkIcon", CopyLinkIcon],
  ["StatsNerdIcon", StatsNerdIcon],
  ["AudioLevelsIcon", AudioLevelsIcon],
  ["FilmstripIcon", FilmstripIcon],
  ["PipIcon", PipIcon],
] as const;

describe("icons", () => {
  it.each(icons)("%s renders an SVG element", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });
});
