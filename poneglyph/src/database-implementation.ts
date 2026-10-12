// Build-time SUT composition root. Keep the Worker and benchmark callers fixed.
// Version A stays the default. Candidate directories are selected only for
// explicitly identified tests/trials using fresh persistence.
export { GraphCoordinatorDO, GraphShardDO, coordinatorObjectName, dispatchGraphRequest, BenchCoordinatorDO, BenchShardDO, shardObjectName, parseVirtualPrefix } from "./storage-e/implementation.js";
