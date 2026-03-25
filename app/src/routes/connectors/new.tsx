import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/connectors/new")({
  beforeLoad: () => {
    throw redirect({ to: "/connectors/add" });
  },
});
