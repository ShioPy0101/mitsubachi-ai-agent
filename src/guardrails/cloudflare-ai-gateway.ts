const guardrailModel = "@cf/meta/llama-3.2-1b-instruct" as const;
const hazardCodePattern = /\b(?:P1|S(?:1[0-3]|[1-9]))\b/g;

export interface GuardrailsAiRunner {
  run(
    model: typeof guardrailModel,
    input: AiTextGenerationInput,
    options: AiOptions,
  ): Promise<unknown>;
}

export class GuardrailBlockedError extends Error {
  constructor(readonly blockedCategory: string) {
    super("Audio transcription was blocked by content policy");
    this.name = "GuardrailBlockedError";
  }
}

export class GuardrailUnavailableError extends Error {
  constructor() {
    super("Content policy evaluation was unavailable");
    this.name = "GuardrailUnavailableError";
  }
}

function errorFields(error: unknown): { code: string; text: string } {
  if (typeof error !== "object" || error === null) return { code: "", text: String(error) };
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "number" || typeof record.code === "string" ? String(record.code) : "";
  const textFields = [record.message, record.category, record.categories, record.details]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
  return { code, text: textFields.join(" ") };
}

function blockedCategory(error: unknown): string | null {
  const fields = errorFields(error);
  const isPromptBlock = fields.code === "2016" || fields.text.includes("2016");
  const isResponseBlock = fields.code === "2017" || fields.text.includes("2017");
  if (!isPromptBlock && !isResponseBlock) return null;
  const categories = [...new Set(fields.text.match(hazardCodePattern) ?? [])];
  if (categories.length > 0) return categories.join(",");
  return isPromptBlock ? "guardrails_policy" : "guardrails_response_policy";
}

export class CloudflareAiGatewayGuardrails {
  constructor(
    private readonly ai: GuardrailsAiRunner,
    private readonly gatewayId: string,
  ) {}

  async assertAllowed(transcription: string): Promise<void> {
    if (this.gatewayId.trim() === "") throw new GuardrailUnavailableError();
    try {
      await this.ai.run(
        guardrailModel,
        { prompt: transcription, max_tokens: 1, temperature: 0 },
        {
          gateway: {
            id: this.gatewayId,
            collectLog: false,
            skipCache: true,
          },
        },
      );
    } catch (error) {
      const category = blockedCategory(error);
      if (category !== null) throw new GuardrailBlockedError(category);
      throw new GuardrailUnavailableError();
    }
  }
}
