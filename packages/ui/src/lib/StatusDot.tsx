import type { HTMLAttributes } from "react";

import { cn } from "./utils";

type StatusDotProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "healthy" | "warn" | "offline";
};

export function StatusDot({ className, tone = "offline", ...props }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-flex size-2.5 rounded-full",
        tone === "healthy"
          ? "bg-emerald-400 shadow-[0_0_0_4px_rgba(74,222,128,0.14)]"
          : tone === "warn"
            ? "bg-lime-300 shadow-[0_0_0_4px_rgba(190,242,100,0.14)]"
            : "bg-zinc-500 shadow-[0_0_0_4px_rgba(255,255,255,0.05)]",
        className,
      )}
      data-tone={tone}
      {...props}
    />
  );
}
