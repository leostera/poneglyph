import React from "react";
import { Composition } from "remotion";
import { PoneglyphExplainer, VIDEO_DURATION_FRAMES, VIDEO_FPS } from "./Explainer";

export type ExplainerProps = Readonly<{ includeVoiceover: boolean }>;

export const RemotionRoot: React.FC = () => (
  <Composition
    id="PoneglyphExplainer"
    component={PoneglyphExplainer}
    durationInFrames={VIDEO_DURATION_FRAMES}
    fps={VIDEO_FPS}
    width={1920}
    height={1080}
    defaultProps={{ includeVoiceover: false }}
  />
);
