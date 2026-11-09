import { z } from "zod";

export const ChatPreferencesSchema = z.object({
  version: z.literal(1), draft: z.string().max(12000), activeId: z.string().max(160),
  scrollTop: z.number().finite().nonnegative(),
}).passthrough();

export function parseChatPreferences(value) {
  return ChatPreferencesSchema.safeParse(value ?? { version: 1, draft: "", activeId: "", scrollTop: 0 });
}
