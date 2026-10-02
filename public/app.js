const modelSelect = document.querySelector("#modelSelect");
const imageModelSelect = document.querySelector("#imageModelSelect");
const modeSelect = document.querySelector("#modeSelect");
const modelLabel = document.querySelector("#activeModelLabel");
const messagesEl = document.querySelector("#messages");
const welcomeEl = document.querySelector("#welcome");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const form = document.querySelector("#chatForm");
const conversationList = document.querySelector("#conversationList");
const connectionState = document.querySelector("#connectionState");
const connectionText = document.querySelector("#connectionText");
const sidebar = document.querySelector("#sidebar");
const mobileBackdrop = document.querySelector("#mobileBackdrop");
const attachmentTray = document.querySelector("#attachmentTray");
const fileInput = document.querySelector("#fileInput");
const searchInput = document.querySelector("#searchInput");
const apiModal = document.querySelector("#apiModal");
const memoryModal = document.querySelector("#memoryModal");
const apiNote = document.querySelector("#apiNote");
const composerError = document.querySelector("#composerError");
const privacyCopy = document.querySelector("#privacyCopy");
const sourcePill = document.querySelector("#sourcePill");

let conversations = [];
let activeConversationId = null;
let abortController = null;
let pendingFiles = [];
let settings = {
  chatProvider: "local",
  imageProvider: "local",
  apiBaseUrl: "",
  hasApiKey: false,
  apiKeyHint: "",
  apiChatModel: "",
  apiImageModel: "",
  localChatModel: "",
  localImageModel: "",
  memoryEnabled: true,
};
let draftProviders = { chatProvider: "local", imageProvider: "local" };
let backendStatus = { chat: false, image: false, chatError: "", imageError: "" };
let saveTimer = null;

function setComposerError(text) {
  if (!composerError) return;
  if (!text) {
    composerError.hidden = true;
    composerError.textContent = "";
    return;
  }
  composerError.hidden = false;
  composerError.textContent = text;
}

function setConnection(connected, text) {
  connectionState.classList.toggle("offline", !connected);
  connectionText.textContent = text;
}

function selectedConversation() {
  return conversations.find((conversation) => conversation.id === activeConversationId);
}

function fillSelect(select, values, preferred) {
  select.replaceChildren();
  if (!values.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "مدلی پیدا نشد";
    select.append(option);
    return;
  }
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  if (preferred && values.includes(preferred)) select.value = preferred;
  else select.value = values[0];
}

function updateModeConnection() {
  const imageMode = modeSelect.value === "image";
  const connected = imageMode ? backendStatus.image : backendStatus.chat;
  const text = imageMode
    ? connected
      ? settings.imageProvider === "api" ? "متصل به API تصویر" : "متصل به مدل تصویر"
      : backendStatus.imageError || "ساخت تصویر در دسترس نیست"
    : connected
      ? settings.chatProvider === "api" ? "متصل به API گفتگو" : "متصل به Ollama"
      : backendStatus.chatError || "اتصال گفتگو برقرار نیست";
  setConnection(connected, text);
}

function updateModelLabel() {
  const selectedModel = modeSelect.value === "image" ? imageModelSelect.value : modelSelect.value;
  modelLabel.textContent = selectedModel || (modeSelect.value === "image" ? "مدل تصویر" : "مدل گفتگو");
}

function updateSourceUi() {
  const usingApi = settings.chatProvider === "api" || settings.imageProvider === "api";
  sourcePill.innerHTML = usingApi ? "<span></span> API" : "<span></span> محلی";
  privacyCopy.textContent = usingApi
    ? "کلید API فقط روی این دستگاه ذخیره می‌شود."
    : "همه‌چیز روی دستگاه شماست.";
}

function updateModeUi() {
  const imageMode = modeSelect.value === "image";
  modelSelect.hidden = imageMode;
  imageModelSelect.hidden = !imageMode;
  input.placeholder = imageMode ? "تصویر دلخواهتان را توصیف کنید..." : "هر چیزی که در ذهن دارید بپرسید...";
  input.setAttribute("aria-label", imageMode ? "توضیح تصویر" : "پیام شما");
  document.querySelector("#welcomeTitle").innerHTML = imageMode
    ? 'چه تصویری در ذهن دارید<span class="heading-dot">؟</span>'
    : 'از کجا شروع کنیم<span class="heading-dot">؟</span>';
  document.querySelector("#welcomeCopy").textContent = imageMode
    ? "توضیح تصویر را بنویسید تا ساخته شود. می‌توانید از مدل داخل پروژه یا API استفاده کنید."
    : "یک سؤال بپرسید، فایل بفرستید، یا از من بخواهید تصویر بسازم.";
  document.querySelector("#suggestionGrid").hidden = imageMode;
  const description = document.querySelector("#composerDescription");
  description.replaceChildren(
    document.createTextNode(imageMode ? "تصویر با " : "پاسخ‌ها با "),
    modelLabel,
    document.createTextNode(imageMode ? " ساخته می‌شود" : " ساخته می‌شوند"),
  );
  updateModelLabel();
  updateModeConnection();
}

