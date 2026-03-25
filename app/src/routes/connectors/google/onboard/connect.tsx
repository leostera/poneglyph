import { openExternalLink } from "@/actions/shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  findConnectorStatus,
  useConnectorStatusesQuery,
  useGoogleCalendarConnectionsQuery,
} from "@/features/connectors/queries";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type OnboardDestination = "gcal" | "gmail";

function GoogleConnectorOnboardingConnectPage() {
  const search = Route.useSearch();
  const destination = search.destination ?? "gcal";
  const navigate = useNavigate();
  const statusesQuery = useConnectorStatusesQuery({ refetchInterval: 1_000 });
  const googleConnectionsQuery = useGoogleCalendarConnectionsQuery(true);
  const statusConnector = destination === "gmail" ? "gmail" : "gcal";
  const googleStatus = findConnectorStatus(statusesQuery.data, statusConnector);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [knownLatestConnectionId, setKnownLatestConnectionId] = useState<number | null>(null);

  const latestConnection = useMemo(() => {
    const connections = googleConnectionsQuery.data ?? [];
    return connections[0] ?? null;
  }, [googleConnectionsQuery.data]);
  const isGmailDestination = destination === "gmail";

  useEffect(() => {
    if (!isAuthorizing) {
      return;
    }
    if (latestConnection == null) {
      return;
    }

    if (knownLatestConnectionId != null && latestConnection.id <= knownLatestConnectionId) {
      return;
    }

    if (destination === "gmail") {
      navigate({
        replace: true,
        params: { connectorId: "gmail" },
        to: "/connectors/$connectorId",
      });
      return;
    }

    navigate({
      replace: true,
      to: "/connectors/google/onboard/select",
      search: { connectionId: latestConnection.id },
    });
  }, [destination, isAuthorizing, knownLatestConnectionId, latestConnection, navigate]);

  useEffect(() => {
    if (!isAuthorizing) {
      return;
    }
    const interval = setInterval(() => {
      void googleConnectionsQuery.refetch();
      void statusesQuery.refetch();
    }, 1_000);
    return () => clearInterval(interval);
  }, [googleConnectionsQuery, isAuthorizing, statusesQuery]);

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-[3px] border bg-background">
        <div className="flex items-start justify-between gap-6 px-5 py-5">
          <div className="space-y-2">
            <h2 className="text-base font-medium">Step 1. Authorize Google</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Open the browser auth flow, grant read access, and return to the app. As soon as the
              local daemon stores the connection, this flow will advance automatically.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={googleStatus?.connected ? "secondary" : "outline"}>
                {googleStatus?.connected ? "Connected" : "Waiting"}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                setKnownLatestConnectionId(latestConnection?.id ?? null);
                setIsAuthorizing(true);
                openExternalLink(`${window.poneglyph.apiBaseUrl}/auth/google/login`);
              }}
              size="sm"
            >
              <ExternalLink />
              Connect Google
            </Button>
            <Button asChild disabled={!googleStatus?.connected} size="sm" variant="outline">
              {isGmailDestination ? (
                <Link params={{ connectorId: "gmail" }} to="/connectors/$connectorId">
                  Continue
                </Link>
              ) : (
                <Link
                  search={{ connectionId: latestConnection?.id }}
                  to="/connectors/google/onboard/select"
                >
                  Next
                </Link>
              )}
            </Button>
          </div>
        </div>
      </div>

      {googleStatus?.connected ? (
        <Alert>
          <AlertTitle>Connection is ready</AlertTitle>
          <AlertDescription>
            The daemon already has a Google connection. Continue to finish
            {isGmailDestination ? " Gmail setup." : " calendar selection."}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>Waiting for the browser auth flow</AlertTitle>
          <AlertDescription>
            After the browser window completes the auth handoff, this screen will switch to the next
            onboarding step for the newly added account.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export const Route = createFileRoute("/connectors/google/onboard/connect")({
  validateSearch: (search: Record<string, unknown>) => ({
    destination: search.destination === "gmail" ? ("gmail" as OnboardDestination) : undefined,
  }),
  component: GoogleConnectorOnboardingConnectPage,
});
