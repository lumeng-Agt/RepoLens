import { useCallback, useState } from "react";
import type { ChatIntent } from "@/components/repolens/chat-intent";
import type { AiMode } from "@/data/explanation-provider";

export function useChatSidebar() {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatIntent, setChatIntent] = useState<ChatIntent>({ id: 0, mode: "question" });
  const [graphSelection, setGraphSelection] = useState<{ target: string; ids: string[] } | null>(null);

  const openAiChat = useCallback((mode: AiMode = "question", context: Omit<ChatIntent, "id" | "mode"> = {}) => {
    setChatOpen(true);
    setChatIntent((previous) => ({ ...context, id: previous.id + 1, mode }));
  }, []);

  return { chatOpen, setChatOpen, chatIntent, openAiChat, graphSelection, setGraphSelection };
}
