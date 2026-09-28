import { z } from "zod";

const ControllerIdsSchema = z.array(z.string().min(1));

export function canControlGuild(rawControllerIds: string, userId: string | null): boolean {
  if (userId === null) return false;
  try {
    return ControllerIdsSchema.parse(JSON.parse(rawControllerIds)).includes(userId);
  } catch {
    return false;
  }
}
