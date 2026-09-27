import type { DiscordAttachment } from "./schemas";

const defaultFetcher: typeof fetch = (input, init) => fetch(input, init);

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

export type DiscordFile = {
  data: ArrayBuffer;
  filename: string;
  contentType: string | null;
};

async function apiResult(response: Response): Promise<DiscordApiResult> {
  if (response.ok) return { ok: true };
  return {
    ok: false,
    status: response.status,
    responseBody: (await response.text()).slice(0, 500),
  };
}

function messagePayload(content: string, file?: DiscordFile): { body: BodyInit; contentTypeHeader?: string } {
  const payload = { content, allowed_mentions: { parse: [] } };
  if (file === undefined) {
    return { body: JSON.stringify(payload), contentTypeHeader: "application/json" };
  }
  const form = new FormData();
  form.set("payload_json", JSON.stringify({
    ...payload,
    attachments: [{ id: 0, filename: file.filename }],
  }));
  form.set("files[0]", new File(
    [file.data],
    file.filename,
    { type: file.contentType ?? "application/octet-stream" },
  ));
  return { body: form };
}

export class DiscordRestClient {
  constructor(
    private readonly botToken: string,
    private readonly applicationId: string,
    private readonly fetcher: typeof fetch = defaultFetcher,
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

  async editOriginalResponse(token: string, content: string, file?: DiscordFile): Promise<DiscordApiResult> {
    const payload = messagePayload(content, file);
    const response = await this.fetcher(`https://discord.com/api/v10/webhooks/${this.applicationId}/${token}/messages/@original`, {
      method: "PATCH",
      ...(payload.contentTypeHeader === undefined ? {} : { headers: { "Content-Type": payload.contentTypeHeader } }),
      body: payload.body,
    });
    return apiResult(response);
  }

  async sendChannelMessage(channelId: string, content: string, file?: DiscordFile): Promise<DiscordApiResult> {
    const payload = messagePayload(content, file);
    const response = await this.fetcher(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: payload.contentTypeHeader === undefined
        ? { Authorization: `Bot ${this.botToken}` }
        : { Authorization: `Bot ${this.botToken}`, "Content-Type": payload.contentTypeHeader },
      body: payload.body,
    });
    return apiResult(response);
  }
}
