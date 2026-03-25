import { EntityList, type EntityListRow } from "@/components/entities/list";
import { SpotifyArtistList } from "@/components/entities/spotify/artist/list";
import type { ComponentType } from "react";

type EntityListViewProps = {
  rows: EntityListRow[];
  onSelect?: (row: EntityListRow) => void;
  selectedUri?: string | null;
};

const ENTITY_LIST_REGISTRY: Record<string, ComponentType<EntityListViewProps>> = {
  "spotify:artist": SpotifyArtistList,
};

export function resolveEntityListView(namespace: string | null, kind: string | null) {
  if (!namespace || !kind) {
    return EntityList;
  }

  const key = `${namespace}:${kind}`;
  return ENTITY_LIST_REGISTRY[key] ?? EntityList;
}
