import type { DiscordAttachment } from "./schemas";

export class AttachmentUnavailableError extends Error {
  constructor(
    readonly reason: "attachment_too_large" | "attachment_unavailable",
    readonly status?: number,
  ) {
    super(status === undefined ? reason : `${reason} (HTTP ${status})`);
    this.name = "AttachmentUnavailableError";
  }
}

export type DiscordApiResult =
  | { ok: true }
  | { ok: false; status: number; responseBody: string };

async function apiResult(response: Response): Promise<DiscordApiResult> {
  if (response.ok) return { ok: true };
  return {
    ok: false,
    status: response.status,
    responseBody: (await response.text()).slice(0, 500),
  };
}

export class DiscordRestClient {
  constructor(
    private readonly botToken: string,
    private readonly applicationId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async downloadTemporaryAttachment(attachment: DiscordAttachment, maximumBytes: number): Promise<ArrayBuffer> {
    if (attachment.size > maximumBytes) throw new AttachmentUnavailableError("attachment_too_large");
    const response = await this.fetcher(attachment.url);
    if (!response.ok) throw new AttachmentUnavailableError("attachment_unavailable", response.status);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new AttachmentUnavailableError("attachment_too_large");
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > maximumBytes) throw new AttachmentUnavailableError("attachment_too_large");
    return body;
  }

  async editOriginalResponse(token: string, content: string): Promise<DiscordApiResult> {
    const response = await this.fetcher(`https://discord.com/api/v10/webhooks/${this.applicationId}/${token}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return apiResult(response);
  }

  async sendChannelMessage(channelId: string, content: string): Promise<DiscordApiResult> {
    const response = await this.fetcher(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return apiResult(response);
  }
}
