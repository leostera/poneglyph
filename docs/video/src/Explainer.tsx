import React from "react";
import { AbsoluteFill, Audio, Easing, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { ExplainerProps } from "./video";

export const VIDEO_FPS = 30;
const SCENE_SECONDS = 50;
const SCENE_FRAMES = SCENE_SECONDS * VIDEO_FPS;
export const VIDEO_DURATION_FRAMES = SCENE_FRAMES * 6;

const ink = {
  background: "#000000",
  white: "#e7e5df",
  pale: "#b8b8b2",
  dim: "#686968",
  yellow: "#d7c978",
  blue: "#78a9bd",
  coral: "#c88b83",
  green: "#82a88b",
};

const chapters = [
  { id: "connections", title: "A database your app builds with" },
  { id: "facts", title: "Start with the developer's request" },
  { id: "history", title: "Facts keep their evidence" },
  { id: "queries", title: "Ask across the connections" },
  { id: "transactions", title: "How it runs on Cloudflare" },
  { id: "sharding", title: "When a graph database fits" },
] as const;

function progress(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
}

function appear(frame: number, at: number, length = 32): number {
  return progress(frame, at, at + length);
}

const SceneShell: React.FC<{ title: string; children: React.ReactNode; showLogo?: boolean }> = ({ title, children, showLogo = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleSpring = spring({ frame, fps, config: { damping: 24, stiffness: 75, mass: 1 } });
  return (
    <AbsoluteFill style={{ backgroundColor: ink.background, color: ink.white, fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div style={{ position: "absolute", top: 78, left: 82, opacity: titleSpring, fontSize: 43, letterSpacing: -0.3, fontWeight: 400, fontStyle: "italic" }}>
        {title}
      </div>
      {showLogo && <Img src={staticFile("poneglyph.png")} alt="Poneglyph" style={{ position: "absolute", top: 48, right: 82, width: 76, height: 76, objectFit: "contain", opacity: 0.92 }} />}
      <div style={{ position: "absolute", inset: 0 }}>{children}</div>
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = ink.pale, style }) => (
  <div style={{ color, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontStyle: "italic", ...style }}>{children}</div>
);

const Equation: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = ink.white, style }) => (
  <div style={{ color, fontSize: 27, fontStyle: "italic", letterSpacing: 0.1, ...style }}>{children}</div>
);

const Stroke: React.FC<{ x1: number; y1: number; x2: number; y2: number; color?: string; at: number; frame: number; width?: number }> = ({ x1, y1, x2, y2, color = ink.pale, at, frame, width = 2.5 }) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const draw = appear(frame, at, 42);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} strokeDasharray={length} strokeDashoffset={length * (1 - draw)} opacity={draw} />;
};

const Node: React.FC<{ x: number; y: number; label: string; color: string; frame: number; at: number; sub?: string; side?: "above" | "below" }> = ({ x, y, label, color, frame, at, sub, side = "below" }) => {
  const enter = appear(frame, at, 45);
  const lift = interpolate(enter, [0, 1], [18, 0]);
  return <g opacity={enter} transform={`translate(0 ${lift})`}>
    <circle cx={x} cy={y} r="19" fill={`${color}20`} stroke={color} strokeWidth="2" />
    <circle cx={x} cy={y} r="5" fill={color} />
    <text x={x} y={y + (side === "below" ? 42 : -30)} textAnchor="middle" fill={ink.white} fontSize="23" fontFamily="Georgia, serif" fontStyle="italic">{label}</text>
    {sub && <text x={x} y={y + (side === "below" ? 68 : -8)} textAnchor="middle" fill={color} fontSize="13" fontFamily="Menlo, monospace" letterSpacing="1">{sub}</text>}
  </g>;
};

