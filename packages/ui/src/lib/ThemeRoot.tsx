import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "./utils";

export function ThemeRoot({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={cn("pg-theme", className)} {...props}>
      {children}
    </div>
  );
}
