import { EntitiesExplorerPage } from "@/components/entities/explorer-page";
import { createFileRoute } from "@tanstack/react-router";

function EntitiesRoutePage() {
  return <EntitiesExplorerPage key="all" />;
}

export const Route = createFileRoute("/entities")({
  component: EntitiesRoutePage,
});
