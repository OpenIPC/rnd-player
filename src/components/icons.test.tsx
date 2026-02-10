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
  InfoIcon,
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
  ["InfoIcon", InfoIcon],
] as const;

describe("icons", () => {
  it.each(icons)("%s renders an SVG element", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });
});