const SceneOne: React.FC = () => {
  const frame = useCurrentFrame();
  const path = progress(frame, 560, 1010);
  return <SceneShell title="A database your app builds with" showLogo>
    <Caption style={{ position: "absolute", top: 235, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 15) }}>A Jedi archive: trace a Padawan's lineage to a Jedi who went dark</Caption>
    <div style={{ position: "absolute", top: 290, left: 0, right: 0, textAlign: "center", color: ink.dim, fontFamily: "Menlo, monospace", fontSize: 17, opacity: appear(frame, 80) }}>D1: relational tables  ·  Durable Object: SQLite + per-archive coordination</div>
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <Stroke x1={545} y1={515} x2={930} y2={515} color={ink.yellow} at={90} frame={frame} />
      <Stroke x1={990} y1={515} x2={1375} y2={515} color={ink.coral} at={230} frame={frame} />
      <path d="M 1375 538 C 1475 580, 1400 690, 1010 741" fill="none" stroke={ink.green} strokeWidth="2.5" strokeDasharray="470" strokeDashoffset={470 * (1 - appear(frame, 370, 42))} opacity={appear(frame, 370, 42)} />
      <Node x={545} y={515} label="Obi-Wan" color={ink.yellow} frame={frame} at={30} sub="Padawan" />
      <Node x={960} y={515} label="Qui-Gon" color={ink.blue} frame={frame} at={160} sub="Master" />
      <Node x={1375} y={515} label="Dooku" color={ink.coral} frame={frame} at={300} sub="Master" />
      <Node x={960} y={760} label="dark side" color={ink.green} frame={frame} at={440} sub="alignment" side="below" />
      <text x="738" y="490" textAnchor="middle" fill={ink.yellow} fontSize="21" fontStyle="italic" opacity={appear(frame, 130)}>padawan of</text>
      <text x="1180" y="490" textAnchor="middle" fill={ink.coral} fontSize="21" fontStyle="italic" opacity={appear(frame, 270)}>padawan of</text>
      <text x="1240" y="665" textAnchor="middle" fill={ink.green} fontSize="21" fontStyle="italic" opacity={appear(frame, 420)}>alignment</text>
      <circle cx={545 + 385 * path} cy="515" r="10" fill={ink.yellow} opacity={path} />
      <circle cx={990 + 385 * Math.max(0, Math.min(1, (path - 0.5) * 2))} cy="515" r="10" fill={ink.coral} opacity={Math.max(0, (path - 0.5) * 2)} />
    </svg>
    <Equation style={{ position: "absolute", left: 0, right: 0, top: 842, textAlign: "center", opacity: appear(frame, 700) }}>
      fixed joins are easy · <span style={{ color: ink.yellow }}>any depth means recursive traversal</span>
    </Equation>
    <div style={{ position: "absolute", left: 0, right: 0, top: 930, textAlign: "center", color: ink.dim, fontFamily: "Avenir Next, sans-serif", fontSize: 20, opacity: appear(frame, 900) }}>
      Poneglyph's graph model is the fit; its current query engine has limits.
    </div>
  </SceneShell>;
};

