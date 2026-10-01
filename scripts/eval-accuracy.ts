import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateCorrections,
  type CorrectionLabel,
  type CorrectionPrediction,
} from "../src/stations/evaluation";
const root = process.argv[2] ?? "fixtures/railway";
const labels: CorrectionLabel[] = [],
  predictions: CorrectionPrediction[] = [];
for (const entry of await readdir(root, { withFileTypes: true }))
  if (entry.isDirectory()) {
    const folder = join(root, entry.name);
    try {
      const value = JSON.parse(
        await readFile(join(folder, "labels.json"), "utf8"),
      );
      const normalized = JSON.parse(
        await readFile(join(folder, "normalized.json"), "utf8"),
      );
      labels.push(
        ...value.mentions.map((label: CorrectionLabel) => ({
          ...label,
          mentionId: `${entry.name}:${label.mentionId}`,
        })),
      );
      predictions.push(
        ...normalized.entities
          .filter((e: { sourceMentionId?: string }) => e.sourceMentionId)
          .map((e: { sourceMentionId: string; text: string }) => ({
            mentionId: `${entry.name}:${e.sourceMentionId}`,
            text: e.text,
          })),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
console.log(
  JSON.stringify(
    {
      corpus: root,
      ...evaluateCorrections(labels, predictions),
      evaluationStatus: labels.length
        ? "labeled fixture evaluation"
        : "unmeasured: add human labels.json and captured normalized.json; target 100–300 real-audio cases",
    },
    null,
    2,
  ),
);
