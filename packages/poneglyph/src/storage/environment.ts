// Storage needs only fetch-capable namespaces, not generated RPC class types.
import type { FetchNamespace } from "../storage-namespace.js";

export type StorageEnv = Readonly<{
  GRAPH_FACADES: FetchNamespace;
  GRAPH_LEDGERS: FetchNamespace;
  GRAPH_TREES: FetchNamespace;
  GRAPH_SHARDS: FetchNamespace;
}>;
