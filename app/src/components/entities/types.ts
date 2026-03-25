export type EntityField = {
  field: string;
  value: string;
};

export type EntityViewModel = {
  uri: string;
  namespace: string;
  kind: string;
  fields: EntityField[];
};
