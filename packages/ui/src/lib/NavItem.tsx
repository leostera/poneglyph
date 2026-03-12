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
    <button className={cn("pg-nav-item", className)} data-active={active} type={type} {...props}>
      <span>{children}</span>
      {meta ? <span className="pg-nav-item__meta">{meta}</span> : null}
    </button>
  );
}
