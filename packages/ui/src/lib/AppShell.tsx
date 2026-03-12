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
    <div className={cn("dark min-h-screen bg-background text-foreground", className)}>
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-10 px-8 py-10">
        <header className="flex items-end justify-between gap-6">
          <div className="grid gap-3">
            <div className="text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
              {eyebrow}
            </div>
            <h1 className="font-serif text-5xl leading-none font-light tracking-[-0.05em]">
              {title}
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{subtitle}</p>
          </div>
          {sidebar ? <aside>{sidebar}</aside> : null}
        </header>
        <main className="grid gap-5">{children}</main>
      </div>
    </div>
  );
}
