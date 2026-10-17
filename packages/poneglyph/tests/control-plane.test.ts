import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { treeForKey } from "../src/storage/forest.js";
import { coordinatorObjectName, virtualKeyForEntity } from "../src/storage/keys.js";

type ControlFactValue =
  | Readonly<{type: "reference"; value: string}>
  | Readonly<{type: "boolean"; value: boolean}>
  | Readonly<{type: "text"; value: string}>;

type ControlFact = Readonly<{
  source: string;
  entity: string;
  field: string;
  value: ControlFactValue;
  retraction: boolean;
}>;

type DatalogString = Readonly<{type: "string"; value: string}>;
type QueryResult = Readonly<{
  rows: readonly Readonly<Record<string, DatalogString>>[];
  sequenceScope: string;
  snapshotSeq: number;
  snapshotVector: readonly Readonly<{prefix: string; sequence: number; epoch: number}>[];
}>;

type ControlPlaneFixture = Readonly<{
  graph: string;
  tenant: string;
  featureEntity: string;
  credentialEntity: string;
  featureRoot: string;
  credentialRoot: string;
  roots: readonly [string, string];
}>;

const SOURCE = "agent:control-plane-integration-test";
const FEATURE_TENANT = "control:config:tenant";
const FEATURE_ENABLED = "control:config:enabled";
const CREDENTIAL_TENANT = "control:credential:tenant";
const CREDENTIAL_VERSION = "control:credential:token-version";
const CREDENTIAL_STATUS = "control:credential:status";
const ACTIVE_TOKEN_V0 = "fake-token-test-only-v0";
const ACTIVE_TOKEN_V1 = "fake-token-test-only-v1";
const FEATURE_AND_CREDENTIAL_QUERY = [
  "control:config:tenant(FeatureConfig, Tenant)",
  "control:config:enabled(FeatureConfig, Enabled)",
  "control:credential:tenant(Credential, Tenant)",
  "control:credential:token-version(Credential, TokenVersion)",
  "control:credential:status(Credential, CredentialStatus)",
].join(", ");

const text = (value: string): ControlFactValue => ({type: "text", value});
const boolean = (value: boolean): ControlFactValue => ({type: "boolean", value});
const reference = (value: string): ControlFactValue => ({type: "reference", value});

function settingFact(entity: string, field: string, value: ControlFactValue, retraction = false): ControlFact {
  return {source: SOURCE, entity, field, value, retraction};
}

function replaceSetting(
  entity: string,
  field: string,
  previous: ControlFactValue,
  next: ControlFactValue,
): ControlFact[] {
  return [settingFact(entity, field, previous, true), settingFact(entity, field, next)];
}

async function makeFixture(): Promise<ControlPlaneFixture> {
  const graph = `test-control-${crypto.randomUUID()}`;
  const tenant = `control:tenant:${crypto.randomUUID()}`;
  const featureEntity = `${tenant}:feature-settings`;
  const featureRoot = treeForKey(await virtualKeyForEntity(graph, featureEntity));
  let credentialEntity = "";
  let credentialRoot = featureRoot;

  for (let attempt = 0; attempt < 128 && credentialRoot === featureRoot; attempt++) {
    credentialEntity = `${tenant}:credential-settings:${attempt}`;
    credentialRoot = treeForKey(await virtualKeyForEntity(graph, credentialEntity));
  }

  if (credentialRoot === featureRoot) {
    throw new Error("could not find distinct owner roots for the control-plane fixture");
  }

  return {graph, tenant, featureEntity, credentialEntity, featureRoot, credentialRoot, roots: [featureRoot, credentialRoot]};
}

function initialStateFacts(fixture: ControlPlaneFixture): ControlFact[] {
  return [
    settingFact(fixture.featureEntity, FEATURE_TENANT, reference(fixture.tenant)),
    settingFact(fixture.featureEntity, FEATURE_ENABLED, boolean(false)),
    settingFact(fixture.credentialEntity, CREDENTIAL_TENANT, reference(fixture.tenant)),
    settingFact(fixture.credentialEntity, CREDENTIAL_VERSION, text(ACTIVE_TOKEN_V0)),
    settingFact(fixture.credentialEntity, CREDENTIAL_STATUS, text("active")),
  ];
}

