/** Operation counters, not estimates of Worker CPU milliseconds. */
export const createRailwayWorkMetrics = () => ({
  candidateIdsRetrieved: 0,
  candidatePrefilterChecks: 0,
  candidateSimilarityPairs: 0,
  editDistanceCalls: 0,
  editDistanceCells: 0,
  phoneticCacheHits: 0,
  normalizedReadingCacheHits: 0,
  routeLexicalPairs: 0,
  routeSimilarityCacheHits: 0,
  graphStatesExpanded: 0,
  normalizationComputations: 0,
  normalizationCacheHits: 0,
  similarityCacheHits: 0,
});
export type RailwayWorkMetrics = ReturnType<typeof createRailwayWorkMetrics>;
