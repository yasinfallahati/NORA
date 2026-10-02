const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const dataDir = path.join(__dirname, "..", "data");
const uploadDir = path.join(dataDir, "uploads");
const settingsFile = path.join(dataDir, "settings.json");
const conversationsFile = path.join(dataDir, "conversations.json");
const memoryFile = path.join(dataDir, "memory.json");

const textExtensions = new Set([".txt", ".md", ".json", ".csv"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultSettings = {
  chatProvider: "local",
  imageProvider: "local",
  apiBaseUrl: "",
  apiKey: "",
  apiChatModel: "",
  apiImageModel: "",
  localChatModel: "",
  localImageModel: "",
  memoryEnabled: true,
};

let writeChain = Promise.resolve();

function ensureData() {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
}

function updateJson(file, fallback, mutator) {
  const run = writeChain.then(async () => {
    ensureData();
    const current = readJson(file, fallback);
    const next = await mutator(current);
    writeJson(file, next);
    return next;
  });
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

function clip(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function publicSettings(settings) {
  return {
    chatProvider: settings.chatProvider === "api" ? "api" : "local",
    imageProvider: settings.imageProvider === "api" ? "api" : "local",
    apiBaseUrl: settings.apiBaseUrl || "",
    hasApiKey: Boolean(settings.apiKey),
    apiKeyHint: settings.apiKey ? `…${settings.apiKey.slice(-4)}` : "",
    apiChatModel: settings.apiChatModel || "",
    apiImageModel: settings.apiImageModel || "",
    localChatModel: settings.localChatModel || "",
    localImageModel: settings.localImageModel || "",
    memoryEnabled: settings.memoryEnabled !== false,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw validationError("آدرس API معتبر نیست.");
  }
  if (url.username || url.password) {
    throw validationError("کلید را در فیلد جدا بگذارید، نه داخل آدرس.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw validationError("آدرس API باید با http یا https شروع شود.");
  }
  return url.toString().replace(/\/+$/, "");
}

function readSettings() {
  ensureData();
  const saved = readJson(settingsFile, {});
  return { ...defaultSettings, ...saved, apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "" };
}

function writeSettings(patch) {
  return updateJson(settingsFile, defaultSettings, (current) => {
    const merged = { ...defaultSettings, ...current };
    if (patch.chatProvider === "local" || patch.chatProvider === "api") merged.chatProvider = patch.chatProvider;
    if (patch.imageProvider === "local" || patch.imageProvider === "api") merged.imageProvider = patch.imageProvider;
    if (typeof patch.apiBaseUrl === "string") {
      merged.apiBaseUrl = patch.apiBaseUrl.trim() ? normalizeBaseUrl(patch.apiBaseUrl) : "";
    }
    if (patch.clearApiKey) merged.apiKey = "";
    else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) merged.apiKey = patch.apiKey.trim().slice(0, 500);
    for (const key of ["apiChatModel", "apiImageModel", "localChatModel", "localImageModel"]) {
      if (typeof patch[key] === "string") merged[key] = clip(patch[key].trim(), 200);
    }
    if (typeof patch.memoryEnabled === "boolean") merged.memoryEnabled = patch.memoryEnabled;
    return merged;
  });
}

function isUuid(value) {
  return typeof value === "string" && uuidPattern.test(value);
}

function cleanAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 4).flatMap((file) => {
    if (!file || !isUuid(file.id)) return [];
    const kind = file.kind === "image" || file.kind === "text" || file.kind === "file" ? file.kind : "file";
    return [{
      id: file.id,
      name: clip(file.name, 120) || "file",
      mime: clip(file.mime, 120) || "application/octet-stream",
      kind,
    }];
  });
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-400).flatMap((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant")) return [];
    const imageUrl = typeof message.imageUrl === "string"
      && /^\/api\/(?:uploads\/[0-9a-f-]{36}|image-file\?[\w%=&:+./-]+)$/i.test(message.imageUrl)
      ? message.imageUrl
      : "";
    return [{
      role: message.role,
      content: clip(message.content, 100000),
      attachments: cleanAttachments(message.attachments),
      ...(message.type === "image" ? { type: "image" } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(typeof message.model === "string" && message.model.trim() ? { model: clip(message.model.trim(), 200) } : {}),
    }];
  });
}

function readConversations() {
  ensureData();
  const saved = readJson(conversationsFile, []);
  return Array.isArray(saved) ? saved : [];
}

function writeConversations(conversations) {
  if (!Array.isArray(conversations) || conversations.length > 300) {
    throw validationError("فهرست گفتگوها معتبر نیست.");
  }
  const clean = conversations.map((conversation) => {
    if (!conversation || !isUuid(conversation.id)) throw validationError("شناسهٔ گفتگو معتبر نیست.");
    return {
      id: conversation.id,
      title: clip(conversation.title, 80) || "گفتگوی تازه",
      messages: cleanMessages(conversation.messages),
    };
  });
  return updateJson(conversationsFile, [], () => clean);
}

function emptyMemory() {
  return { facts: [], journal: [] };
}

function readMemory() {
  ensureData();
  const saved = readJson(memoryFile, emptyMemory());
  return {
    facts: Array.isArray(saved.facts) ? saved.facts : [],
    journal: Array.isArray(saved.journal) ? saved.journal : [],
  };
}

function publicMemory() {
  const memory = readMemory();
  return {
    facts: memory.facts.map(({ id, text, createdAt }) => ({ id, text, createdAt })),
    recent: memory.journal.slice(-20).reverse().map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    counts: { facts: memory.facts.length, journal: memory.journal.length },
  };
}

function addMemoryEntry(entry) {
  return updateJson(memoryFile, emptyMemory(), (memory) => {
    const next = {
      facts: Array.isArray(memory.facts) ? memory.facts : [],
      journal: Array.isArray(memory.journal) ? memory.journal : [],
    };
    if (entry.fact) {
      const text = clip(entry.fact, 240).trim();
      const known = next.facts.some((fact) => fact.text.trim() === text);
      if (text && !known) {
        next.facts.push({ id: randomUUID(), text, createdAt: Date.now() });
      }
    }
    if (entry.journal) {
      next.journal.push({
        id: randomUUID(),
        conversationId: isUuid(entry.journal.conversationId) ? entry.journal.conversationId : "",
        role: entry.journal.role === "assistant" ? "assistant" : "user",
        text: clip(entry.journal.text, 2000),
        createdAt: Date.now(),
      });
      if (next.journal.length > 5000) next.journal = next.journal.slice(-5000);
    }
    if (next.facts.length > 2000) next.facts = next.facts.slice(-2000);
    return next;
  });
}

function deleteMemoryEntry(id) {
  if (!isUuid(id)) throw validationError("شناسهٔ یادداشت معتبر نیست.");
  return updateJson(memoryFile, emptyMemory(), (memory) => ({
    facts: (memory.facts || []).filter((fact) => fact.id !== id),
    journal: (memory.journal || []).filter((item) => item.id !== id),
  }));
}

function clearMemory() {
  return updateJson(memoryFile, emptyMemory(), () => emptyMemory());
}

function wordsOf(text) {
  return new Set(String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));
}

function recall(query, excludeConversationId = "") {
  const memory = readMemory();
  const queryWords = wordsOf(query);
  const ranked = memory.journal
    .filter((item) => item.conversationId !== excludeConversationId)
    .map((item, index) => {
      const words = wordsOf(item.text);
      let score = 0;
      for (const word of queryWords) if (words.has(word)) score += 1;
      return { item, score, index };
    })
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const picked = [];
  const seen = new Set();
  for (const entry of ranked) {
    if (entry.score <= 0 || picked.length >= 8) break;
    picked.push(entry.item);
    seen.add(entry.item.id);
  }
  for (const item of memory.journal.filter((item) => item.conversationId !== excludeConversationId).slice(-4)) {
    if (!seen.has(item.id)) picked.push(item);
  }

  const lines = [];
  let budget = 7000;
  if (memory.facts.length) {
    lines.push("یادداشت‌های پایدار:");
    for (const fact of memory.facts.slice(-40)) {
      const line = `- ${fact.text}`;
      if (budget - line.length < 0) break;
      lines.push(line);
      budget -= line.length;
    }
  }
  if (picked.length) {
    lines.push("گفته‌های مرتبط از گفتگوهای قبلی:");
    for (const item of picked) {
      const line = `- ${item.role === "assistant" ? "دستیار" : "کاربر"}: ${item.text}`;
      if (budget - line.length < 0) break;
      lines.push(line);
      budget -= line.length;
    }
  }
  if (!lines.length) return "";
  return `${lines.join("\n")}\nاین یادداشت‌ها را فقط وقتی به کار ببر که به سؤال فعلی مربوط باشند.`;
}

function explicitFacts(text) {
  const facts = [];
  const source = String(text || "").trim();
  const remembered = source.match(/(?:یادت\s*باشد|یادت\s*باشه|به\s*خاطر\s*بسپار|remember(?:\s+that)?)\s*[:：]?\s*(.{3,200})/i);
  if (remembered) facts.push(remembered[1].trim().replace(/[.。]+$/, ""));
  const name = source.match(/اسم من\s+([^\n،.]{2,40})\s+(?:است|هست)/);
  if (name) facts.push(`اسم کاربر ${name[1].trim()} است.`);
  return facts;
}

function kindFor(name, mime) {
  const extension = path.extname(name || "").toLowerCase();
  if (String(mime || "").startsWith("image/") || imageExtensions.has(extension)) return "image";
  if (String(mime || "").startsWith("text/") || mime === "application/json" || textExtensions.has(extension)) return "text";
  if (mime === "application/pdf" || extension === ".pdf") return "file";
  return "";
}

function saveUpload({ name, mime, dataBase64, buffer }) {
  ensureData();
  const safeName = path.basename(clip(name, 120) || "file").replace(/[^\w.\-\u0600-\u06FF ]+/g, "") || "file";
  const kind = kindFor(safeName, mime);
  if (!kind) throw validationError("این نوع فایل پذیرفته نمی‌شود. تصویر، متن، یا PDF بفرستید.");
  const bytes = buffer || Buffer.from(String(dataBase64 || "").replace(/^data:[^,]+,/, ""), "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw validationError("حجم فایل باید کمتر از ۸ مگابایت باشد.");
  const id = randomUUID();
  const meta = { id, name: safeName, mime: clip(mime, 120) || "application/octet-stream", kind, size: bytes.length };
  if (kind === "text") {
    meta.text = bytes.toString("utf8").replace(/\u0000/g, "").slice(0, 20000);
  }
  fs.writeFileSync(path.join(uploadDir, id), bytes);
  fs.writeFileSync(path.join(uploadDir, `${id}.json`), JSON.stringify(meta));
  return { id, name: meta.name, mime: meta.mime, kind };
}

function readUpload(id) {
  if (!isUuid(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(uploadDir, `${id}.json`), "utf8"));
    const bytes = fs.readFileSync(path.join(uploadDir, id));
    return {
      ...meta,
      buffer: bytes,
      base64: bytes.toString("base64"),
      text: typeof meta.text === "string" ? meta.text : "",
    };
  } catch {
    return null;
  }
}

module.exports = {
  addMemoryEntry,
  cleanMessages,
  clearMemory,
  deleteMemoryEntry,
  explicitFacts,
  isUuid,
  publicMemory,
  publicSettings,
  readConversations,
  readMemory,
  readSettings,
  readUpload,
  recall,
  saveUpload,
  writeConversations,
  writeSettings,
};