function enableAndRotateFacts(fixture: ControlPlaneFixture): ControlFact[] {
  return [
    ...replaceSetting(fixture.featureEntity, FEATURE_ENABLED, boolean(false), boolean(true)),
    ...replaceSetting(fixture.credentialEntity, CREDENTIAL_VERSION, text(ACTIVE_TOKEN_V0), text(ACTIVE_TOKEN_V1)),
  ];
}

function disableAndRevokeFacts(fixture: ControlPlaneFixture): ControlFact[] {
  return [
    ...replaceSetting(fixture.featureEntity, FEATURE_ENABLED, boolean(true), boolean(false)),
    settingFact(fixture.credentialEntity, CREDENTIAL_VERSION, text(ACTIVE_TOKEN_V1), true),
    ...replaceSetting(fixture.credentialEntity, CREDENTIAL_STATUS, text("active"), text("revoked")),
  ];
}

async function commit(graph: string, token: string, facts: readonly ControlFact[]): Promise<Readonly<{txId: string}>> {
  const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({clientRequestToken: token, facts}),
  }));
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body) as Readonly<{txId: string}>;
}

async function datalog(graph: string, query: string): Promise<QueryResult> {
  const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/query`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({query}),
  }));
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body) as QueryResult;
}

function expectOwnerSequences(result: QueryResult, roots: readonly string[], sequence: number): void {
  expect(result.sequenceScope).toBe("subtree-vector");
  expect(result.snapshotVector).toHaveLength(16);
  for (const root of roots) {
    expect(result.snapshotVector.find(owner => owner.prefix === root)?.sequence).toBe(sequence);
  }
}

const oneSetting = (entityKind: "config" | "credential", field: "enabled" | "status") =>
  entityKind === "config"
    ? `control:config:tenant(Settings, Tenant), control:config:${field}(Settings, State)`
    : `control:credential:tenant(Settings, Tenant), control:credential:${field}(Settings, State)`;

describe("integrated control-plane settings", () => {
  it("enables a feature, rotates a fake token, then disables and revokes after acknowledgement", async () => {
    const fixture = await makeFixture();
    expect(fixture.featureRoot).not.toBe(fixture.credentialRoot);

    await commit(fixture.graph, `control:seed:${crypto.randomUUID()}`, initialStateFacts(fixture));
    const beforeRotation = await datalog(fixture.graph, FEATURE_AND_CREDENTIAL_QUERY);
    expect(beforeRotation.rows).toEqual([{
      FeatureConfig: {type: "string", value: fixture.featureEntity},
      Credential: {type: "string", value: fixture.credentialEntity},
      Tenant: {type: "string", value: fixture.tenant},
      Enabled: {type: "string", value: "false"},
      TokenVersion: {type: "string", value: ACTIVE_TOKEN_V0},
      CredentialStatus: {type: "string", value: "active"},
    }]);
    expectOwnerSequences(beforeRotation, fixture.roots, 1);

    const rotationFacts = enableAndRotateFacts(fixture);
    const rotationToken = `control:rotate:${crypto.randomUUID()}`;
    const rotation = await commit(fixture.graph, rotationToken, rotationFacts);
    const retry = await commit(fixture.graph, rotationToken, rotationFacts);
    expect(retry.txId).toBe(rotation.txId);

    const enabled = await datalog(fixture.graph, FEATURE_AND_CREDENTIAL_QUERY);
    expect(enabled.rows).toEqual([{
      FeatureConfig: {type: "string", value: fixture.featureEntity},
      Credential: {type: "string", value: fixture.credentialEntity},
      Tenant: {type: "string", value: fixture.tenant},
      Enabled: {type: "string", value: "true"},
      TokenVersion: {type: "string", value: ACTIVE_TOKEN_V1},
      CredentialStatus: {type: "string", value: "active"},
    }]);
    expectOwnerSequences(enabled, fixture.roots, 2);

    await commit(fixture.graph, `control:revoke:${crypto.randomUUID()}`, disableAndRevokeFacts(fixture));
    const noActiveCredential = await datalog(fixture.graph, FEATURE_AND_CREDENTIAL_QUERY);
    expect(noActiveCredential.rows).toEqual([]);
    expectOwnerSequences(noActiveCredential, fixture.roots, 3);

    const disabled = await datalog(fixture.graph, oneSetting("config", "enabled"));
    expect(disabled.rows).toEqual([{
      Settings: {type: "string", value: fixture.featureEntity},
      Tenant: {type: "string", value: fixture.tenant},
      State: {type: "string", value: "false"},
    }]);
    const revoked = await datalog(fixture.graph, oneSetting("credential", "status"));
    expect(revoked.rows).toEqual([{
      Settings: {type: "string", value: fixture.credentialEntity},
      Tenant: {type: "string", value: fixture.tenant},
      State: {type: "string", value: "revoked"},
    }]);
  });

  it("keeps a multi-owner feature-and-token update invisible until its acknowledgement boundary", async () => {
    const fixture = await makeFixture();
    expect(fixture.featureRoot).not.toBe(fixture.credentialRoot);
    await commit(fixture.graph, `control:seed:${crypto.randomUUID()}`, initialStateFacts(fixture));

    const facade = env.GRAPH_FACADES.getByName(coordinatorObjectName(fixture.graph));
    const nextFacts = enableAndRotateFacts(fixture);
    const token = `control:atomic-update:${crypto.randomUUID()}`;

    await runInDurableObject(facade, async instance => {
      const originalFetch = Reflect.get(instance, "fetch");
      let signalEntered!: () => void;
      let releaseGate!: () => void;
      let paused = false;
      const entered = new Promise<void>(resolve => {signalEntered = resolve;});
      const gate = new Promise<void>(resolve => {releaseGate = resolve;});
      Reflect.set(instance, "fetch", async function (this: unknown, request: Request) {
        if (new URL(request.url).pathname === "/_publish-vector" && !paused) {
          paused = true;
          signalEntered();
          await gate;
        }
        return (originalFetch as (this: unknown, request: Request) => Promise<Response>).call(this, request);
      });

      const heldResponse = commit(fixture.graph, token, nextFacts);
      try {
        await entered;
        const duringPublication = await datalog(fixture.graph, FEATURE_AND_CREDENTIAL_QUERY);
        expect(duringPublication.rows).toEqual([{
          FeatureConfig: {type: "string", value: fixture.featureEntity},
          Credential: {type: "string", value: fixture.credentialEntity},
          Tenant: {type: "string", value: fixture.tenant},
          Enabled: {type: "string", value: "false"},
          TokenVersion: {type: "string", value: ACTIVE_TOKEN_V0},
          CredentialStatus: {type: "string", value: "active"},
        }]);
        expectOwnerSequences(duringPublication, fixture.roots, 1);
      } finally {
        releaseGate();
        Reflect.set(instance, "fetch", originalFetch);
        await heldResponse;
      }
    });

    const afterAcknowledgement = await datalog(fixture.graph, FEATURE_AND_CREDENTIAL_QUERY);
    expect(afterAcknowledgement.rows).toEqual([{
      FeatureConfig: {type: "string", value: fixture.featureEntity},
      Credential: {type: "string", value: fixture.credentialEntity},
      Tenant: {type: "string", value: fixture.tenant},
      Enabled: {type: "string", value: "true"},
      TokenVersion: {type: "string", value: ACTIVE_TOKEN_V1},
      CredentialStatus: {type: "string", value: "active"},
    }]);
    expectOwnerSequences(afterAcknowledgement, fixture.roots, 2);
  });
});
