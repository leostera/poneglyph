import { type VariantProps, cva } from "class-variance-authority";
import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "./utils";

const cardVariants = cva("pg-card", {
  variants: {
    tone: {
      default: "pg-card--default",
      accent: "pg-card--accent",
    },
    density: {
      compact: "pg-card--compact",
      comfortable: "pg-card--comfortable",
    },
  },
  defaultVariants: {
    tone: "default",
    density: "comfortable",
  },
});

type CardProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> &
    VariantProps<typeof cardVariants> & {
      as?: "section" | "div" | "article";
    }
>;

export function Card({ as = "section", children, className, density, tone, ...props }: CardProps) {
  const Comp = as;
  return (
    <Comp className={cn(cardVariants({ tone, density }), className)} {...props}>
      {children}
    </Comp>
  );
}
