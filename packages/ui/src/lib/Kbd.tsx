import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "./utils";

export function Kbd({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <kbd className={cn("pg-kbd", className)} {...props}>
      {children}
    </kbd>
  );
}
