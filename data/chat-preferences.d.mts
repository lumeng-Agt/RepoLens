import type { z } from "zod";
export type ChatPreferences = { version: 1; draft: string; activeId: string; scrollTop: number; [key: string]: unknown };
export const ChatPreferencesSchema: z.ZodType<ChatPreferences>;
export function parseChatPreferences(value: unknown): z.ZodSafeParseResult<ChatPreferences>;
