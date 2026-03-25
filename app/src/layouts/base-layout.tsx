import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { sidebarConnectorItems } from "@/features/connectors/catalog";
import { useConnectorStatusesQuery } from "@/features/connectors/queries";
import { Link, useRouterState } from "@tanstack/react-router";
import { AppWindow, Cable, MoreHorizontal, Plus, Search } from "lucide-react";
import type React from "react";

export default function BaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const connectorStatusesQuery = useConnectorStatusesQuery();
  const connectedConnectors = sidebarConnectorItems(connectorStatusesQuery.data);
  const visibleConnectors = connectedConnectors.slice(0, 5);
  const hiddenConnectorCount = Math.max(connectedConnectors.length - 5, 0);

  return (
    <SidebarProvider className="h-screen min-h-0 bg-background" defaultOpen>
      <Sidebar className="draglayer border-r bg-sidebar" collapsible="none">
        <SidebarHeader className="flex flex-row no-drag gap-3 px-3 pt-[45px]">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton className="h-10 rounded-xl" size="lg">
                <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-[10px] font-semibold text-background">
                  PG
                </div>
                <div className="min-w-0 flex-2">
                  <div className="truncate text-sm font-semibold tracking-tight">Poneglyph</div>
                </div>
                <Search className="size-3.5" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent className="no-drag px-3 pb-4 pt-3">
          <SidebarGroup className="px-1 py-0">
            <SidebarGroupLabel className="px-3 text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
              Workspace
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    className="h-auto rounded-xl px-3 py-2 text-sm"
                    isActive={pathname === "/connectors"}
                    size="lg"
                  >
                    <Link to="/connectors">
                      <Cable className="size-4" />
                      <span className="font-medium">Connectors</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuAction asChild showOnHover>
                    <Link aria-label="Add connector" to="/connectors/add">
                      <Plus className="size-4" />
                    </Link>
                  </SidebarMenuAction>
                </SidebarMenuItem>
                {connectedConnectors.length > 0 ? (
                  <SidebarMenuSub>
                    {visibleConnectors.map((connector) => {
                      const Icon = connector.icon;

                      return (
                        <SidebarMenuSubItem key={connector.name}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={
                              pathname === connector.href ||
                              pathname.startsWith(`${connector.href}/`)
                            }
                          >
                            <Link
                              params={{ connectorId: connector.name }}
                              to="/connectors/$connectorId"
                            >
                              <Icon className="size-4" />
                              <span>{connector.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                    {hiddenConnectorCount > 0 ? (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <Link to="/connectors">
                            <MoreHorizontal className="size-4" />
                            <span>More connectors</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ) : null}
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="relative min-h-0 overflow-auto rounded-none bg-background shadow-none">
        <div className="draglayer absolute inset-x-0 top-0" />
        <div className="no-drag min-h-full">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
