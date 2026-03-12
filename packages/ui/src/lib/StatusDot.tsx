import type { HTMLAttributes } from "react";

import { cn } from "./utils";

type StatusDotProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "healthy" | "warn" | "offline";
};

export function StatusDot({ className, tone = "offline", ...props }: StatusDotProps) {
  return <span className={cn("pg-status-dot", className)} data-tone={tone} {...props} />;
}
