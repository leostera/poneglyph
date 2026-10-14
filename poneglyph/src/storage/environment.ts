// Storage needs only fetch-capable namespaces, not generated RPC class types.
import type { FetchNamespace } from "../storage-namespace.js";

export type StorageEnv = Readonly<{
  GRAPH_SHARDS: FetchNamespace;
  GRAPH_COORDINATORS: FetchNamespace;
}>;
