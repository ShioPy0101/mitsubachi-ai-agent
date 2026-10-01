export type PresentationMode = "public" | "demo";
export type ExecutionContext = {
  presentationMode: PresentationMode;
  databaseMetrics: import("../db/database-metrics").DatabaseAccessMetrics;
};
export const newExecutionContext = (
  presentationMode: PresentationMode,
): ExecutionContext => ({
  presentationMode,
  databaseMetrics: { reads: 0, writes: 0 },
});
