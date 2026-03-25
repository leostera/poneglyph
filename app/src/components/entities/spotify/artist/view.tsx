import type { EntityViewModel } from "@/components/entities/types";
import { EntityView } from "@/components/entities/view";

type SpotifyArtistViewProps = {
  entity: EntityViewModel;
};

export function SpotifyArtistView({ entity }: SpotifyArtistViewProps) {
  return <EntityView entity={entity} />;
}
