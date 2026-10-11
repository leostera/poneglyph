// Build-time SUT composition root. Keep the Worker and benchmark callers fixed.
// Version A remains selected until the candidate protocol passes its own gates.
export { GraphCoordinatorDO, GraphShardDO, coordinatorObjectName } from "./storage/implementation.js";
