const storageKey = "chatkhane-conversations-v1";
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
let conversations = loadConversations();
let activeConversationId = null;
let abortController = null;
const backendStatus = { chat: false, image: false };

function loadConversations() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveConversations() {
  localStorage.setItem(storageKey, JSON.stringify(conversations));
}

function selectedConversation() {
  return conversations.find((conversation) => conversation.id === activeConversationId);
}

function setConnection(connected, text) {
  connectionState.classList.toggle("offline", !connected);
  connectionText.textContent = text;
}

async function loadModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "اتصال برقرار نشد");

    modelSelect.replaceChildren();
    for (const model of data.models) {
      const option = document.createElement("option");
      option.value = model.name;
      option.textContent = model.name;
      modelSelect.append(option);
    }
    if (data.models.length) {
      const preferred = data.models.find((model) => model.name === "qwen2.5:7b");
      modelSelect.value = preferred ? preferred.name : data.models[0].name;
      backendStatus.chat = true;
    } else {
      const option = document.createElement("option");
      option.textContent = "مدلی پیدا نشد";
      option.value = "";
      modelSelect.append(option);
      backendStatus.chat = false;
    }
    updateModelLabel();
    updateModeConnection();
  } catch (error) {
    backendStatus.chat = false;
    modelSelect.replaceChildren();
    const option = document.createElement("option");
    option.textContent = "Ollama در دسترس نیست";
    option.value = "";
    modelSelect.append(option);
    updateModelLabel();
    updateModeConnection();
    console.error(error);
  }
}

async function loadImageModels() {
  try {
    const response = await fetch("/api/image-models");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "اتصال به ComfyUI برقرار نشد");
    imageModelSelect.replaceChildren();
    for (const model of data.models) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      imageModelSelect.append(option);
    }
    if (!data.models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "مدلی در ComfyUI نیست";
      imageModelSelect.append(option);
    }
    backendStatus.image = data.models.length > 0;
    updateModelLabel();
    updateModeConnection();
  } catch (error) {
    backendStatus.image = false;
    imageModelSelect.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "ComfyUI در دسترس نیست";
    imageModelSelect.append(option);
    updateModelLabel();
    updateModeConnection();
    console.error(error);
  }
}

function updateModeConnection() {
  const imageMode = modeSelect.value === "image";
  const connected = imageMode ? backendStatus.image : backendStatus.chat;
  const text = imageMode
    ? connected ? "متصل به ComfyUI" : "ComfyUI در دسترس نیست"
    : connected ? "متصل به Ollama" : "اتصال به Ollama برقرار نیست";
  setConnection(connected, text);
}

function updateModelLabel() {
  const selectedModel = modeSelect.value === "image" ? imageModelSelect.value : modelSelect.value;
  modelLabel.textContent = selectedModel || (modeSelect.value === "image" ? "مدل تصویر" : "مدل محلی");
}

