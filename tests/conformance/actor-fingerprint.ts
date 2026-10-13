export type ActorFingerprint = Readonly<{objectId: string; incarnation: string}>;
export function parseActorFingerprint(input: unknown): ActorFingerprint {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("expected native actor fingerprint");
  const objectId: unknown = Reflect.get(input, "objectId"), incarnation: unknown = Reflect.get(input, "incarnation");
  if (typeof objectId !== "string" || !/^[0-9a-f]{64}$/.test(objectId)) throw new Error("invalid native object identity");
  if (typeof incarnation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incarnation)) throw new Error("invalid native actor incarnation");
  return Object.freeze({objectId, incarnation});
}