const SceneTwo: React.FC = () => {
  const frame = useCurrentFrame();
  const fields = ["source", "entity", "field", "value"];
  const activeField = Math.min(fields.length - 1, Math.floor(frame / 220));
  const highlightY = 354 + activeField * 48;
  return <SceneShell title="Start with the developer's request">
    <Caption style={{ position: "absolute", top: 210, left: 115, opacity: appear(frame, 20) }}>A typed assertion, with its source attached</Caption>
    <div style={{ position: "absolute", top: 300, left: 115, width: 820, fontFamily: "Menlo, monospace", fontSize: 23, lineHeight: "48px" }}>
      <div style={{ position: "absolute", top: highlightY - 300, left: -14, width: 770, height: 43, border: `1px solid ${ink.yellow}`, opacity: appear(frame, 50, 30) }} />
      <div style={{ color: ink.dim }}>{"{"}</div>
      <div><span style={{ color: ink.blue }}>  source</span><span style={{ color: ink.pale }}>: </span><span style={{ color: ink.yellow }}>&quot;app:release-checklist&quot;</span><span style={{ color: ink.pale }}>,</span></div>
      <div><span style={{ color: ink.blue }}>  entity</span><span style={{ color: ink.pale }}>: </span><span style={{ color: ink.yellow }}>&quot;app:service:auth-api&quot;</span><span style={{ color: ink.pale }}>,</span></div>
      <div><span style={{ color: ink.blue }}>  field</span><span style={{ color: ink.pale }}>: </span><span style={{ color: ink.yellow }}>&quot;app:service:blocked-by&quot;</span><span style={{ color: ink.pale }}>,</span></div>
      <div style={{ fontSize: 18 }}><span style={{ color: ink.blue }}>  value</span><span style={{ color: ink.pale }}>: {"{"} type: </span><span style={{ color: ink.green }}>&quot;reference&quot;</span><span style={{ color: ink.pale }}>, value: &quot;app:task:rotate-key&quot; {"}"}</span></div>
      <div style={{ color: ink.dim }}>{"}"}</div>
    </div>
    <div style={{ position: "absolute", top: 635, left: 115, width: 820, fontFamily: "Menlo, monospace", fontSize: 20, opacity: appear(frame, 940) }}>
      <span style={{ color: ink.blue }}>await</span> graph.<span style={{ color: ink.green }}>stateFacts</span>(facts, {"{"} txId {"}"});
    </div>
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <line x1="1090" y1="610" x2="1760" y2="610" stroke={ink.pale} strokeWidth="1.5" opacity={appear(frame, 540)} />
      <circle cx="1130" cy="610" r="6" fill={ink.yellow} opacity={appear(frame, 520)} />
      <circle cx="1350" cy="610" r="6" fill={ink.blue} opacity={appear(frame, 620)} />
      <circle cx="1510" cy="610" r="6" fill={ink.coral} opacity={appear(frame, 720)} />
      <circle cx="1730" cy="610" r="6" fill={ink.green} opacity={appear(frame, 820)} />
      <line x1="1130" y1="610" x2="1350" y2="610" stroke={ink.yellow} strokeWidth="2" strokeDasharray="220" strokeDashoffset={220 * (1 - appear(frame, 580, 45))} />
      <line x1="1350" y1="610" x2="1510" y2="610" stroke={ink.blue} strokeWidth="2" strokeDasharray="160" strokeDashoffset={160 * (1 - appear(frame, 680, 45))} />
      <line x1="1510" y1="610" x2="1730" y2="610" stroke={ink.green} strokeWidth="2" strokeDasharray="220" strokeDashoffset={220 * (1 - appear(frame, 780, 45))} />
    </svg>
    <div style={{ position: "absolute", top: 535, left: 1050, width: 160, textAlign: "center", opacity: appear(frame, 520) }}><Caption color={ink.yellow}>source</Caption></div>
    <div style={{ position: "absolute", top: 535, left: 1260, width: 180, textAlign: "center", opacity: appear(frame, 620) }}><Caption color={ink.blue}>entity</Caption></div>
    <div style={{ position: "absolute", top: 535, left: 1420, width: 180, textAlign: "center", opacity: appear(frame, 720) }}><Caption color={ink.coral}>field</Caption></div>
    <div style={{ position: "absolute", top: 535, left: 1630, width: 170, textAlign: "center", opacity: appear(frame, 820) }}><Caption color={ink.green}>value</Caption></div>
    <div style={{ position: "absolute", top: 640, left: 1040, right: 105, textAlign: "center", opacity: appear(frame, 900) }}>
      <Equation style={{ fontSize: 25 }}>the reference is a link—not duplicated text</Equation>
    </div>
    <div style={{ position: "absolute", top: 790, left: 115, right: 115, color: ink.dim, fontFamily: "Georgia, serif", fontStyle: "italic", fontSize: 21, opacity: appear(frame, 1080) }}>
      Retried writes keep one transaction identity. A changed payload with the same id is a conflict.
    </div>
  </SceneShell>;
};

