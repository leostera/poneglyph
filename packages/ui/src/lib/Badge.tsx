import type { PropsWithChildren } from "react";

export function Badge({ children }: PropsWithChildren) {
  return <span style={badgeStyle}>{children}</span>;
}

const badgeStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "8px 12px",
  borderRadius: "999px",
  border: "1px solid rgba(248, 241, 223, 0.12)",
  background: "rgba(248, 241, 223, 0.06)",
  color: "#f8f1df",
  fontSize: "0.78rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.08em",
  whiteSpace: "nowrap" as const,
};
