import type { PropsWithChildren, ReactNode } from "react";

type AppShellProps = PropsWithChildren<{
  eyebrow: string;
  title: string;
  subtitle: string;
  sidebar?: ReactNode;
}>;

export function AppShell({
  eyebrow,
  title,
  subtitle,
  sidebar,
  children,
}: AppShellProps) {
  return (
    <div style={shellStyle}>
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
  fontSize: "clamp(3rem, 7vw, 5.6rem)",
  lineHeight: 0.94,
  fontWeight: 600,
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
