import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

const googleOnboardingSteps = [
  {
    href: "/connectors/google/onboard/connect" as const,
    label: "Connect",
  },
  {
    href: "/connectors/google/onboard/select" as const,
    label: "Choose calendars",
  },
];

function GoogleConnectorOnboardingLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <div className="min-h-full px-8 py-7">
      <div className="mx-auto max-w-5xl">
        <header className="space-y-4 pb-6">
          <Button asChild className="-ml-2" size="sm" variant="ghost">
            <Link to="/connectors/add">
              <ArrowLeft />
              Back to add connector
            </Link>
          </Button>

          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
              Google Calendar onboarding
            </div>
            <h1 className="text-[28px] font-semibold tracking-tight">Connect Google Calendar</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Walk through the Google-specific setup flow: connect the account, then choose which
              calendars should stay in sync with the local daemon.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {googleOnboardingSteps.map((step, index) => (
              <Badge key={step.href} variant={pathname === step.href ? "secondary" : "outline"}>
                {index + 1}. {step.label}
              </Badge>
            ))}
          </div>
        </header>

        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/connectors/google/onboard")({
  component: GoogleConnectorOnboardingLayout,
});