function applyBootstrap(data) {
  settings = { ...settings, ...data.settings };
  draftProviders = {
    chatProvider: settings.chatProvider,
    imageProvider: settings.imageProvider,
  };
  backendStatus = {
    chat: Boolean(data.chatOk),
    image: Boolean(data.imageOk),
    chatError: data.chatError || "",
    imageError: data.imageError || "",
  };
  fillSelect(
    modelSelect,
    data.chatModels || [],
    settings.chatProvider === "api" ? settings.apiChatModel : settings.localChatModel,
  );
  fillSelect(
    imageModelSelect,
    data.imageModels || [],
    settings.imageProvider === "api" ? settings.apiImageModel : settings.localImageModel,
  );
  updateSourceUi();
  updateModeUi();
}

async function loadBootstrap() {
  const response = await fetch("/api/bootstrap");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "بارگذاری تنظیمات ناموفق بود.");
  applyBootstrap(data);
}

async function loadConversations() {
  try {
    const response = await fetch("/api/conversations");
    const data = await response.json();
    if (response.ok && Array.isArray(data.conversations)) {
      conversations = data.conversations;
      return;
    }
  } catch {
    /* fallback below */
  }
  try {
    const saved = JSON.parse(localStorage.getItem("chatkhane-conversations-v1") || "[]");
    conversations = Array.isArray(saved) ? saved : [];
    if (conversations.length) await persistConversations();
  } catch {
    conversations = [];
  }
}

function persistConversations() {
  clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = setTimeout(async () => {
      try {
        await fetch("/api/conversations", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversations }),
        });
      } catch (error) {
        console.error(error);
      }
      resolve();
    }, 250);
  });
}

function renderPendingFiles() {
  attachmentTray.replaceChildren();
  for (const file of pendingFiles) {
    const chip = document.createElement("div");
    chip.className = "file-chip";
    if (file.kind === "image") {
      const image = document.createElement("img");
      image.src = `/api/uploads/${file.id}`;
      image.alt = file.name;
      chip.append(image);
    }
    const label = document.createElement("span");
    label.textContent = file.name;
    chip.append(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "حذف پیوست");
    remove.addEventListener("click", () => {
      pendingFiles = pendingFiles.filter((item) => item.id !== file.id);
      renderPendingFiles();
    });
    chip.append(remove);
    attachmentTray.append(chip);
  }
}

function renderConversations() {
  conversationList.replaceChildren();
  const query = (searchInput?.value || "").trim().toLowerCase();
  const items = [...conversations]
    .reverse()
    .filter((conversation) => {
      if (!query) return true;
      const haystack = `${conversation.title}\n${(conversation.messages || []).map((message) => message.content || "").join("\n")}`.toLowerCase();
      return haystack.includes(query);
    });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-history";
    empty.textContent = query ? "نتیجه‌ای پیدا نشد." : "گفتگوهای شما اینجا نمایش داده می‌شوند.";
    conversationList.append(empty);
    return;
  }
  for (const conversation of items) {
    const row = document.createElement("div");
    row.className = `conversation-item${conversation.id === activeConversationId ? " active" : ""}`;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "conversation-item";
    open.style.cssText = "min-width:0;flex:1;padding:0;background:none;border:0;";
    open.innerHTML = '<span class="chat-icon">◷</span>';
    const title = document.createElement("span");
    title.className = "conversation-name";
    title.textContent = conversation.title;
    open.append(title);
    open.addEventListener("click", () => openConversation(conversation.id));
    const remove = document.createElement("button");
    remove.className = "conversation-delete";
    remove.type = "button";
    remove.setAttribute("aria-label", "حذف گفتگو");
    remove.textContent = "×";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      conversations = conversations.filter((item) => item.id !== conversation.id);
      if (activeConversationId === conversation.id) startNewChat();
      await persistConversations();
      renderConversations();
    });
    row.append(open, remove);
    conversationList.append(row);
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatMessage(text) {
  const escaped = escapeHtml(text);
  const codeBlocks = [];
  let html = escaped.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|\n)### (.+)/g, "$1<strong>$2</strong>");
  html = html.replace(/(^|\n)([-*] .+(?:\n[-*] .+)*)/g, (_, prefix, list) => {
    const items = list.split("\n").map((item) => `<li>${item.slice(2)}</li>`).join("");
    return `${prefix}<ul>${items}</ul>`;
  });
  html = html.split(/\n{2,}/).map((paragraph) => {
    if (paragraph.startsWith("<pre>") || paragraph.startsWith("<ul>") || paragraph.startsWith("\u0000CODE")) {
      return paragraph;
    }
    return `<p>${paragraph.replace(/\n/g, "<br>")}</p>`;
  }).join("");
  return html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)]);
}

