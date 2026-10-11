// Build-time SUT composition root. Keep the Worker and benchmark callers fixed.
// Candidate B1 selected for local trials; use ./storage/implementation.js for A.
export { GraphCoordinatorDO, GraphShardDO, coordinatorObjectName, dispatchGraphRequest, BenchCoordinatorDO, BenchShardDO, shardObjectName, parseVirtualPrefix } from "./storage-candidate/implementation.js";
