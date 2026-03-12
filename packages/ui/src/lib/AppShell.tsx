import type { PropsWithChildren, ReactNode } from "react";

import { cn } from "./utils";

type AppShellProps = PropsWithChildren<{
  eyebrow: string;
  title: string;
  subtitle: string;
  sidebar?: ReactNode;
  className?: string;
}>;

export function AppShell({
  className,
  eyebrow,
  title,
  subtitle,
  sidebar,
  children,
}: AppShellProps) {
  return (
    <div className={cn("pg-theme", className)} style={shellStyle}>
      <header style={headerStyle}>
        <div>
          <div style={eyebrowStyle}>{eyebrow}</div>
          <h1 style={titleStyle}>{title}</h1>
          <p style={subtitleStyle}>{subtitle}</p>
        </div>
        {sidebar ? <aside>{sidebar}</aside> : null}
      </header>
      <main style={mainStyle}>{children}</main>
    </div>
  );
}

const shellStyle = {
  minHeight: "100vh",
  padding: "40px 32px 56px",
};

const headerStyle = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: "24px",
  marginBottom: "28px",
};

const eyebrowStyle = {
  color: "rgba(248, 241, 223, 0.72)",
  fontSize: "0.84rem",
  letterSpacing: "0.12em",
  textTransform: "uppercase" as const,
  marginBottom: "14px",
};

const titleStyle = {
  margin: 0,
  fontFamily: "var(--pg-font-serif)",
  fontSize: "clamp(2.3rem, 5vw, 4.4rem)",
  lineHeight: 0.94,
  fontWeight: 300,
};

const subtitleStyle = {
  margin: "18px 0 0",
  maxWidth: "760px",
  color: "rgba(248, 241, 223, 0.72)",
  fontSize: "1.06rem",
  lineHeight: 1.6,
};

const mainStyle = {
  display: "grid",
  gap: "20px",
};