function renderConversations() {
  conversationList.replaceChildren();
  if (conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-history";
    empty.textContent = "گفتگوهای شما اینجا نمایش داده می‌شوند.";
    conversationList.append(empty);
    return;
  }

  for (const conversation of [...conversations].reverse()) {
    const row = document.createElement("div");
    row.className = `conversation-item${conversation.id === activeConversationId ? " active" : ""}`;
    const open = document.createElement("button");
    open.className = "conversation-item";
    open.type = "button";
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
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      conversations = conversations.filter((item) => item.id !== conversation.id);
      if (activeConversationId === conversation.id) startNewChat();
      saveConversations();
      renderConversations();
    });

    row.append(open, remove);
    conversationList.append(row);
  }
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
    meta.textContent = message.model || (
      modeSelect.value === "image" ? imageModelSelect.value : modelSelect.value
    ) || "دستیار محلی";
    content.append(meta);
  }
  const body = document.createElement("div");
  body.className = "message-body";
  if (message.role === "assistant" && message.type === "image") {
    const image = document.createElement("img");
    image.className = "generated-image";
    image.src = message.imageUrl;
    image.alt = "تصویر تولیدشده";
    body.append(image);
    if (message.content) {
      const caption = document.createElement("p");
      caption.textContent = message.content;
      body.append(caption);
    }
  } else if (message.role === "assistant") {
    body.innerHTML = formatMessage(message.content);
  } else {
    body.textContent = message.content;
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

function updateModeUi() {
  const imageMode = modeSelect.value === "image";
  modelSelect.hidden = imageMode;
  imageModelSelect.hidden = !imageMode;
  input.placeholder = imageMode ? "تصویر دلخواهتان را توصیف کنید..." : "هر چیزی که در ذهن دارید بپرسید...";
  input.setAttribute("aria-label", imageMode ? "توضیح تصویر" : "پیام شما");
  document.querySelector("#welcomeTitle").innerHTML = imageMode
    ? "چه تصویری در ذهن دارید<span class=\"heading-dot\">؟</span>"
    : "از کجا شروع کنیم<span class=\"heading-dot\">؟</span>";
  document.querySelector("#welcomeCopy").textContent = imageMode
    ? "توضیح تصویر را بنویسید تا با مدل محلی برایتان ساخته شود."
    : "یک سؤال بپرسید، ایده‌ای را دنبال کنید یا فقط گپ بزنید. من اینجا هستم تا کمک کنم.";
  document.querySelector("#suggestionGrid").hidden = imageMode;
  const description = document.querySelector("#composerDescription");
  description.firstChild.textContent = imageMode ? "تصویر با " : "پاسخ‌ها با ";
  description.lastChild.textContent = imageMode ? " ساخته می‌شود" : " ساخته می‌شوند";
  updateModelLabel();
  updateModeConnection();
}

function openConversation(id) {
  if (abortController) abortController.abort();
  activeConversationId = id;
  renderChat();
  closeMobileSidebar();
}

function startNewChat() {
  if (abortController) abortController.abort();
  activeConversationId = null;
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

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
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

function updateAssistantBody(body, text, error = false) {
  body.innerHTML = formatMessage(text);
  if (error) body.classList.add("error-message");
}

async function sendMessage(text) {
  const imageMode = modeSelect.value === "image";
  const selectedModel = imageMode ? imageModelSelect.value : modelSelect.value;
  if (!selectedModel) {
    updateModeConnection();
    return;
  }
  let conversation = selectedConversation();
  if (!conversation) conversation = createConversation();
  conversation.messages.push({ role: "user", content: text });
  if (conversation.messages.length === 1) {
    conversation.title = text.length > 34 ? `${text.slice(0, 34)}…` : text;
  }
  welcomeEl.hidden = true;
  messagesEl.classList.add("visible");
  renderMessage(conversation.messages.at(-1));
  const assistantBody = renderMessage({ role: "assistant", content: "" });
  assistantBody.innerHTML = '<span class="typing"><span>●</span> <span>●</span> <span>●</span></span>';
  messagesEl.scrollTop = messagesEl.scrollHeight;
  saveConversations();
  renderConversations();

  abortController = new AbortController();
  sendButton.classList.add("is-generating");
  sendButton.setAttribute("aria-label", "توقف");
  sendButton.title = "توقف";
  input.disabled = true;
  modelSelect.disabled = true;
  imageModelSelect.disabled = true;
  modeSelect.disabled = true;
  try {
    const response = await fetch(imageMode ? "/api/image" : "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(imageMode ? {
        model: selectedModel,
        prompt: text,
      } : {
        model: selectedModel,
        messages: conversation.messages,
      }),
      signal: abortController.signal,
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "درخواست ناموفق بود.");
    }

    if (imageMode) {
      const data = await response.json();
      if (typeof data.imageUrl !== "string" || !data.imageUrl.startsWith("/api/image-file?")) {
        throw new Error("پاسخ تصویر از سرور معتبر نیست.");
      }
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
      saveConversations();
      return;
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
        answer += chunk.message?.content || "";
        updateAssistantBody(assistantBody, answer || " ");
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const chunk = JSON.parse(buffer);
      answer += chunk.message?.content || "";
    }
    updateAssistantBody(assistantBody, answer || "پاسخی دریافت نشد.");
    conversation.messages.push({ role: "assistant", model: selectedModel, content: answer });
    saveConversations();
  } catch (error) {
    if (error.name === "AbortError") {
      const partial = assistantBody.textContent === "● ● ●" ? "" : assistantBody.textContent;
      if (partial.trim()) {
        conversation.messages.push({ role: "assistant", content: partial });
        saveConversations();
      } else {
        assistantBody.closest(".message").remove();
      }
    } else {
      updateAssistantBody(assistantBody, `خطا: ${error.message}`, true);
      console.error(error);
    }
  } finally {
    abortController = null;
    sendButton.classList.remove("is-generating");
    sendButton.setAttribute("aria-label", "ارسال پیام");
    sendButton.title = "ارسال پیام";
    input.disabled = false;
    modelSelect.disabled = false;
    imageModelSelect.disabled = false;
    modeSelect.disabled = false;
    input.focus();
    renderConversations();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function closeMobileSidebar() {
  sidebar.classList.remove("open");
  mobileBackdrop.classList.remove("visible");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (abortController) {
    abortController.abort();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
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
modelSelect.addEventListener("change", updateModelLabel);
imageModelSelect.addEventListener("change", updateModelLabel);
modeSelect.addEventListener("change", updateModeUi);
document.querySelector("#newChat").addEventListener("click", startNewChat);
document.querySelector("#openSidebar").addEventListener("click", () => {
  sidebar.classList.add("open");
  mobileBackdrop.classList.add("visible");
});
document.querySelector("#closeSidebar").addEventListener("click", closeMobileSidebar);
mobileBackdrop.addEventListener("click", closeMobileSidebar);
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
  if (event.key === "Escape") closeMobileSidebar();
});

renderChat();
updateModeUi();
loadModels();
loadImageModels();
