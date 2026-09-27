import type { DiscordAttachment } from "./schemas";

const allowedContentTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/x-mp3",
  "audio/x-mpeg",
  "audio/mpeg3",
  "audio/x-mpeg-3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
  "application/octet-stream",
]);
const allowedExtensions = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg"]);

export function isSupportedAudioAttachment(attachment: DiscordAttachment): boolean {
  const extension = attachment.filename.split(".").pop()?.toLowerCase();
  const extensionAllowed = extension !== undefined && allowedExtensions.has(extension);
  const contentType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  const contentTypeAllowed = contentType === null || allowedContentTypes.has(contentType);
  return extensionAllowed && contentTypeAllowed;
}
