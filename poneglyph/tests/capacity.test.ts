import { describe, expect, it } from "vitest";
import { accountStorage, estimateMutationFootprint } from "../src/storage/capacity.js";
import { simulateCapacityEnvelope } from "../src/storage/capacity-simulation.js";
import { virtualKeyRange } from "../src/storage/migration.js";
import { parseVirtualPrefix } from "../src/storage/keys.js";
import { parseFactDraft } from "../src/domain/fact.js";

const noGrowth = { factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0, transactionStagingBytes: 0 } as const;

describe("per-object capacity accounting", () => {
  it("accounts fact log, secondary indexes, projections, WAL/checkpoint reserve, migration, and headroom", () => {
    const accounting = accountStorage(5_000_000_000, {
      factLogBytes: 100,
      activeIndexBytes: 400,
      projectionBytes: 200,
      transactionStagingBytes: 300,
    }, 250_000_000);

    expect(accounting).toMatchObject({
      databaseBytes: 5_000_000_000,
      walAndCheckpointReserveBytes: 500_000_100,
      migrationReserveBytes: 250_000_000,
      uncertaintyHeadroomBytes: 2_000_000_000,
      projectedAccountedBytes: 7_750_001_100,
      shouldSplit: true,
      canAdmit: true,
    });

    const rejected = accountStorage(5_500_000_000, noGrowth);
    expect(rejected.canAdmit).toBe(false);
    expect(rejected.projectedAccountedBytes).toBeGreaterThan(8_000_000_000);
  });

  it("estimates append rows, active index amplification, and projected entity versions separately", () => {
    const fact = parseFactDraft({
      source: "agent:test",
      entity: "wiki:person:capacity",
      field: "schema:name",
      value: { type: "text", value: "capacity test" },
      retraction: false,
    });
    if (!fact.ok) throw new Error(fact.error.message);
    const footprint = estimateMutationFootprint([fact.value]);
    expect(footprint.factLogBytes).toBeGreaterThan(0);
    expect(footprint.activeIndexBytes).toBeGreaterThan(footprint.factLogBytes);
    expect(footprint.projectionBytes).toBeGreaterThan(0);
    expect(footprint.transactionStagingBytes).toBeGreaterThan(0);
    const existingProjectionFootprint = estimateMutationFootprint([fact.value], new Map([[fact.value.entity, 10_000]]));
    expect(existingProjectionFootprint.projectionBytes - footprint.projectionBytes).toBe(20_000);
  });

  it("maps binary virtual prefixes to disjoint 256-bit lexical ranges", () => {
    const zero = parseVirtualPrefix("0");
    const one = parseVirtualPrefix("1");
    if (!zero.ok || !one.ok) throw new Error("test prefix did not parse");
    const zeroRange = virtualKeyRange(zero.value);
    const oneRange = virtualKeyRange(one.value);
    expect(zeroRange[0]).toBe("0".repeat(64));
    expect(zeroRange[1]).toBe("7" + "f".repeat(63));
    expect(oneRange[0]).toBe("8" + "0".repeat(63));
    expect(oneRange[1]).toBe("f".repeat(64));
  });

  it("accounts a 1 TB logical envelope without physically writing synthetic rows", async () => {
    const result = await simulateCapacityEnvelope();
    expect(result.logicalBytes).toBe(1_000_000_000_000);
    expect(result.syntheticEntities).toBe(10_000);
    expect(result.physicalRowsWritten).toBe(0);
    expect(result.leaves).toBeGreaterThan(100);
    expect(result.routers).toBe(result.leaves - 1);
    expect(result.largestLeafBytes).toBeLessThan(5_000_000_000);
    expect(result.maxAccountedBytes).toBeLessThanOrEqual(8_000_000_000);
  });
});
