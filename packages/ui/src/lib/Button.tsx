import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "./utils";

const buttonVariants = cva("pg-button", {
  variants: {
    tone: {
      default: "pg-button--default",
      secondary: "pg-button--secondary",
      accent: "pg-button--accent",
      ghost: "pg-button--ghost",
    },
    size: {
      sm: "pg-button--sm",
      md: "pg-button--md",
      lg: "pg-button--lg",
    },
  },
  defaultVariants: {
    tone: "default",
    size: "md",
  },
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    label?: string;
  };

export function Button({
  asChild,
  children,
  className,
  label,
  size,
  tone,
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp className={cn(buttonVariants({ tone, size }), className)} type={type} {...props}>
      {children ?? label}
    </Comp>
  );
}
