import { parseGraphId, type GraphId } from "@leostera/poneglyph";

export type ClientIdentity = Readonly<{ clientId: string }>;
export type GraphRequest = Readonly<{ graphId: GraphId }>;
export type GraphPermission = "read" | "write";
export type GraphGrants = Readonly<Record<string, Readonly<Record<string, readonly GraphPermission[]>>>>;
export interface GraphAuthorizer {
  permissionsFor(input: ClientIdentity & Readonly<{ graphId: GraphId }>): Promise<readonly GraphPermission[]>;
}
export class GraphAuthorizationError extends Error {
  constructor() { super("Graph access denied"); this.name = "GraphAuthorizationError"; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clientId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new GraphAuthorizationError();
  return value;
}
export function parseIdentity(props: unknown): ClientIdentity {
  if (!record(props) || Object.keys(props).length !== 1 || !Object.hasOwn(props, "clientId")) throw new GraphAuthorizationError();
  return Object.freeze({ clientId: clientId(props.clientId) });
}
export function parseGraphRequest(input: unknown): GraphRequest {
  if (!record(input) || !Object.hasOwn(input, "graphId") || Object.keys(input).some(key => key !== "graphId")) throw new GraphAuthorizationError();
  const graph = parseGraphId(input.graphId);
  if (!graph.ok) throw new GraphAuthorizationError();
  return Object.freeze({ graphId: graph.value });
}

// Parse and snapshot the whole deployment policy. No application/graph names in
// this mechanism, prototype lookups, wildcard grants or mutable caller arrays.
export function staticAuthorizer(input: unknown): GraphAuthorizer {
  if (!record(input)) throw new GraphAuthorizationError();
  const grants = new Map<string, Map<GraphId, readonly GraphPermission[]>>();
  for (const [rawClient, rawGraphs] of Object.entries(input)) {
    const client = clientId(rawClient);
    if (!record(rawGraphs)) throw new GraphAuthorizationError();
    const graphs = new Map<GraphId, readonly GraphPermission[]>();
    for (const [rawGraph, rawPermissions] of Object.entries(rawGraphs)) {
      const graph = parseGraphId(rawGraph);
      if (!graph.ok || !Array.isArray(rawPermissions)) throw new GraphAuthorizationError();
      const permissions: GraphPermission[] = [];
      for (const permission of rawPermissions) {
        if ((permission !== "read" && permission !== "write") || permissions.includes(permission)) throw new GraphAuthorizationError();
        permissions.push(permission);
      }
      if (permissions.includes("write") && !permissions.includes("read")) throw new GraphAuthorizationError();
      graphs.set(graph.value, Object.freeze(permissions));
    }
    grants.set(client, graphs);
  }
  return Object.freeze({
    async permissionsFor({ clientId, graphId }: ClientIdentity & Readonly<{ graphId: GraphId }>) { return grants.get(clientId)?.get(graphId) ?? Object.freeze([]); },
  });
}
export async function authorizeGraph(authorizer: GraphAuthorizer, identity: ClientIdentity, request: GraphRequest): Promise<readonly GraphPermission[]> {
  const permissions = await authorizer.permissionsFor({ ...identity, graphId: request.graphId });
  if (!permissions.includes("read") || permissions.some(permission => permission !== "read" && permission !== "write")) throw new GraphAuthorizationError();
  return Object.freeze([...permissions]);
}
