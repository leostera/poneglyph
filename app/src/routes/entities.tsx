import { EntitiesExplorerPage } from "@/components/entities/explorer-page";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";

function EntitiesRoutePage() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const scope = useMemo(() => {
    if (pathname === "/entities") {
      return undefined;
    }

    if (!pathname.startsWith("/entities/")) {
      return undefined;
    }

    const encodedScope = pathname.slice("/entities/".length);
    if (!encodedScope) {
      return undefined;
    }

    return decodeURIComponent(encodedScope);
  }, [pathname]);

  return <EntitiesExplorerPage key={scope ?? "all"} scope={scope} />;
}

export const Route = createFileRoute("/entities")({
  component: EntitiesRoutePage,
});
