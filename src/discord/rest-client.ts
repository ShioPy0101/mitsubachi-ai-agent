import type { DiscordAttachment } from "./schemas";

export class AttachmentUnavailableError extends Error {}

export class DiscordRestClient {
  constructor(
    private readonly botToken: string,
    private readonly applicationId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async downloadTemporaryAttachment(attachment: DiscordAttachment, maximumBytes: number): Promise<ArrayBuffer> {
    if (attachment.size > maximumBytes) throw new AttachmentUnavailableError("attachment_too_large");
    const response = await this.fetcher(attachment.url);
    if (!response.ok) throw new AttachmentUnavailableError("attachment_unavailable");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new AttachmentUnavailableError("attachment_too_large");
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > maximumBytes) throw new AttachmentUnavailableError("attachment_too_large");
    return body;
  }

  async followUp(token: string, content: string): Promise<boolean> {
    const response = await this.fetcher(`https://discord.com/api/v10/webhooks/${this.applicationId}/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, flags: 64 }),
    });
    return response.ok;
  }

  async sendChannelMessage(channelId: string, content: string): Promise<boolean> {
    const response = await this.fetcher(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  }
}
