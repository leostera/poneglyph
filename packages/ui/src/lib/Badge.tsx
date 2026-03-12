import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "./utils";

type BadgeProps = PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> & {
    tone?: "default" | "accent" | "warn";
  }
>;

export function Badge({ children, className, tone = "default", ...props }: BadgeProps) {
  return (
    <span className={cn("pg-badge", className)} data-tone={tone} {...props}>
      {children}
    </span>
  );
}
