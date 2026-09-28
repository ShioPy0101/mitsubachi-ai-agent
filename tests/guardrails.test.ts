import { describe, expect, it, vi } from "vitest";
import {
  CloudflareAiGatewayGuardrails,
  GuardrailBlockedError,
  GuardrailUnavailableError,
  type GuardrailsAiRunner,
} from "../src/guardrails/cloudflare-ai-gateway";

function runner(run: GuardrailsAiRunner["run"]): GuardrailsAiRunner {
  return { run };
}

describe("Cloudflare AI Gateway Guardrails", () => {
  it("passes the transcription as an uncached, unlogged Gateway prompt", async () => {
    const run = vi.fn<GuardrailsAiRunner["run"]>().mockResolvedValue({ response: "ok" });
    await new CloudflareAiGatewayGuardrails(runner(run), "safety-gateway").assertAllowed("安全な駅放送");

    expect(run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.2-1b-instruct",
      { prompt: "安全な駅放送", max_tokens: 1, temperature: 0 },
      { gateway: { id: "safety-gateway", collectLog: false, skipCache: true } },
    );
  });

  it("turns a prompt block into a policy result with only its category", async () => {
    const run = vi.fn<GuardrailsAiRunner["run"]>().mockRejectedValue(
      Object.assign(new Error("2016 Prompt blocked; categories: S1 S12"), { code: 2016 }),
    );

    await expect(
      new CloudflareAiGatewayGuardrails(runner(run), "safety-gateway").assertAllowed("blocked text"),
    ).rejects.toEqual(new GuardrailBlockedError("S1,S12"));
  });

  it("uses a non-content fallback when Cloudflare omits category details", async () => {
    const run = vi.fn<GuardrailsAiRunner["run"]>().mockRejectedValue(new Error("error code 2016"));

    await expect(
      new CloudflareAiGatewayGuardrails(runner(run), "safety-gateway").assertAllowed("blocked text"),
    ).rejects.toEqual(new GuardrailBlockedError("guardrails_policy"));
  });

  it("fails closed on Gateway failures or missing configuration", async () => {
    const run = vi.fn<GuardrailsAiRunner["run"]>().mockRejectedValue(new Error("network failure with private text"));
    await expect(
      new CloudflareAiGatewayGuardrails(runner(run), "safety-gateway").assertAllowed("private text"),
    ).rejects.toEqual(new GuardrailUnavailableError());
    await expect(
      new CloudflareAiGatewayGuardrails(runner(run), " ").assertAllowed("private text"),
    ).rejects.toEqual(new GuardrailUnavailableError());
  });
});
