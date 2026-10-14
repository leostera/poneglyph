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
  // Emit the bag product of each matching lookup tuple with every output-field
  // tuple of the same entity. The returned value is from the output field.
  scanEntityJoin?(lookup: FactLookup & Readonly<{value: DatalogValue}>, outputField: Uri, signal?: AbortSignal): AsyncIterable<FactTuple>;
}
