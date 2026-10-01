import { attachSpeechSegmentProvenance } from "../src/railway/semantic";
// Explicit opt-in commands only. Normal tests and eval:station never import this file.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import {
  CloudflareWhisperTranscriptionService,
  whisperModel,
  whisperSettings,
} from "../src/transcription/workers-ai";
import { whisperProcessingTimeoutMs } from "../src/jobs/processing-timeout";
import { GeminiMetadataService } from "../src/metadata/gemini";
import { NaturalLanguageNormalizationStage } from "../src/pipeline/ai-stages";
import { evaluateFixture, loadFixture } from "./eval-station";
const [operation, input] = process.argv.slice(2);
if (
  !input ||
  !["whisper", "analysis", "normalize", "full"].includes(operation ?? "")
)
  throw new Error(
    "Usage: eval-external-ai.ts whisper|analysis|normalize|full <audio-file|fixture> [--out folder]",
  );
const sourceFolder = resolve(input);
const outIndex = process.argv.indexOf("--out");
const folder = resolve(
  outIndex >= 0
    ? process.argv[outIndex + 1]!
    : operation === "whisper" || operation === "full"
      ? `fixtures/captured/${basename(input).replace(/\.[^.]+$/, "")}`
      : input,
);
await mkdir(folder, { recursive: true });
async function save(name: string, data: unknown) {
  // Preserve captured input as immutable; use a new --out folder to rerun a provider.
  await writeFile(
    join(folder, `${name}.json`),
    JSON.stringify(
      data,
      (_, v) => (v instanceof Map ? Object.fromEntries(v) : v),
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
// Check output collisions and credentials before making a paid request.
const outputFile =
  operation === "whisper" || operation === "full"
    ? "transcription"
    : operation === "analysis"
      ? "analysis"
      : "normalized";
try {
  await access(join(folder, `${outputFile}.json`));
  throw new Error(
    `${outputFile}.json already exists; choose a new --out directory`,
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (operation !== "whisper") required("GEMINI_API_KEY");
if (
  (operation === "analysis" || operation === "normalize") &&
  sourceFolder !== folder
) {
  await save(
    "transcription",
    JSON.parse(
      await readFile(join(sourceFolder, "transcription.json"), "utf8"),
    ),
  );
  if (operation === "normalize")
    await save(
      "analysis",
      JSON.parse(await readFile(join(sourceFolder, "analysis.json"), "utf8")),
    );
}
if (operation === "whisper" || operation === "full") {
  const account = required("CLOUDFLARE_ACCOUNT_ID"),
    token = required("CLOUDFLARE_API_TOKEN");
  const duration = Number(process.env.AUDIO_DURATION_SECS) || null;
  const audio = await readFile(input);
  let providerAttempt = 0;
  const provider = new CloudflareWhisperTranscriptionService({
    async run(model, request, options) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal: options?.signal ?? null,
        },
      );
      const result = (await response.json()) as {
        success?: boolean;
        result?: unknown;
        errors?: unknown[];
      };
      if (!response.ok || result.success === false)
        throw new Error(
          `Workers AI ${response.status}: ${JSON.stringify(result.errors)}`,
        );
      await save(`whisper-response-${++providerAttempt}`, result);
      return result.result;
    },
  });
  const transcription = await provider.transcribe({
    audio: audio.buffer.slice(
      audio.byteOffset,
      audio.byteOffset + audio.byteLength,
    ),
    filename: basename(input),
    contentType: null,
    durationSecs: duration,
    signal: AbortSignal.timeout(whisperProcessingTimeoutMs(duration)),
  });
  await save("transcription", {
    ...transcription,
    provenance: {
      kind: "captured-audio",
      sourceFile: basename(input),
      model: whisperModel,
      settings: whisperSettings,
      capturedAt: new Date().toISOString(),
    },
  });
}
if (operation !== "whisper") {
  const gemini = new GeminiMetadataService(
    required("GEMINI_API_KEY"),
    process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
  );
  if (operation === "analysis" || operation === "full") {
    const transcription = JSON.parse(
      await readFile(join(folder, "transcription.json"), "utf8"),
    );
    const analysis = await gemini.analyze(transcription.text);
    if (analysis.semantic)
      analysis.semantic = attachSpeechSegmentProvenance(
        analysis.semantic,
        transcription.segments ?? [],
      );
    await save("analysis", analysis);
  }
  if (operation === "normalize" || operation === "full") {
    const { transcription, analysis } = await loadFixture(folder);
    const { correction, normalizationPrompt } = await evaluateFixture(folder);
    await writeFile(
      join(folder, "correction.json"),
      JSON.stringify(
        { correction, normalizationPrompt },
        (_, value) =>
          value instanceof Map ? Object.fromEntries(value) : value,
        2,
      ) + "\n",
    );
    await save(
      "normalized",
      await new NaturalLanguageNormalizationStage(gemini).run(
        transcription.text,
        analysis,
        correction,
        AbortSignal.timeout(90_000),
      ),
    );
  }
}
console.log(`Captured ${operation} fixture: ${folder}`);
