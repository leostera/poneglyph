import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "./utils";

export function ThemeRoot({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div
      className={cn(
        "dark min-h-full bg-background font-sans text-foreground antialiased",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
