import { cn } from "@/utils/tailwind";
import type { ReactNode } from "react";

type TwoColumnLayoutProps = {
  nav: ReactNode;
  content: ReactNode;
  className?: string;
  navClassName?: string;
  contentClassName?: string;
};

export function TwoColumnLayout({
  nav,
  content,
  className,
  navClassName,
  contentClassName,
}: TwoColumnLayoutProps) {
  return (
    <div className={cn("flex h-full w-full min-h-0 flex-1 overflow-hidden", className)}>
      <nav className={cn("flex h-full min-h-0 shrink-0 flex-col overflow-y-auto", navClassName)}>
        {nav}
      </nav>
      <div
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
          contentClassName,
        )}
      >
        {content}
      </div>
    </div>
  );
}
