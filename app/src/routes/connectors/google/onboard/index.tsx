import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/connectors/google/onboard/")({
  beforeLoad: () => {
    throw redirect({ to: "/connectors/google/onboard/connect" });
  },
});
