import type { GraphPermission } from "./authorization.js";
export type DeploymentGrants = Record<string, Record<string, GraphPermission[]>>;
// Workers permits 5 KB per variable. Keep room for serialization overhead.
export function splitGrantBindings(grants: DeploymentGrants, budget = 4096): Record<string, DeploymentGrants> {
  const result: Record<string, DeploymentGrants> = {};
  let chunk: DeploymentGrants = {}, ordinal = 0;
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const save = () => {
    const name = ordinal === 0 ? "GRAPH_GRANTS" : `GRAPH_GRANTS_${String(ordinal).padStart(2, "0")}`;
    result[name] = chunk;
    ordinal++;
    chunk = {};
  };
  for (const [client, graphs] of Object.entries(grants)) for (const [graph, permissions] of Object.entries(graphs)) {
    const candidate = { ...chunk, [client]: { ...chunk[client], [graph]: permissions } };
    if (size(candidate) > budget) {
      if (size({ [client]: { [graph]: permissions } }) > budget) throw new Error("A grant exceeds the binding byte budget");
      save();
    }
    chunk[client] = { ...chunk[client], [graph]: permissions };
  }
  save();
  if (ordinal > 100) throw new Error("Grant policy exceeds the reserved binding count");
  return result;
}
