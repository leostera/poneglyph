import { Outlet, createFileRoute } from "@tanstack/react-router";

function ConnectorRouteShell() {
  return <Outlet />;
}

export const Route = createFileRoute("/connectors/$connectorId")({
  component: ConnectorRouteShell,
});
