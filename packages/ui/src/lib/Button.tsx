import type { ComponentProps, ReactNode } from "react";

import { Button as PrimitiveButton } from "../components/ui/button";
import { cn } from "./utils";

type ButtonProps = Omit<ComponentProps<typeof PrimitiveButton>, "size" | "variant"> & {
  label?: ReactNode;
  tone?: "default" | "secondary" | "accent" | "ghost";
  size?: "sm" | "md" | "lg";
};

export function Button({
  children,
  className,
  label,
  size = "md",
  tone = "default",
  ...props
}: ButtonProps) {
  const variant =
    tone === "accent"
      ? "default"
      : tone === "secondary"
        ? "outline"
        : tone === "ghost"
          ? "ghost"
          : "secondary";

  const nextSize = size === "sm" ? "sm" : size === "lg" ? "lg" : "default";

  return (
    <PrimitiveButton
      className={cn(
        "text-xs font-medium",
        tone === "accent" ? "bg-emerald-400 text-black hover:bg-emerald-300" : "",
        className,
      )}
      size={nextSize}
      variant={variant}
      {...props}
    >
      {children ?? label}
    </PrimitiveButton>
  );
}
