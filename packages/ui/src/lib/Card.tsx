import type { ComponentProps } from "react";

import { Card as PrimitiveCard } from "../components/ui/card";
import { cn } from "./utils";

type CardProps = ComponentProps<typeof PrimitiveCard> & {
  density?: "compact" | "comfortable";
  tone?: "default" | "accent";
};

export function Card({
  className,
  density = "comfortable",
  tone = "default",
  ...props
}: CardProps) {
  return (
    <PrimitiveCard
      className={cn(
        "rounded-[28px] border border-border/80 bg-card/80 shadow-none",
        density === "compact" ? "gap-4 py-4" : "gap-5 py-5",
        tone === "accent" ? "bg-card/90 ring-1 ring-white/5" : "",
        className,
      )}
      size={density === "compact" ? "sm" : "default"}
      {...props}
    />
  );
}
