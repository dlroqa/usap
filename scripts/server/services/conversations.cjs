// services/conversations.cjs — saved chat conversations (Step 9.8h).
//
// Moved unchanged from serve.cjs: saving, listing and deleting conversations as JSON files in the chat
// history folder (`CHAT_HISTORY`, from paths.cjs; the folder and file format are unchanged). Ids are reduced
// to safe file names and every path is checked to stay inside the folder. Attached images are not saved.
"use strict";

const REQUIRED = ["CHAT_HISTORY","badRequest","formatBytes","fs","path","pathInside","readdirVisible","safeOutputName"];

function createConversationStore(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`conversations: missing dependency ${name}`);
  }
  const { CHAT_HISTORY, badRequest, formatBytes, fs, path, pathInside, readdirVisible, safeOutputName } = deps;

  function sanitizeChatMessageForStorage(message) {
    if (!message || typeof message !== "object") return null;
    const role = String(message.role || "").trim();
    if (!["system", "user", "assistant"].includes(role)) return null;
    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map((item) => {
        if (!item || typeof item !== "object") return item;
        if (item.type === "image_url") {
          return { type: "text", text: "[Attached image omitted from saved chat history]" };
        }
        return item;
      });
    } else if (typeof content !== "string") {
      content = content === undefined || content === null ? "" : String(content);
    }
    return {
      ...message,
      role,
      content,
    };
  }

  function sanitizeChatConversationForStorage(conversation = {}) {
    const now = Date.now();
    const id = safeOutputName(conversation.id || `chat_${now}`) || `chat_${now}`;
    const messages = Array.isArray(conversation.messages)
      ? conversation.messages.map(sanitizeChatMessageForStorage).filter(Boolean)
      : [];
    const timestamp = Number(conversation.timestamp) || now;
    return {
      id,
      title: String(conversation.title || "Chat Session").slice(0, 160),
      model: String(conversation.model || ""),
      messages,
      timestamp,
      createdAt: conversation.createdAt || new Date(timestamp).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function getChatConversationPath(id) {
    const safeId = safeOutputName(id);
    if (!safeId) throw badRequest("INVALID_REQUEST", "A chat id is required.");
    const filePath = path.join(CHAT_HISTORY, `${safeId}.json`);
    if (!pathInside(filePath, CHAT_HISTORY)) {
      throw new Error("Invalid chat id.");
    }
    return filePath;
  }

  function saveChatConversation(conversation = {}) {
    const saved = sanitizeChatConversationForStorage(conversation);
    const filePath = getChatConversationPath(saved.id);
    fs.writeFileSync(filePath, JSON.stringify(saved, null, 2), "utf8");
    return saved;
  }

  function listChatConversations() {
    try {
      return readdirVisible(CHAT_HISTORY)
        .filter((file) => file.toLowerCase().endsWith(".json"))
        .map((file) => {
          try {
            const filePath = path.join(CHAT_HISTORY, file);
            if (!pathInside(filePath, CHAT_HISTORY)) return null;
            const conversation = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const stat = fs.statSync(filePath);
            return {
              ...conversation,
              filename: file,
              modifiedAt: stat.mtime.toISOString(),
              sizeBytes: stat.size,
              size: formatBytes(stat.size),
            };
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    } catch (_) {
      return [];
    }
  }

  function deleteChatConversation(id) {
    const filePath = getChatConversationPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  return { sanitizeChatMessageForStorage, sanitizeChatConversationForStorage, getChatConversationPath, saveChatConversation, listChatConversations, deleteChatConversation };
}

module.exports = { createConversationStore };
