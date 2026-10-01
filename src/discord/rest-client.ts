import type { DiscordAttachment } from "./schemas";

const defaultFetcher: typeof fetch = (input, init) => fetch(input, init);
const defaultRequestTimeoutMs = 30_000;
const maximumRateLimitRetries = 5;

export class DiscordRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Discord request timed out after ${timeoutMs}ms`);
    this.name = "DiscordRequestTimeoutError";
  }
}

export class AttachmentUnavailableError extends Error {
  constructor(
    readonly reason:
      | "attachment_too_large"
      | "attachment_unavailable"
      | "attachment_invalid_content"
      | "attachment_empty",
    readonly status?: number,
  ) {
    super(status === undefined ? reason : `${reason} (HTTP ${status})`);
    this.name = "AttachmentUnavailableError";
  }
}

export type DiscordApiResult =
  { ok: true } | { ok: false; status: number; responseBody: string };
export type DiscordMessageResult =
  | { ok: true; messageId: string }
  | { ok: false; status: number; responseBody: string };

export type DiscordMessageComponent = {
  type: 1;
  components: Array<{
    type: 2;
    style: number;
    custom_id: string;
    label: string;
    emoji?: { name: string };
    disabled?: boolean;
  }>;
};

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

function messagePayload(
  content: string,
  file?: DiscordFile,
): { body: BodyInit; contentTypeHeader?: string } {
  const payload = { content, allowed_mentions: { parse: [] } };
  if (file === undefined) {
    return {
      body: JSON.stringify(payload),
      contentTypeHeader: "application/json",
    };
  }
  const form = new FormData();
  form.set(
    "payload_json",
    JSON.stringify({
      ...payload,
      attachments: [{ id: 0, filename: file.filename }],
    }),
  );
  form.set(
    "files[0]",
    new File([file.data], file.filename, {
      type: file.contentType ?? "application/octet-stream",
    }),
  );
  return { body: form };
}

export class DiscordRestClient {
  constructor(
    private readonly botToken: string,
    private readonly applicationId: string,
    private readonly fetcher: typeof fetch = defaultFetcher,
    private readonly timeoutMs = defaultRequestTimeoutMs,
  ) {}

  private async request(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new DiscordRequestTimeoutError(this.timeoutMs)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([this.fetcher(input, init), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  async downloadTemporaryAttachment(
    attachment: DiscordAttachment,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (attachment.size > maximumBytes) {
      throw new AttachmentUnavailableError("attachment_too_large");
    }

    signal?.throwIfAborted();
    const response = await this.request(
      attachment.url,
      signal ? { signal } : undefined,
    );

    if (!response.ok) {
      throw new AttachmentUnavailableError(
        "attachment_unavailable",
        response.status,
      );
    }

    const responseContentType = response.headers.get("content-type");
    const contentLengthHeader = response.headers.get("content-length");
    const declaredLength =
      contentLengthHeader === null ? null : Number(contentLengthHeader);

    if (
      declaredLength !== null &&
      Number.isFinite(declaredLength) &&
      declaredLength > maximumBytes
    ) {
      throw new AttachmentUnavailableError("attachment_too_large");
    }

    const body = await response.arrayBuffer();
    signal?.throwIfAborted();

    if (body.byteLength > maximumBytes) {
      throw new AttachmentUnavailableError("attachment_too_large");
    }

    if (body.byteLength === 0) {
      throw new AttachmentUnavailableError("attachment_empty");
    }

    const bytes = new Uint8Array(body);

    console.info("discord_attachment_downloaded", {
      filename: attachment.filename,
      expectedSize: attachment.size,
      actualSize: body.byteLength,
      attachmentContentType: attachment.contentType,
      responseContentType,
      contentLength: declaredLength,
      firstBytes: Array.from(bytes.slice(0, 32))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" "),
    });

    if (
      responseContentType?.startsWith("text/") ||
      responseContentType?.includes("application/json")
    ) {
      throw new AttachmentUnavailableError("attachment_invalid_content");
    }

    return body;
  }

  async editOriginalResponse(
    token: string,
    content: string,
    file?: DiscordFile,
  ): Promise<DiscordApiResult> {
    const payload = messagePayload(content, file);
    const response = await this.request(
      `https://discord.com/api/v10/webhooks/${this.applicationId}/${token}/messages/@original`,
      {
        method: "PATCH",
        ...(payload.contentTypeHeader === undefined
          ? {}
          : { headers: { "Content-Type": payload.contentTypeHeader } }),
        body: payload.body,
      },
    );
    return apiResult(response);
  }

  async sendInteractionFollowup(
    token: string,
    content: string,
    file?: DiscordFile,
  ): Promise<DiscordApiResult> {
    const payload = messagePayload(content, file);
    for (let attempt = 0; attempt <= maximumRateLimitRetries; attempt += 1) {
      const response = await this.request(
        `https://discord.com/api/v10/webhooks/${this.applicationId}/${token}`,
        {
          method: "POST",
          ...(payload.contentTypeHeader === undefined
            ? {}
            : { headers: { "Content-Type": payload.contentTypeHeader } }),
          body: payload.body,
        },
      );
      if (response.status !== 429 || attempt === maximumRateLimitRetries)
        return apiResult(response);
      const rateLimit = (await response.json().catch(() => null)) as {
        retry_after?: unknown;
      } | null;
      const retryAfterSeconds =
        typeof rateLimit?.retry_after === "number" ? rateLimit.retry_after : 1;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(10_000, Math.max(100, retryAfterSeconds * 1_000)),
        ),
      );
    }
    throw new Error("unreachable");
  }

  async sendChannelMessage(
    channelId: string,
    content: string,
    file?: DiscordFile,
  ): Promise<DiscordApiResult> {
    const payload = messagePayload(content, file);
    const response = await this.request(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers:
          payload.contentTypeHeader === undefined
            ? { Authorization: `Bot ${this.botToken}` }
            : {
                Authorization: `Bot ${this.botToken}`,
                "Content-Type": payload.contentTypeHeader,
              },
        body: payload.body,
      },
    );
    return apiResult(response);
  }

  async createChannelMessage(
    channelId: string,
    content: string,
    components: DiscordMessageComponent[] = [],
  ): Promise<DiscordMessageResult> {
    const response = await this.request(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          components,
          allowed_mentions: { parse: [] },
        }),
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        responseBody: (await response.text()).slice(0, 500),
      };
    }
    const body = (await response.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    if (typeof body?.id !== "string") {
      return {
        ok: false,
        status: response.status,
        responseBody: "Discord response did not contain a message id",
      };
    }
    return { ok: true, messageId: body.id };
  }

  async editChannelMessage(
    channelId: string,
    messageId: string,
    content: string,
    components: DiscordMessageComponent[] = [],
  ): Promise<DiscordApiResult> {
    const response = await this.request(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          components,
          allowed_mentions: { parse: [] },
        }),
      },
    );
    return apiResult(response);
  }
}