const SceneThree: React.FC = () => {
  const frame = useCurrentFrame();
  const current = progress(frame, 790, 1150);
  return <SceneShell title="Facts keep their evidence">
    <Caption style={{ position: "absolute", top: 265, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 20) }}>The log grows. It does not overwrite.</Caption>
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <line x1="270" y1="495" x2="1650" y2="495" stroke={ink.pale} strokeWidth="2" opacity={0.45} />
      {[430, 960, 1490].map((x, index) => <g key={x} opacity={appear(frame, 80 + index * 185)}>
        <circle cx={x} cy="495" r="12" fill={[ink.coral, ink.yellow, ink.green][index]} />
        <line x1={x} y1="495" x2={x} y2="555" stroke={[ink.coral, ink.yellow, ink.green][index]} strokeWidth="2" />
      </g>)}
      <path d="M 430 675 C 640 790, 780 790, 960 675 S 1290 655, 1490 675" fill="none" stroke={ink.blue} strokeWidth="3" strokeDasharray="1500" strokeDashoffset={1500 * (1 - current)} opacity={current} />
      <circle cx={430 + 1060 * current} cy={675 + Math.sin(current * Math.PI) * 115} r="8" fill={ink.blue} opacity={current} />
    </svg>
    <div style={{ position: "absolute", top: 375, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 45) }}>
      <Caption color={ink.yellow}>append-only fact log</Caption>
    </div>
    <Equation style={{ position: "absolute", left: 205, top: 575, width: 450, textAlign: "center", fontSize: 30, opacity: appear(frame, 95) }} color={ink.coral}>
      + status(open)
    </Equation>
    <Equation style={{ position: "absolute", left: 725, top: 575, width: 470, textAlign: "center", fontSize: 30, opacity: appear(frame, 290) }} color={ink.yellow}>
      − retract(open)
    </Equation>
    <Equation style={{ position: "absolute", left: 1265, top: 575, width: 450, textAlign: "center", fontSize: 30, opacity: appear(frame, 475) }} color={ink.green}>
      + status(done)
    </Equation>
    <div style={{ position: "absolute", top: 785, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 790) }}>
      <Caption color={ink.blue}>replay the evidence</Caption>
      <Equation style={{ fontSize: 40, marginTop: 20 }}>current view: task status = done</Equation>
    </div>
    <div style={{ position: "absolute", top: 900, left: 0, right: 0, textAlign: "center", color: ink.dim, fontFamily: "Avenir Next, sans-serif", fontSize: 20, opacity: appear(frame, 1060) }}>
      The entity and index views are projections—not another source of truth.
    </div>
  </SceneShell>;
};

const SceneFour: React.FC = () => {
  const frame = useCurrentFrame();
  const join = progress(frame, 460, 1020);
  const active = progress(frame, 790, 1170);
  return <SceneShell title="Ask across the connections">
    <Caption style={{ position: "absolute", top: 265, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 20) }}>A bounded Datalog query follows relationships through shared variables</Caption>
    <div style={{ position: "absolute", top: 365, left: 115, width: 660, opacity: appear(frame, 60) }}>
      <Equation style={{ fontSize: 24, fontFamily: "Menlo, monospace", fontStyle: "normal" }}><span style={{ color: ink.coral }}>app:service:blocked-by</span>(<span style={{ color: ink.blue }}>Service</span>, <span style={{ color: ink.green }}>Task</span>)</Equation>
      <div style={{ width: 700, height: 1, background: "#ffffff33", margin: "22px 0" }} />
      <Equation style={{ fontSize: 24, fontFamily: "Menlo, monospace", fontStyle: "normal" }}><span style={{ color: ink.yellow }}>app:task:status</span>(<span style={{ color: ink.green }}>Task</span>, &quot;open&quot;)</Equation>
      <div style={{ marginTop: 34, color: ink.pale, fontFamily: "Avenir Next, sans-serif", fontSize: 21 }}>
        <span style={{ color: ink.green }}>Task</span> is shared: matching entities make the join.
      </div>
    </div>
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <Stroke x1={970} y1={545} x2={1245} y2={545} color={ink.yellow} at={175} frame={frame} />
      <Stroke x1={1245} y1={545} x2={1530} y2={545} color={ink.green} at={310} frame={frame} />
      <Node x={970} y={545} label="Auth API" color={ink.yellow} frame={frame} at={100} sub="Service" />
      <Node x={1245} y={545} label="rotate-key" color={ink.blue} frame={frame} at={220} sub="shared Task" />
      <Node x={1530} y={545} label="open" color={ink.green} frame={frame} at={340} sub="status" />
      <circle cx={970 + 275 * join} cy="545" r="9" fill={ink.yellow} opacity={join} />
      <circle cx={1245 + 285 * Math.max(0, Math.min(1, (join - 0.48) * 1.92))} cy="545" r="9" fill={ink.green} opacity={Math.max(0, (join - 0.48) * 1.92)} />
      <path d="M 970 640 C 1130 735, 1370 735, 1530 640" fill="none" stroke={ink.blue} strokeWidth="2" strokeDasharray="780" strokeDashoffset={780 * (1 - active)} opacity={active} />
    </svg>
    <Equation style={{ position: "absolute", top: 770, left: 0, right: 0, textAlign: "center", opacity: active }}>
      binding + binding <span style={{ color: ink.dim }}>→</span> join
    </Equation>
    <div style={{ position: "absolute", top: 850, left: 0, right: 0, textAlign: "center", color: ink.dim, fontFamily: "Avenir Next, sans-serif", fontSize: 20, opacity: appear(frame, 1080) }}>
      Limits on results, scan work, time, and fan-out keep the query bounded.
    </div>
  </SceneShell>;
};

