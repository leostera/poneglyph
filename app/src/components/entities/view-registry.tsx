import { SpotifyArtistView } from "@/components/entities/spotify/artist/view";
import type { EntityViewModel } from "@/components/entities/types";
import { EntityView } from "@/components/entities/view";
import type { ComponentType } from "react";

type EntityViewProps = {
  entity: EntityViewModel;
};

const ENTITY_VIEW_REGISTRY: Record<string, ComponentType<EntityViewProps>> = {
  "spotify:artist": SpotifyArtistView,
};

export function resolveEntityView(namespace: string, kind: string) {
  const key = `${namespace}:${kind}`;
  return ENTITY_VIEW_REGISTRY[key] ?? EntityView;
}
