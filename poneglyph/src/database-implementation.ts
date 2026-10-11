// Build-time SUT composition root. Keep the Worker and benchmark callers fixed.
// Version A stays the default. Select ./storage-candidate/implementation.js only
// for explicitly identified candidate trials using fresh persistence.
export { GraphCoordinatorDO, GraphShardDO, coordinatorObjectName, dispatchGraphRequest, BenchCoordinatorDO, BenchShardDO, shardObjectName, parseVirtualPrefix } from "./storage/implementation.js";
