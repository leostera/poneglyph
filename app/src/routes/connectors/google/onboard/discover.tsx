import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/connectors/google/onboard/discover")({
  beforeLoad: () => {
    throw redirect({ to: "/connectors/google/onboard/select" });
  },
});
