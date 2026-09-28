import type { RailwayAnnouncementMetadata } from "./types";

const forbiddenFilenameCharacters = /[\\/:*?"<>|`]/gu;
const edgeCharacters = /^[\s._]+|[\s._]+$/gu;

export function sanitizeFilenamePart(value: string, maxLength = 80): string {
  return value
    .normalize("NFKC")
    .replace(forbiddenFilenameCharacters, "_")
    .replace(/\s+/gu, " ")
    .replace(/_+/gu, "_")
    .replace(edgeCharacters, "")
    .slice(0, maxLength)
    .replace(edgeCharacters, "");
}

export function generateRailwayFilename(
  clipIndex: number,
  metadata: RailwayAnnouncementMetadata,
  originalFilename: string,
  maxLength = 180,
): string {
  const extensionCandidate = originalFilename.split(".").pop()?.toLowerCase();
  const extension = extensionCandidate !== undefined && /^[a-z0-9]{2,5}$/u.test(extensionCandidate) ? extensionCandidate : "mp3";
  const index = String(clipIndex).padStart(3, "0");
  const departure = metadata.departureTime === null ? null : `${metadata.departureTime.replace(":", "")}発`;
  const destination = metadata.destination === null ? null : `${metadata.destination}行き`;
  const parts = [metadata.line, metadata.trainType, destination, departure || null, metadata.summary]
    .filter((part): part is string => part !== null && part.length > 0)
    .map((part) => sanitizeFilenamePart(part));
  const body = parts.length === 0 ? "交通案内" : parts.join("_");
  const suffixLength = extension.length + 1;
  return `${index}_${sanitizeFilenamePart(body, Math.max(1, maxLength - index.length - suffixLength - 1))}.${extension}`;
}
