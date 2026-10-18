// Experimental host-side wire helpers. This exports no storage implementation,
// namespace capability, command admission, authorization or mutable state.
export {isRecord} from "./domain/result.js";
export {factAsJson} from "./storage/protocol.js";
export {coordinatorObjectName} from "./storage/keys.js";
export {ledgerCoordinatorName, LEDGER_BUCKETS} from "./storage/forest.js";
export {readJsonBody, sha256Hex} from "./storage/http.js";
export {readFailureReason} from "./storage/read-diagnostics.js";
