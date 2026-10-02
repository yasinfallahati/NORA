const { randomInt } = require("node:crypto");

function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl.replace(/\/+$/, "")}/`);
}

function authHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function looksLikeImageModel(id) {
  return /(dall-e|gpt-image|grok-.*image|imagen|flux|stable-diffusion|sdxl|sd3|recraft|playground-v|kolors|image-gen)/i.test(id);
}

async function readError(response) {
  const text = await response.text();
  return text.replace(/\s+/g, " ").slice(0, 280) || `پاسخ ${response.status}`;
}

async function listOllamaModels(ollamaUrl, signal) {
  const response = await fetch(`${ollamaUrl}/api/tags`, { signal });
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  return (data.models || []).map((model) => model.name).filter(Boolean);
}

async function listComfyModels(comfyUrl, signal) {
  const response = await fetch(`${comfyUrl}/object_info/CheckpointLoaderSimple`, { signal });
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  const choices = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(choices)) throw new Error("فهرست مدل‌های تصویر از ComfyUI خوانده نشد.");
  return choices;
}

async function listApiModels(baseUrl, apiKey, signal) {
  const response = await fetch(endpoint(baseUrl, "models"), { headers: authHeaders(apiKey), signal });
  if (response.status === 401 || response.status === 403) throw new Error("کلید API پذیرفته نشد.");
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  const listed = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return listed.map((model) => model.id || model.name).filter((id) => typeof id === "string" && id.trim());
}

async function buildChatMessages(rawMessages, systemText) {
  const history = Array.isArray(rawMessages) ? rawMessages : [];
  let lastUser = -1;
  history.forEach((message, index) => {
    if (message?.role === "user") lastUser = index;
  });

  const ollama = [{ role: "system", content: systemText }];
  const openai = [{ role: "system", content: systemText }];

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    if (message.role === "assistant") {
      const text = message.type === "image"
        ? `یک تصویر ساخته شد: ${message.content || ""}`.trim()
        : message.content || "";
      ollama.push({ role: "assistant", content: text });
      openai.push({ role: "assistant", content: text });
      continue;
    }

    const notes = [];
    const images = [];
    const recent = index === lastUser;
    for (const file of message.attachments || []) {
      if (file.kind === "image") {
        if (recent && file.base64) images.push({ data: file.base64, mime: file.mime || "image/png" });
        notes.push(`تصویر پیوست شد: ${file.name || "image"}`);
      } else if (file.text && recent) {
        notes.push(`محتوای فایل «${file.name}»:\n${file.text.slice(0, 12000)}`);
      } else {
        notes.push(`فایل پیوست شد: ${file.name || "file"}${file.kind === "file" ? " (متن PDF استخراج نشده است)" : ""}`);
      }
    }
    const content = [message.content || "", ...notes].filter(Boolean).join("\n\n") || "پیوست را ببین.";
    const ollamaMessage = { role: "user", content };
    if (images.length) ollamaMessage.images = images.map((image) => image.data);
    ollama.push(ollamaMessage);
    openai.push(images.length ? {
      role: "user",
      content: [
        { type: "text", text: content },
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mime};base64,${image.data}` },
        })),
      ],
    } : { role: "user", content });
  }

  return { ollama, openai };
}

async function streamOllama({ ollamaUrl, model, messages, signal, onOpen, onToken }) {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  onOpen();
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const token = JSON.parse(line).message?.content || "";
        if (token) onToken(token);
      } catch {
        continue;
      }
    }
  }
  if (buffer.trim()) {
    try {
      const token = JSON.parse(buffer).message?.content || "";
      if (token) onToken(token);
    } catch {
      /* خط نهایی ناقص نادیده گرفته می‌شود. */
    }
  }
}

