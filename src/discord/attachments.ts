import type { DiscordAttachment } from "./schemas";

const allowedContentTypes = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
]);
const allowedExtensions = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg"]);

export function isSupportedAudioAttachment(attachment: DiscordAttachment): boolean {
  const extension = attachment.filename.split(".").pop()?.toLowerCase();
  const extensionAllowed = extension !== undefined && allowedExtensions.has(extension);
  const contentTypeAllowed = attachment.contentType === null || allowedContentTypes.has(attachment.contentType.toLowerCase());
  return extensionAllowed && contentTypeAllowed;
}
