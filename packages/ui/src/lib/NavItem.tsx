import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from "react";

import { cn } from "./utils";

type NavItemProps = PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    active?: boolean;
    meta?: ReactNode;
  }
>;

export function NavItem({
  active,
  children,
  className,
  meta,
  type = "button",
  ...props
}: NavItemProps) {
  return (
    <button
      className={cn(
        "grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-3 text-left text-[13px] text-muted-foreground transition-colors",
        active ? "bg-white/8 text-foreground" : "hover:bg-white/4 hover:text-foreground",
        className,
      )}
      data-active={active}
      type={type}
      {...props}
    >
      <span className="flex min-w-0 items-center justify-start text-left">{children}</span>
      {meta ? (
        <span className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          {meta}
        </span>
      ) : null}
    </button>
  );
}