async function streamOpenAi({ baseUrl, apiKey, model, messages, signal, onOpen, onToken }) {
  const response = await fetch(endpoint(baseUrl, "chat/completions"), {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (response.status === 401 || response.status === 403) throw new Error("کلید API پذیرفته نشد.");
  if (!response.ok) throw new Error(await readError(response));
  onOpen();
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    if (text) onToken(text);
    return;
  }
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const token = JSON.parse(data).choices?.[0]?.delta?.content || "";
        if (token) onToken(token);
      } catch {
        continue;
      }
    }
  }
}

async function completeText({ provider, model, messages, signal, ollamaUrl, baseUrl, apiKey }) {
  if (provider === "api") {
    const response = await fetch(endpoint(baseUrl, "chat/completions"), {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model, messages, stream: false, max_tokens: 300 }),
      signal,
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, options: { num_predict: 300 } }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  return data.message?.content || "";
}

function imageWorkflow(model, prompt) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "low quality, blurry, distorted, deformed, extra fingers, bad anatomy", clip: ["1", 1] },
    },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
        seed: randomInt(0, 2 ** 32),
        steps: 20,
        cfg: 7,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "nora" } },
  };
}

async function generateLocalImage({ comfyUrl, model, prompt, signal }) {
  const models = await listComfyModels(comfyUrl, signal);
  if (!models.includes(model)) throw new Error("این مدل در ComfyUI موجود نیست. فهرست مدل‌ها را تازه کنید.");
  const queued = await fetch(`${comfyUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: imageWorkflow(model, prompt) }),
    signal,
  });
  if (!queued.ok) throw new Error(await readError(queued));
  const { prompt_id: promptId } = await queued.json();
  if (typeof promptId !== "string" || !promptId) throw new Error("ComfyUI شناسهٔ درخواست معتبری برنگرداند.");

  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (signal.aborted) throw new DOMException("درخواست لغو شد.", "AbortError");
    const historyResponse = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal });
    if (!historyResponse.ok) throw new Error(await readError(historyResponse));
    const result = (await historyResponse.json())[promptId];
    if (result?.status?.status_str === "error") throw new Error("ComfyUI هنگام تولید تصویر با خطا روبه‌رو شد.");
    const images = Object.values(result?.outputs || {}).flatMap((output) => output.images || []);
    if (images.length) {
      const image = images[0];
      const view = new URL(`${comfyUrl}/view`);
      view.searchParams.set("filename", image.filename);
      view.searchParams.set("subfolder", image.subfolder || "");
      view.searchParams.set("type", image.type || "output");
      const file = await fetch(view, { signal });
      if (!file.ok) throw new Error("فایل تصویر در ComfyUI پیدا نشد.");
      return Buffer.from(await file.arrayBuffer());
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("زمان انتظار برای تولید تصویر تمام شد.");
}

async function imageBytesFromApi(data, signal) {
  const item = data.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (typeof item?.url === "string" && /^https?:\/\//i.test(item.url)) {
    const image = await fetch(item.url, { signal });
    if (!image.ok) throw new Error("دانلود تصویر از API ناموفق بود.");
    return Buffer.from(await image.arrayBuffer());
  }
  throw new Error("پاسخ تصویر از API قابل خواندن نیست.");
}

async function generateApiImage({ baseUrl, apiKey, model, prompt, signal }) {
  const url = endpoint(baseUrl, "images/generations");
  const headers = authHeaders(apiKey);
  let response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024", response_format: "b64_json" }),
    signal,
  });
  if (response.status === 401 || response.status === 403) throw new Error("کلید API پذیرفته نشد.");
  if (response.status === 404) throw new Error("این API مسیر تولید تصویر ندارد.");
  if (response.status === 400) {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt, n: 1 }),
      signal,
    });
  }
  if (!response.ok) throw new Error(await readError(response));
  return imageBytesFromApi(await response.json(), signal);
}

module.exports = {
  buildChatMessages,
  completeText,
  generateApiImage,
  generateLocalImage,
  listApiModels,
  listComfyModels,
  listOllamaModels,
  looksLikeImageModel,
  streamOllama,
  streamOpenAi,
};