const SceneFive: React.FC = () => {
  const frame = useCurrentFrame();
  const committed = progress(frame, 910, 1100);
  const phase = frame < 320 ? 0 : frame < 590 ? 1 : frame < 920 ? 2 : 3;
  const sequence = interpolate(committed, [0, 1], [42, 43]);
  return <SceneShell title="How it runs on Cloudflare">
    <Caption style={{ position: "absolute", top: 260, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 20) }}>The Worker API routes each graph to its Durable Object coordinator</Caption>
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <line x1="960" y1="380" x2="960" y2="450" stroke={ink.yellow} strokeWidth="2" opacity={0.8} />
      <circle cx="960" cy="360" r="18" fill={`${ink.yellow}22`} stroke={ink.yellow} strokeWidth="2" />
      <circle cx="960" cy="360" r="5" fill={ink.yellow} />
      <line x1="520" y1="510" x2="1400" y2="510" stroke={ink.dim} strokeWidth="2" />
      <circle cx="520" cy="510" r="9" fill={ink.blue} />
      <circle cx="1400" cy="510" r="9" fill={ink.green} />
      <text x="520" y="465" textAnchor="middle" fill={ink.blue} fontSize="18" fontFamily="Menlo, monospace">shard DO A · SQLite</text>
      <text x="1400" y="465" textAnchor="middle" fill={ink.green} fontSize="18" fontFamily="Menlo, monospace">shard DO B · SQLite</text>
      <line x1="520" y1="510" x2="520" y2="690" stroke={ink.blue} strokeWidth="3" strokeDasharray="560" strokeDashoffset={560 * (1 - progress(frame, 260, 510))} opacity={phase >= 1 ? 1 : 0.35} />
      <line x1="1400" y1="510" x2="1400" y2="690" stroke={ink.green} strokeWidth="3" strokeDasharray="560" strokeDashoffset={560 * (1 - progress(frame, 360, 610))} opacity={phase >= 1 ? 1 : 0.35} />
      <circle cx="520" cy="690" r="12" fill={phase >= 2 ? ink.blue : ink.background} stroke={ink.blue} strokeWidth="3" />
      <circle cx="1400" cy="690" r="12" fill={phase >= 2 ? ink.green : ink.background} stroke={ink.green} strokeWidth="3" />
      <line x1="330" y1="805" x2="1590" y2="805" stroke={ink.pale} strokeWidth="2" />
      <line x1={interpolate(committed, [0, 1], [550, 1430])} y1="775" x2={interpolate(committed, [0, 1], [550, 1430])} y2="835" stroke={ink.yellow} strokeWidth="4" />
      <circle cx={interpolate(committed, [0, 1], [550, 1430])} cy="805" r="9" fill={ink.yellow} />
      <text x="330" y="860" fill={ink.dim} fontSize="18" fontFamily="Avenir Next, sans-serif">VISIBLE SEQUENCE {sequence.toFixed(0)}</text>
    </svg>
    <div style={{ position: "absolute", top: 310, left: 0, right: 0, textAlign: "center", color: ink.yellow, fontFamily: "Georgia, serif", fontStyle: "italic", fontSize: 20, opacity: appear(frame, 45) }}>graph coordinator · Durable Object</div>
    <div style={{ position: "absolute", top: 592, left: 0, right: 0, textAlign: "center", fontFamily: "Avenir Next, sans-serif", fontSize: 20, color: ink.pale, opacity: appear(frame, 320) }}>
      {phase < 2 ? "prepared · still invisible" : "both participants applied"}
    </div>
    <Equation style={{ position: "absolute", top: 900, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 980) }}>
      reader pins one snapshot <span style={{ color: ink.dim }}>·</span> all effects, or none
    </Equation>
  </SceneShell>;
};

