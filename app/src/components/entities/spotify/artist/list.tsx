import { EntityList, type EntityListRow } from "@/components/entities/list";

type SpotifyArtistListProps = {
  rows: EntityListRow[];
  onSelect?: (row: EntityListRow) => void;
  selectedUri?: string | null;
};

export function SpotifyArtistList(props: SpotifyArtistListProps) {
  return <EntityList {...props} />;
}
