// The candidate depends on its own namespace binding, not Version A's generated
// Durable Object class types. Domain facts and Datalog semantics remain shared.
import type { FetchNamespace } from "../storage-namespace.js";

export type CandidateStorageEnv = Readonly<{
  GRAPH_SHARDS: FetchNamespace;
  GRAPH_COORDINATORS: FetchNamespace;
}>;