const SceneSix: React.FC = () => {
  const frame = useCurrentFrame();
  const split = progress(frame, 520, 860);
  const cutover = progress(frame, 1030, 1200);
  const bits = "10110110";
  return <SceneShell title="When a graph database fits" showLogo>
    <Caption style={{ position: "absolute", top: 250, left: 0, right: 0, textAlign: "center", opacity: appear(frame, 20) }}>Best for connected, sourced facts—not general SQL or unbounded analytics</Caption>
    <div style={{ position: "absolute", top: 340, left: 0, right: 0, textAlign: "center", fontFamily: "Menlo, monospace", fontSize: 28, letterSpacing: 10, opacity: appear(frame, 70) }}>
      {bits.split("").map((bit, index) => <span key={index} style={{ color: index < 3 ? ink.blue : ink.pale }}>{bit}</span>)}
    </div>
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <Stroke x1={960} y1={420} x2={960} y2={520} color={ink.blue} at={150} frame={frame} />
      <Stroke x1={960} y1={520} x2={960} y2={610} color={ink.blue} at={200} frame={frame} />
      <Stroke x1={960} y1={610} x2={760} y2={730} color={ink.green} at={550} frame={frame} />
      <Stroke x1={960} y1={610} x2={1160} y2={730} color={ink.coral} at={650} frame={frame} />
      <circle cx="960" cy="520" r="13" fill={ink.background} stroke={ink.blue} strokeWidth="2" />
      <circle cx="960" cy="610" r="13" fill={cutover > 0.8 ? ink.dim : ink.background} stroke={ink.blue} strokeWidth="2" />
      <circle cx="760" cy="730" r="14" fill={`${ink.green}20`} stroke={ink.green} strokeWidth="2" />
      <circle cx="1160" cy="730" r="14" fill={`${ink.coral}20`} stroke={ink.coral} strokeWidth="2" />
      <circle cx={960 - 200 * split} cy={610 + 120 * split} r="6" fill={ink.green} opacity={split} />
      <circle cx={960 + 200 * split} cy={610 + 120 * split} r="6" fill={ink.coral} opacity={split} />
    </svg>
    <div style={{ position: "absolute", top: 495, left: 1010, width: 240, textAlign: "left", opacity: appear(frame, 230) }}>
      <Equation style={{ fontSize: 25 }} color={ink.blue}>prefix 101</Equation>
    </div>
    <div style={{ position: "absolute", top: 755, left: 500, width: 260, textAlign: "center", opacity: split }}>
      <Caption color={ink.green}>child 1010</Caption><div style={{ color: ink.pale, fontFamily: "Avenir Next, sans-serif", fontSize: 18, marginTop: 9 }}>copied · verified</div>
    </div>
    <div style={{ position: "absolute", top: 755, left: 1160, width: 260, textAlign: "center", opacity: split }}>
      <Caption color={ink.coral}>child 1011</Caption><div style={{ color: ink.pale, fontFamily: "Avenir Next, sans-serif", fontSize: 18, marginTop: 9 }}>copied · verified</div>
    </div>
    <div style={{ position: "absolute", top: 870, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 54, opacity: appear(frame, 810) }}>
      <span style={{ color: ink.pale, fontFamily: "Avenir Next, sans-serif", fontSize: 21 }}>fence writes</span>
      <span style={{ color: ink.dim, fontSize: 24 }}>→</span>
      <span style={{ color: ink.pale, fontFamily: "Avenir Next, sans-serif", fontSize: 21 }}>copy + verify</span>
      <span style={{ color: ink.dim, fontSize: 24 }}>→</span>
      <span style={{ color: ink.yellow, fontFamily: "Avenir Next, sans-serif", fontSize: 21, opacity: cutover }}>directory cutover</span>
    </div>
    <div style={{ position: "absolute", top: 930, left: 0, right: 0, textAlign: "center", color: ink.dim, fontFamily: "Avenir Next, sans-serif", fontSize: 17, opacity: appear(frame, 1110) }}>
      One coordinator still sequences writes · transactions and queries have fan-out limits · hot entities stay whole
    </div>
  </SceneShell>;
};

const scenes = [SceneOne, SceneTwo, SceneThree, SceneFour, SceneFive, SceneSix];

const Voiceover: React.FC<{ includeVoiceover: boolean }> = ({ includeVoiceover }) => {
  if (!includeVoiceover) return null;
  return <Audio src={staticFile("voiceover.wav")} />;
};

export const PoneglyphExplainer: React.FC<ExplainerProps> = ({ includeVoiceover }) => (
  <AbsoluteFill style={{ backgroundColor: ink.background }}>
    {scenes.map((Scene, index) => <Sequence key={chapters[index].id} from={index * SCENE_FRAMES} durationInFrames={SCENE_FRAMES}>
      <Scene />
    </Sequence>)}
    <Voiceover includeVoiceover={includeVoiceover} />
  </AbsoluteFill>
);
