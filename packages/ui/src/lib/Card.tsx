import type { CSSProperties, PropsWithChildren } from "react";

type CardProps = PropsWithChildren<{
  tone?: "default" | "accent";
}>;

export function Card({ tone = "default", children }: CardProps) {
  const style = tone === "accent" ? accentStyle : cardStyle;
  return <section style={style}>{children}</section>;
}

const sharedStyle: CSSProperties = {
  borderRadius: "28px",
  padding: "24px",
  border: "1px solid rgba(248, 241, 223, 0.08)",
  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.22)",
  backdropFilter: "blur(12px)",
};

const cardStyle: CSSProperties = {
  ...sharedStyle,
  background: "rgba(18, 15, 11, 0.78)",
};

const accentStyle: CSSProperties = {
  ...sharedStyle,
  background:
    "linear-gradient(180deg, rgba(130, 80, 30, 0.34), rgba(18, 15, 11, 0.88))",
};
