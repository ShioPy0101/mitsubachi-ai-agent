export type CorrectionLabel = {
  mentionId: string;
  sourceText: string;
  expectedText: string;
  requiresCorrection: boolean;
  hasCandidates: boolean;
};
export type CorrectionPrediction = { mentionId: string; text: string };
const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;
export function evaluateCorrections(
  labels: readonly CorrectionLabel[],
  predictions: readonly CorrectionPrediction[],
) {
  const byMention = new Map(predictions.map((p) => [p.mentionId, p.text]));
  let changes = 0,
    correctChanges = 0,
    needed = 0,
    falseChanges = 0,
    originallyCorrect = 0,
    unresolved = 0,
    withCandidates = 0;
  for (const label of labels) {
    const actual = byMention.get(label.mentionId) ?? label.sourceText;
    const changed = actual !== label.sourceText;
    if (label.requiresCorrection) needed++;
    else originallyCorrect++;
    if (label.hasCandidates) withCandidates++;
    if (changed) {
      changes++;
      if (actual === label.expectedText) correctChanges++;
      else if (!label.requiresCorrection) falseChanges++;
    } else if (label.hasCandidates && label.requiresCorrection) unresolved++;
  }
  return {
    precision: ratio(correctChanges, changes),
    recall: ratio(correctChanges, needed),
    falseCorrectionRate: ratio(falseChanges, originallyCorrect),
    unresolvedRate: ratio(unresolved, withCandidates),
    counts: {
      changes,
      correctChanges,
      needed,
      falseChanges,
      originallyCorrect,
      unresolved,
      withCandidates,
    },
    labeledMentions: labels.length,
  };
}
