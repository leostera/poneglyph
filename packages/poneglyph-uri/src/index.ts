export type PoneglyphScope = "namespace" | "kind" | "entity";

export type PoneglyphUriParts = {
  raw: string;
  namespace: string;
  kind: string | null;
  id: string | null;
  scope: PoneglyphScope;
};

export function parsePoneglyphUri(input: string): PoneglyphUriParts | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }

  const segments = raw.split(":");
  if (segments.length < 2) {
    return null;
  }

  const namespace = segments[0]?.trim() ?? "";
  if (namespace.length === 0) {
    return null;
  }

  if (segments.length === 2 && segments[1] === "") {
    return {
      raw,
      namespace,
      kind: null,
      id: null,
      scope: "namespace",
    };
  }

  const kind = segments[1]?.trim() ?? "";
  if (kind.length === 0) {
    return null;
  }

  if (segments.length === 2) {
    return {
      raw,
      namespace,
      kind,
      id: null,
      scope: "kind",
    };
  }

  const id = segments.slice(2).join(":").trim();
  if (id.length === 0) {
    return null;
  }

  return {
    raw,
    namespace,
    kind,
    id,
    scope: "entity",
  };
}

export function formatNamespaceScope(namespace: string): string {
  return `${namespace.trim()}:`;
}

export function formatKindScope(namespace: string, kind: string): string {
  return `${namespace.trim()}:${kind.trim()}`;
}

export function formatEntityUri(namespace: string, kind: string, id: string): string {
  return `${namespace.trim()}:${kind.trim()}:${id.trim()}`;
}
