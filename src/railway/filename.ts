import type { RailwayAnnouncementMetadata } from "./types";

const forbiddenFilenameCharacters = /[\\/:*?"<>|`]/gu;
const edgeCharacters = /^[\s._]+|[\s._]+$/gu;
const categoryNames: Record<RailwayAnnouncementMetadata["category"], string> = {
  approaching: "接近案内",
  arrival: "到着案内",
  departure: "発車案内",
  platform: "乗り場案内",
  transfer: "乗り換え案内",
  stopping_pattern: "停車駅案内",
  delay: "運行情報",
  safety: "安全案内",
  door_guidance: "乗降案内",
  general_information: "お知らせ",
  other: "案内放送",
};

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
  metadata: RailwayAnnouncementMetadata,
  originalFilename: string,
  maxLength = 180,
): string {
  const extensionCandidate = originalFilename.split(".").pop()?.toLowerCase();
  const extension = extensionCandidate !== undefined && /^[a-z0-9]{2,5}$/u.test(extensionCandidate) ? extensionCandidate : "mp3";
  const formatTime = (time: string, suffix: string): string => {
    const [hour, minute] = time.split(":");
    return `${Number(hour)}時${minute}分${suffix}`;
  };
  const departure = metadata.departureTime === null ? null : formatTime(metadata.departureTime, "発");
  const arrival = metadata.arrivalTime === null ? null : formatTime(metadata.arrivalTime, "着");
  const destination = metadata.destination === null ? null : `${metadata.destination}行き`;
  const nextStation = metadata.nextStation === null ? null : `次は${metadata.nextStation}`;
  const parts = [
    metadata.line,
    metadata.trainName,
    metadata.trainNumber,
    metadata.trainType,
    destination,
    departure,
    arrival,
    metadata.platform,
    nextStation,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .map((part) => sanitizeFilenamePart(part));
  const body = parts.length === 0 ? categoryNames[metadata.category] : parts.join("_");
  const suffixLength = extension.length + 1;
  return `${sanitizeFilenamePart(body, Math.max(1, maxLength - suffixLength))}.${extension}`;
}
