import type { ComponentProps } from "react";

import { Badge as PrimitiveBadge } from "../components/ui/badge";
import { cn } from "./utils";

type BadgeProps = ComponentProps<typeof PrimitiveBadge> & {
  tone?: "default" | "accent" | "warn";
};

export function Badge({ className, tone = "default", ...props }: BadgeProps) {
  const toneClass =
    tone === "accent"
      ? "bg-emerald-400 text-black hover:bg-emerald-300"
      : tone === "warn"
        ? "bg-lime-200 text-lime-950 hover:bg-lime-100"
        : "border border-border bg-muted/60 text-foreground";

  return (
    <PrimitiveBadge
      className={cn(
        "rounded-full px-2.5 py-0 text-[11px] tracking-[0.16em] uppercase",
        toneClass,
        className,
      )}
      variant="outline"
      {...props}
    />
  );
}
