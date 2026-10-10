import type { Uri } from "../domain/identifiers.js";
import type { DatalogValue } from "./value.js";

export type FactLookup = Readonly<{
  field: Uri;
  entity?: DatalogValue;
  value?: DatalogValue;
}>;

export type FactTuple = Readonly<{
  entity: DatalogValue;
  value: DatalogValue;
}>;

export interface FactSource {
  scan(lookup: FactLookup, signal?: AbortSignal): AsyncIterable<FactTuple>;
}
