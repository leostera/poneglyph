import { Outlet, createFileRoute } from "@tanstack/react-router";

function ConnectorsRouteShell() {
  return <Outlet />;
}

export const Route = createFileRoute("/connectors")({
  component: ConnectorsRouteShell,
});
