import { GraphCoordinatorDO } from "./coordinator.js";
import { GraphShardDO } from "./shard.js";
import { auditFactStorage } from "../testing/storage-audit.js";

export class BenchCoordinatorDO extends GraphCoordinatorDO {
  transactionState(_txId: string, _graphId: string) { return []; }
  audit() {
    return {
      state: this.ctx.storage.sql.exec("SELECT * FROM graph_state").toArray(),
      phases: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM graph_transactions GROUP BY phase").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
    };
  }
}
export class BenchShardDO extends GraphShardDO {
  audit(after: number, _graphId?: string, _prefix?: string) { return auditFactStorage(this.ctx.storage, after); }
}
