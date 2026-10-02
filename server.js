const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./lib/store");
const upstream = require("./lib/upstream");

const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const comfyUrl = (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const publicDir = path.join(__dirname, "public");
const identity = "شما دستیار فارسی‌زبان و کمک‌کننده‌ای به نام Nora هستید. اگر کاربر بپرسد 'تو کی هستی؟'، 'اسمت چیست؟'، 'چه کسی تو را ساخته است؟' یا جملات مشابه، دقیقاً به فارسی این جمله را بگو: 'من Nora هستم و توسط یاسین ساخته شدم.' در غیر این صورت به‌صورت طبیعی و مفید پاسخ بده. فایل‌ها و تصویرهای پیوست‌شدهٔ همین پیام را در نظر بگیر.";
const imageInstruction = "اگر کاربر خواست عکس یا تصویر ساخته شود، پاسخ کوتاه بده و دقیقاً یک خط جدا با این قالب اضافه کن:\n[[image: a detailed prompt in English]]\nاگر تصویر نخواست، این قالب را به کار نبر.";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(response, status, data) {
  if (response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("درخواست بیش از حد بزرگ است."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request, response, limit) {
  try {
    const raw = await readBody(request, limit);
    if (!raw.length) return {};
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.status === 413 ? error.message : "درخواست نامعتبر است." });
    return null;
  }
}

function beginClose(request, response) {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  request.on("aborted", () => controller.abort());
  return controller;
}

async function attachFiles(messages) {
  const clean = store.cleanMessages(messages);
  let lastUser = -1;
  clean.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  return clean.map((message, index) => {
    if (message.role !== "user") return message;
    const recent = index === lastUser;
    return {
      ...message,
      attachments: message.attachments.map((file) => {
        const stored = store.readUpload(file.id);
        if (!stored) return file;
        return {
          ...file,
          name: stored.name,
          mime: stored.mime,
          kind: stored.kind,
          text: recent ? stored.text || "" : "",
          base64: recent && stored.kind === "image" ? stored.base64 : "",
        };
      }),
    };
  });
}

function systemText(query, conversationId, enabled) {
  const memory = enabled ? store.recall(query, conversationId) : "";
  return [identity, imageInstruction, memory].filter(Boolean).join("\n\n");
}

function latestUserText(messages) {
  const user = [...messages].reverse().find((message) => message.role === "user");
  return user?.content || "";
}

async function catalog() {
  const settings = store.readSettings();
  const result = {
    settings: store.publicSettings(settings),
    memory: store.publicMemory().counts,
    chatModels: [],
    imageModels: [],
    chatOk: false,
    imageOk: false,
    chatError: "",
    imageError: "",
  };
  const chatTask = (async () => {
    if (settings.chatProvider === "api") {
      if (!settings.apiBaseUrl) throw new Error("آدرس API ذخیره نشده است.");
      result.chatModels = await upstream.listApiModels(settings.apiBaseUrl, settings.apiKey, AbortSignal.timeout(12000));
    } else {
      result.chatModels = await upstream.listOllamaModels(ollamaUrl, AbortSignal.timeout(5000));
    }
    result.chatOk = result.chatModels.length > 0;
    if (!result.chatOk) result.chatError = "مدلی پیدا نشد.";
  })();
  const imageTask = (async () => {
    if (settings.imageProvider === "api") {
      if (!settings.apiBaseUrl) throw new Error("آدرس API ذخیره نشده است.");
      const models = await upstream.listApiModels(settings.apiBaseUrl, settings.apiKey, AbortSignal.timeout(12000));
      result.imageModels = models.filter(upstream.looksLikeImageModel);
      if (settings.apiImageModel && !result.imageModels.includes(settings.apiImageModel)) {
        result.imageModels.unshift(settings.apiImageModel);
      }
      result.imageOk = result.imageModels.length > 0;
      if (!result.imageOk) result.imageError = "مدل تصویری در این API پیدا نشد.";
    } else {
      result.imageModels = await upstream.listComfyModels(comfyUrl, AbortSignal.timeout(5000));
      result.imageOk = result.imageModels.length > 0;
      if (!result.imageOk) result.imageError = "مدلی در ComfyUI پیدا نشد.";
    }
  })();
  const settled = await Promise.allSettled([chatTask, imageTask]);
  if (settled[0].status === "rejected") {
    result.chatError = settled[0].reason?.message || "اتصال گفتگو برقرار نشد.";
  }
  if (settled[1].status === "rejected") {
    result.imageError = settled[1].reason?.message || "اتصال تصویر برقرار نشد.";
  }
  return result;
}

function parseFacts(text) {
  const match = String(text || "").match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

async function learnTurn(body) {
  const settings = store.readSettings();
  const user = typeof body.user === "string" ? body.user.trim().slice(0, 4000) : "";
  const assistant = typeof body.assistant === "string" ? body.assistant.trim().slice(0, 4000) : "";
  if (!user && !assistant) return store.publicMemory();
  if (settings.memoryEnabled === false) return store.publicMemory();

  if (user) {
    await store.addMemoryEntry({
      journal: { conversationId: body.conversationId, role: "user", text: user },
    });
    for (const fact of store.explicitFacts(user)) {
      await store.addMemoryEntry({ fact });
    }
  }
  if (assistant) {
    await store.addMemoryEntry({
      journal: { conversationId: body.conversationId, role: "assistant", text: assistant },
    });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && user) {
    try {
      const answer = await upstream.completeText({
        provider: settings.chatProvider,
        model,
        ollamaUrl,
        baseUrl: settings.apiBaseUrl,
        apiKey: settings.apiKey,
        signal: AbortSignal.timeout(20000),
        messages: [
          {
            role: "system",
            content: "فقط یک آرایهٔ JSON از رشته‌های کوتاه فارسی برگردان. فقط حقایقی را بنویس که کاربر صریحاً گفته و بعداً مفید است، مثل نام، سلیقه، کار، یا تصمیم. اگر چیزی نیست [] برگردان. توضیح اضافه ننویس.",
          },
          { role: "user", content: `کاربر: ${user}\nدستیار: ${assistant || "—"}` },
        ],
      });
      for (const fact of parseFacts(answer)) await store.addMemoryEntry({ fact });
    } catch (error) {
      console.error(`یادگیری حافظه انجام نشد: ${error.message}`);
    }
  }
  return store.publicMemory();
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, await catalog());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, store.publicSettings(store.readSettings()));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const patch = await readJson(request, response, 100_000);
      if (!patch) return;
      await store.writeSettings(patch);
      sendJson(response, 200, await catalog());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/probe") {
      const body = await readJson(request, response, 100_000);
      if (!body) return;
      const settings = store.readSettings();
      const baseUrl = typeof body.apiBaseUrl === "string" && body.apiBaseUrl.trim()
        ? body.apiBaseUrl.trim().replace(/\/+$/, "")
        : settings.apiBaseUrl;
      const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : settings.apiKey;
      if (!baseUrl) {
        sendJson(response, 400, { error: "آدرس API را وارد کنید." });
        return;
      }
      let normalized = baseUrl;
      try {
        normalized = new URL(baseUrl).toString().replace(/\/+$/, "");
        if (new URL(baseUrl).protocol !== "http:" && new URL(baseUrl).protocol !== "https:") throw new Error("bad");
      } catch {
        sendJson(response, 400, { error: "آدرس API معتبر نیست." });
        return;
      }
      const models = await upstream.listApiModels(normalized, apiKey, AbortSignal.timeout(12000));
      sendJson(response, 200, {
        models: models.map((id) => ({ id, image: upstream.looksLikeImageModel(id) })),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/conversations") {
      sendJson(response, 200, { conversations: store.readConversations() });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/conversations") {
      const body = await readJson(request, response, 8 * 1024 * 1024);
      if (!body) return;
      const conversations = await store.writeConversations(body.conversations);
      sendJson(response, 200, { conversations });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/memory") {
      sendJson(response, 200, store.publicMemory());
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/memory") {
      await store.clearMemory();
      sendJson(response, 200, store.publicMemory());
      return;
    }

    const memoryMatch = url.pathname.match(/^\/api\/memory\/([0-9a-f-]{36})$/i);
    if (request.method === "DELETE" && memoryMatch) {
      await store.deleteMemoryEntry(memoryMatch[1]);
      sendJson(response, 200, store.publicMemory());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/memory/learn") {
      const body = await readJson(request, response, 200_000);
      if (!body) return;
      sendJson(response, 200, await learnTurn(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/uploads") {
      const body = await readJson(request, response, 12 * 1024 * 1024);
      if (!body) return;
      const saved = store.saveUpload({
        name: body.name,
        mime: body.mime,
        dataBase64: body.data,
      });
      sendJson(response, 200, saved);
      return;
    }

    const uploadMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && uploadMatch) {
      const file = store.readUpload(uploadMatch[1]);
      if (!file) {
        sendJson(response, 404, { error: "فایل پیدا نشد." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": file.mime || "application/octet-stream",
        "Content-Length": file.buffer.length,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(file.buffer);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/models") {
      try {
        sendJson(response, 200, { models: (await upstream.listOllamaModels(ollamaUrl)).map((name) => ({ name })) });
      } catch (error) {
        sendJson(response, 502, { error: `اتصال به Ollama برقرار نشد: ${error.message}` });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/image-models") {
      try {
        sendJson(response, 200, { models: await upstream.listComfyModels(comfyUrl) });
      } catch (error) {
        sendJson(response, 502, { error: `اتصال به ComfyUI برقرار نشد: ${error.message}` });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/image") {
      const imageRequest = await readJson(request, response, 100_000);
      if (!imageRequest) return;
      const prompt = typeof imageRequest.prompt === "string" ? imageRequest.prompt.trim() : "";
      const model = typeof imageRequest.model === "string" ? imageRequest.model.trim() : "";
      if (!prompt || prompt.length > 4000 || !model) {
        sendJson(response, 400, { error: "مدل یا توضیح تصویر معتبر نیست." });
        return;
      }
      const settings = store.readSettings();
      if (settings.imageProvider === "api" && !settings.apiBaseUrl) {
        sendJson(response, 400, { error: "برای ساخت تصویر با API، ابتدا آدرس را ذخیره کنید." });
        return;
      }
      const controller = beginClose(request, response);
      const bytes = settings.imageProvider === "api"
        ? await upstream.generateApiImage({
          baseUrl: settings.apiBaseUrl,
          apiKey: settings.apiKey,
          model,
          prompt,
          signal: controller.signal,
        })
        : await upstream.generateLocalImage({ comfyUrl, model, prompt, signal: controller.signal });
      const [name, mime] = bytes[0] === 0xff && bytes[1] === 0xd8
        ? ["nora.jpg", "image/jpeg"]
        : bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF"
          ? ["nora.webp", "image/webp"]
          : ["nora.png", "image/png"];
      const saved = store.saveUpload({ name, mime, buffer: bytes });
      sendJson(response, 200, { imageUrl: `/api/uploads/${saved.id}`, model });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/image-file") {
      const filename = url.searchParams.get("filename") || "";
      const subfolder = url.searchParams.get("subfolder") || "";
      const type = url.searchParams.get("type") || "output";
      if (
        !/^[\w .-]+\.png$/i.test(filename)
        || (subfolder && !/^(?:[\w-]+\/)*[\w-]+$/.test(subfolder))
        || type !== "output"
      ) {
        sendJson(response, 400, { error: "مسیر تصویر معتبر نیست." });
        return;
      }
      const imageUrl = new URL(`${comfyUrl}/view`);
      imageUrl.searchParams.set("filename", filename);
      imageUrl.searchParams.set("subfolder", subfolder);
      imageUrl.searchParams.set("type", type);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        response.writeHead(imageResponse.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("فایل تصویر در ComfyUI پیدا نشد.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": imageResponse.headers.get("content-type") || "image/png",
        "Cache-Control": "no-store",
      });
      response.end(Buffer.from(await imageResponse.arrayBuffer()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const chatRequest = await readJson(request, response, 4 * 1024 * 1024);
      if (!chatRequest) return;
      const model = typeof chatRequest.model === "string" ? chatRequest.model.trim() : "";
      const messages = await attachFiles(chatRequest.messages);
      if (!model || !messages.length || !messages.some((message) => message.role === "user")) {
        sendJson(response, 400, { error: "مدل یا پیام‌های گفتگو معتبر نیستند." });
        return;
      }
      const settings = store.readSettings();
      if (settings.chatProvider === "api" && !settings.apiBaseUrl) {
        sendJson(response, 400, { error: "ابتدا از ویجت اتصال API، آدرس را ذخیره کنید." });
        return;
      }
      const controller = beginClose(request, response);
      const prepared = await upstream.buildChatMessages(
        messages,
        systemText(latestUserText(messages), chatRequest.conversationId, settings.memoryEnabled !== false),
      );
      const sendToken = (token) => {
        response.write(`${JSON.stringify({ message: { content: token } })}\n`);
      };
      const onOpen = () => {
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        });
      };
      if (settings.chatProvider === "api") {
        await upstream.streamOpenAi({
          baseUrl: settings.apiBaseUrl,
          apiKey: settings.apiKey,
          model,
          messages: prepared.openai,
          signal: controller.signal,
          onOpen,
          onToken: sendToken,
        });
      } else {
        await upstream.streamOllama({
          ollamaUrl,
          model,
          messages: prepared.ollama,
          signal: controller.signal,
          onOpen,
          onToken: sendToken,
        });
      }
      response.end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD, POST, PUT, DELETE" });
      response.end();
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(publicDir, relativePath);
    if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("صفحه پیدا نشد.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    });
  } catch (error) {
    if (error.name === "AbortError") {
      if (!response.writableEnded) response.end();
      return;
    }
    console.error(error.message || error);
    if (response.headersSent) {
      if (!response.writableEnded) {
        response.write(`${JSON.stringify({ error: error.message || "درخواست ناموفق بود." })}\n`);
        response.end();
      }
      return;
    }
    sendJson(response, error.status || 502, { error: error.message || "درخواست ناموفق بود." });
  }
});

server.listen(port, host, () => {
  console.log(`چت محلی آماده است: http://${host}:${port}`);
  console.log(`آدرس Ollama: ${ollamaUrl}`);
});