function stripImageTag(text) {
  return String(text || "").replace(/\[\[\s*image\s*:\s*([\s\S]*?)\]\]/gi, "").trim();
}

function extractImagePrompt(text) {
  const match = String(text || "").match(/\[\[\s*image\s*:\s*([\s\S]*?)\]\]/i);
  return match ? match[1].trim() : "";
}

function renderMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;
  const avatar = document.createElement("div");
  avatar.className = `avatar ${message.role === "user" ? "user-avatar" : "assistant-avatar"}`;
  avatar.textContent = message.role === "user" ? "ش" : "✳";
  const content = document.createElement("div");
  content.className = "message-content";
  if (message.role === "assistant") {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = message.model || modelSelect.value || "Nora";
    content.append(meta);
  }
  if (message.attachments?.length) {
    const files = document.createElement("div");
    files.className = "message-files";
    for (const file of message.attachments) {
      if (file.kind === "image") {
        const image = document.createElement("img");
        image.src = `/api/uploads/${file.id}`;
        image.alt = file.name;
        files.append(image);
      }
      const link = document.createElement("a");
      link.href = `/api/uploads/${file.id}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = file.name;
      files.append(link);
    }
    content.append(files);
  }
  const body = document.createElement("div");
  body.className = "message-body";
  if (message.role === "assistant" && message.type === "image") {
    const image = document.createElement("img");
    image.className = "generated-image";
    image.src = message.imageUrl;
    image.alt = message.content || "تصویر تولیدشده";
    body.append(image);
    if (message.content) {
      const caption = document.createElement("p");
      caption.textContent = message.content;
      body.append(caption);
    }
  } else if (message.role === "assistant") {
    body.innerHTML = formatMessage(stripImageTag(message.content || ""));
    if (message.content) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "copy-button";
      copy.textContent = "کپی";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(stripImageTag(message.content));
        copy.textContent = "کپی شد";
        setTimeout(() => {
          copy.textContent = "کپی";
        }, 1200);
      });
      content.append(copy);
    }
  } else {
    body.textContent = message.content || "";
  }
  content.append(body);
  wrapper.append(avatar, content);
  messagesEl.append(wrapper);
  return body;
}

function renderChat() {
  messagesEl.replaceChildren();
  const conversation = selectedConversation();
  const hasMessages = Boolean(conversation?.messages.length);
  welcomeEl.hidden = hasMessages;
  messagesEl.classList.toggle("visible", hasMessages);
  document.querySelector("#breadcrumbTitle").textContent = conversation?.title || "گفتگوی تازه";
  if (hasMessages) conversation.messages.forEach(renderMessage);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderConversations();
}

function openConversation(id) {
  if (abortController) abortController.abort();
  activeConversationId = id;
  pendingFiles = [];
  renderPendingFiles();
  renderChat();
  closeMobileSidebar();
}

function startNewChat() {
  if (abortController) abortController.abort();
  activeConversationId = null;
  pendingFiles = [];
  renderPendingFiles();
  setComposerError("");
  renderChat();
  input.focus();
  closeMobileSidebar();
}

function createConversation() {
  const conversation = { id: crypto.randomUUID(), title: "گفتگوی تازه", messages: [] };
  conversations.push(conversation);
  activeConversationId = conversation.id;
  return conversation;
}

function updateAssistantBody(body, text, error = false) {
  body.innerHTML = formatMessage(stripImageTag(text) || " ");
  if (error) body.classList.add("error-message");
}

function setBusy(busy) {
  sendButton.classList.toggle("is-generating", busy);
  sendButton.setAttribute("aria-label", busy ? "توقف" : "ارسال پیام");
  sendButton.title = busy ? "توقف" : "ارسال پیام";
  input.disabled = busy;
  modelSelect.disabled = busy;
  imageModelSelect.disabled = busy;
  modeSelect.disabled = busy;
  fileInput.disabled = busy;
}

async function uploadFile(file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("خواندن فایل ناموفق بود."));
    reader.readAsDataURL(file);
  });
  const response = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, mime: file.type, data }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "آپلود ناموفق بود.");
  return payload;
}

async function requestImage(prompt, model) {
  const response = await fetch("/api/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt }),
    signal: abortController?.signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "ساخت تصویر ناموفق بود.");
  if (typeof data.imageUrl !== "string" || !data.imageUrl.startsWith("/api/uploads/")) {
    throw new Error("پاسخ تصویر از سرور معتبر نیست.");
  }
  return data;
}

async function learnMemory(userText, assistantText, model) {
  if (!settings.memoryEnabled) return;
  try {
    await fetch("/api/memory/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: activeConversationId,
        user: userText,
        assistant: assistantText,
        model,
      }),
    });
  } catch (error) {
    console.error(error);
  }
}

async function sendMessage(text) {
  setComposerError("");
  const imageMode = modeSelect.value === "image";
  const selectedModel = imageMode ? imageModelSelect.value : modelSelect.value;
  if (!selectedModel) {
    updateModeConnection();
    setComposerError(imageMode ? "مدل تصویر انتخاب نشده است." : "مدل گفتگو انتخاب نشده است.");
    return;
  }
  if (!text && !pendingFiles.length) return;

  let conversation = selectedConversation();
  if (!conversation) conversation = createConversation();
  const attachments = [...pendingFiles];
  pendingFiles = [];
  renderPendingFiles();

  const userMessage = { role: "user", content: text, attachments };
  conversation.messages.push(userMessage);
  if (conversation.messages.filter((message) => message.role === "user").length === 1) {
    conversation.title = (text || attachments[0]?.name || "گفتگوی تازه").slice(0, 34);
    if ((text || "").length > 34) conversation.title += "…";
  }
  welcomeEl.hidden = true;
  messagesEl.classList.add("visible");
  renderMessage(userMessage);
  const assistantBody = renderMessage({ role: "assistant", content: "" });
  assistantBody.innerHTML = '<span class="typing"><span>●</span> <span>●</span> <span>●</span></span>';
  messagesEl.scrollTop = messagesEl.scrollHeight;
  await persistConversations();
  renderConversations();

  abortController = new AbortController();
  setBusy(true);
  try {
    if (imageMode) {
      const data = await requestImage(text, selectedModel);
      assistantBody.replaceChildren();
      const image = document.createElement("img");
      image.className = "generated-image";
      image.src = data.imageUrl;
      image.alt = text;
      assistantBody.append(image);
      const caption = document.createElement("p");
      caption.textContent = text;
      assistantBody.append(caption);
      conversation.messages.push({
        role: "assistant",
        type: "image",
        model: selectedModel,
        imageUrl: data.imageUrl,
        content: text,
      });
      await persistConversations();
      await learnMemory(text, text, selectedModel);
      return;
    }

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        conversationId: conversation.id,
        messages: conversation.messages.map(({ role, content, attachments: files, type, imageUrl, model }) => ({
          role,
          content,
          attachments: files,
          type,
          imageUrl,
          model,
        })),
      }),
      signal: abortController.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "درخواست ناموفق بود.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(chunk.error);
        answer += chunk.message?.content || "";
        updateAssistantBody(assistantBody, answer || " ");
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const chunk = JSON.parse(buffer);
      if (chunk.error) throw new Error(chunk.error);
      answer += chunk.message?.content || "";
    }
    updateAssistantBody(assistantBody, answer || "پاسخی دریافت نشد.");
    conversation.messages.push({ role: "assistant", model: selectedModel, content: answer });
    await persistConversations();

    const imagePrompt = extractImagePrompt(answer);
    if (imagePrompt && imageModelSelect.value) {
      const imageNote = document.createElement("p");
      imageNote.textContent = "در حال ساخت تصویر...";
      assistantBody.append(imageNote);
      try {
        const data = await requestImage(imagePrompt, imageModelSelect.value);
        imageNote.remove();
        const image = document.createElement("img");
        image.className = "generated-image";
        image.src = data.imageUrl;
        image.alt = imagePrompt;
        assistantBody.append(image);
        conversation.messages.push({
          role: "assistant",
          type: "image",
          model: imageModelSelect.value,
          imageUrl: data.imageUrl,
          content: imagePrompt,
        });
        await persistConversations();
      } catch (error) {
        imageNote.textContent = `ساخت تصویر انجام نشد: ${error.message}`;
        imageNote.classList.add("error-message");
      }
    }

    await learnMemory(text, stripImageTag(answer), selectedModel);
  } catch (error) {
    if (error.name === "AbortError") {
      const partial = stripImageTag(assistantBody.textContent === "● ● ●" ? "" : assistantBody.textContent);
      if (partial.trim()) {
        conversation.messages.push({ role: "assistant", content: partial });
        await persistConversations();
      } else {
        assistantBody.closest(".message")?.remove();
      }
    } else {
      updateAssistantBody(assistantBody, `خطا: ${error.message}`, true);
      setComposerError(error.message);
      console.error(error);
    }
  } finally {
    abortController = null;
    setBusy(false);
    input.focus();
    renderConversations();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function closeMobileSidebar() {
  sidebar.classList.remove("open");
  mobileBackdrop.classList.remove("visible");
}

function setChoiceRow(row, value) {
  row.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.value === value ? "true" : "false");
  });
}

function openApiModal() {
  draftProviders = {
    chatProvider: settings.chatProvider,
    imageProvider: settings.imageProvider,
  };
  setChoiceRow(document.querySelector("#chatProviderChoices"), draftProviders.chatProvider);
  setChoiceRow(document.querySelector("#imageProviderChoices"), draftProviders.imageProvider);
  document.querySelector("#apiBaseUrl").value = settings.apiBaseUrl || "";
  document.querySelector("#apiKey").value = "";
  document.querySelector("#apiKey").placeholder = settings.hasApiKey
    ? `کلید ذخیره شده ${settings.apiKeyHint}`
    : "اگر سرویس محلی کلید نمی‌خواهد، خالی بگذارید";
  document.querySelector("#apiChatModelInput").value = settings.apiChatModel || "";
  document.querySelector("#apiImageModelInput").value = settings.apiImageModel || "";
  document.querySelector("#memoryEnabled").checked = settings.memoryEnabled !== false;
  document.querySelector("#apiChatModelPick").replaceChildren();
  document.querySelector("#apiImageModelPick").replaceChildren();
  apiNote.textContent = "";
  apiModal.hidden = false;
}

function closeApiModal() {
  apiModal.hidden = true;
}

function fillProbeSelects(models) {
  const chatPick = document.querySelector("#apiChatModelPick");
  const imagePick = document.querySelector("#apiImageModelPick");
  const chatModels = models.filter((model) => !model.image).map((model) => model.id);
  const imageModels = models.filter((model) => model.image).map((model) => model.id);
  fillSelect(chatPick, chatModels, document.querySelector("#apiChatModelInput").value);
  fillSelect(imagePick, imageModels, document.querySelector("#apiImageModelInput").value);
  chatPick.onchange = () => {
    if (chatPick.value) document.querySelector("#apiChatModelInput").value = chatPick.value;
  };
  imagePick.onchange = () => {
    if (imagePick.value) document.querySelector("#apiImageModelInput").value = imagePick.value;
  };
}

async function probeApi() {
  apiNote.textContent = "در حال بررسی...";
  const response = await fetch("/api/settings/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: document.querySelector("#apiBaseUrl").value.trim(),
      apiKey: document.querySelector("#apiKey").value.trim(),
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    apiNote.textContent = data.error || "بررسی ناموفق بود.";
    return;
  }
  fillProbeSelects(data.models || []);
  apiNote.textContent = `${(data.models || []).length} مدل پیدا شد.`;
}

async function saveApiSettings(clearKey = false) {
  apiNote.textContent = "در حال ذخیره...";
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatProvider: draftProviders.chatProvider,
      imageProvider: draftProviders.imageProvider,
      apiBaseUrl: document.querySelector("#apiBaseUrl").value.trim(),
      apiKey: document.querySelector("#apiKey").value.trim(),
      clearApiKey: clearKey,
      apiChatModel: document.querySelector("#apiChatModelInput").value.trim(),
      apiImageModel: document.querySelector("#apiImageModelInput").value.trim(),
      localChatModel: modelSelect.value,
      localImageModel: imageModelSelect.value,
      memoryEnabled: document.querySelector("#memoryEnabled").checked,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    apiNote.textContent = data.error || "ذخیره ناموفق بود.";
    return;
  }
  applyBootstrap(data);
  apiNote.textContent = "ذخیره شد.";
  setTimeout(closeApiModal, 400);
}

async function openMemoryModal() {
  memoryModal.hidden = false;
  const list = document.querySelector("#memoryList");
  list.textContent = "در حال بارگذاری...";
  const response = await fetch("/api/memory");
  const data = await response.json();
  if (!response.ok) {
    list.textContent = data.error || "حافظه خوانده نشد.";
    return;
  }
  list.replaceChildren();
  const facts = data.facts || [];
  if (!facts.length) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    empty.textContent = "هنوز یادداشت پایداری ذخیره نشده است.";
    list.append(empty);
  }
  for (const fact of facts.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "memory-item";
    const text = document.createElement("p");
    text.textContent = fact.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "حذف یادداشت");
    remove.addEventListener("click", async () => {
      await fetch(`/api/memory/${fact.id}`, { method: "DELETE" });
      openMemoryModal();
    });
    row.append(text, remove);
    list.append(row);
  }
}

function closeMemoryModal() {
  memoryModal.hidden = true;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (abortController) {
    abortController.abort();
    return;
  }
  const text = input.value.trim();
  if (!text && !pendingFiles.length) return;
  input.value = "";
  input.style.height = "auto";
  sendMessage(text);
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelector("#attachButton").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  setComposerError("");
  for (const file of [...fileInput.files]) {
    try {
      if (pendingFiles.length >= 4) throw new Error("حداکثر ۴ پیوست در هر پیام.");
      const uploaded = await uploadFile(file);
      pendingFiles.push(uploaded);
      renderPendingFiles();
    } catch (error) {
      setComposerError(error.message);
    }
  }
  fileInput.value = "";
});

modelSelect.addEventListener("change", updateModelLabel);
imageModelSelect.addEventListener("change", updateModelLabel);
modeSelect.addEventListener("change", updateModeUi);
searchInput.addEventListener("input", renderConversations);
document.querySelector("#newChat").addEventListener("click", startNewChat);
document.querySelector("#openSidebar").addEventListener("click", () => {
  sidebar.classList.add("open");
  mobileBackdrop.classList.add("visible");
});
document.querySelector("#closeSidebar").addEventListener("click", closeMobileSidebar);
mobileBackdrop.addEventListener("click", closeMobileSidebar);
document.querySelector("#openApi").addEventListener("click", openApiModal);
document.querySelector("#closeApi").addEventListener("click", closeApiModal);
document.querySelector("#probeApi").addEventListener("click", () => {
  probeApi().catch((error) => {
    apiNote.textContent = error.message;
  });
});
document.querySelector("#saveApi").addEventListener("click", () => {
  saveApiSettings(false).catch((error) => {
    apiNote.textContent = error.message;
  });
});
document.querySelector("#clearApiKey").addEventListener("click", () => {
  saveApiSettings(true).catch((error) => {
    apiNote.textContent = error.message;
  });
});
document.querySelector("#openMemory").addEventListener("click", () => {
  openMemoryModal().catch((error) => {
    document.querySelector("#memoryList").textContent = error.message;
  });
});
document.querySelector("#closeMemory").addEventListener("click", closeMemoryModal);
document.querySelector("#clearMemory").addEventListener("click", async () => {
  await fetch("/api/memory", { method: "DELETE" });
  openMemoryModal();
});
document.querySelector("#chatProviderChoices").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-value]");
  if (!button) return;
  draftProviders.chatProvider = button.dataset.value;
  setChoiceRow(event.currentTarget, draftProviders.chatProvider);
});
document.querySelector("#imageProviderChoices").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-value]");
  if (!button) return;
  draftProviders.imageProvider = button.dataset.value;
  setChoiceRow(event.currentTarget, draftProviders.imageProvider);
});
document.querySelectorAll(".suggestion-card").forEach((card) => {
  card.addEventListener("click", () => {
    input.value = card.dataset.prompt;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
  if (event.key === "Escape") {
    closeMobileSidebar();
    closeApiModal();
    closeMemoryModal();
  }
});

(async function boot() {
  try {
    await loadBootstrap();
  } catch (error) {
    setConnection(false, error.message);
    setComposerError(error.message);
  }
  await loadConversations();
  renderChat();
  updateModeUi();
})();
