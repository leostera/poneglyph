import { EntitiesExplorerPage } from "@/components/entities/explorer-page";
import { createFileRoute } from "@tanstack/react-router";

function EntitiesScopeRoutePage() {
  const { scope } = Route.useParams();
  return <EntitiesExplorerPage key={scope} scope={scope} />;
}

export const Route = createFileRoute("/entities/$scope")({
  component: EntitiesScopeRoutePage,
});
