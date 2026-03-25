import {
  type EntitySummary,
  type KnowledgeGraphSchema,
  getEntities,
  getKnowledgeGraphSchema,
} from "@/lib/poneglyph-api";
import { useQuery } from "@tanstack/react-query";

export const entitiesQueryKey = (limit: number, offset: number) =>
  ["entities", limit, offset] as const;
export const knowledgeGraphSchemaQueryKey = ["knowledge-graph-schema"] as const;

export function useEntitiesQuery(limit = 250, offset = 0) {
  return useQuery<EntitySummary[], Error>({
    queryKey: entitiesQueryKey(limit, offset),
    queryFn: () => getEntities(limit, offset),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useKnowledgeGraphSchemaQuery() {
  return useQuery<KnowledgeGraphSchema, Error>({
    queryKey: knowledgeGraphSchemaQueryKey,
    queryFn: getKnowledgeGraphSchema,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
