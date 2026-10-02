const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomInt } = require("node:crypto");

const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const comfyUrl = (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const publicDir = path.join(__dirname, "public");
const identitySystemPrompt = {
  role: "system",
  content:
    "شما دستیار فارسی‌زبان و کمک‌کننده‌ای به نام Nora هستید. اگر کاربر بپرسد 'تو کی هستی؟'، 'اسمت چیست؟'، 'چه کسی تو را ساخته است؟' یا جملات مشابه، دقیقاً به فارسی این جمله را بگو: 'من Nora هستم و توسط یاسین ساخته شدم.' در غیر این صورت به‌صورت طبیعی و مفید پاسخ بده.",
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function getModels() {
  const response = await fetch(`${ollamaUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }
  const data = await response.json();
  return data.models || [];
}

async function getComfyCheckpoints(signal) {
  const response = await fetch(`${comfyUrl}/object_info/CheckpointLoaderSimple`, {
    signal: signal || AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`ComfyUI returned ${response.status}`);
  }
  const data = await response.json();
  const choices = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(choices)) {
    throw new Error("فهرست checkpointها از ComfyUI در قالب مورد انتظار نیست.");
  }
  return choices;
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readJsonRequest(request, response) {
  let rawBody = "";
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > 1_000_000) {
      sendJson(response, 413, { error: "درخواست بیش از حد بزرگ است." });
      return null;
    }
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, { error: "درخواست نامعتبر است." });
    return null;
  }
}

function makeImageWorkflow(model, prompt) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "low quality, blurry, distorted, deformed, extra fingers, bad anatomy",
        clip: ["1", 1],
      },
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
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "chatkhane" } },
  };
}

async function waitForImage(promptId, signal) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (signal.aborted) throw new DOMException("درخواست لغو شد.", "AbortError");
    const response = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal });
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
    const history = await response.json();
    const result = history[promptId];
    if (result?.status?.status_str === "error") {
      throw new Error("ComfyUI هنگام تولید تصویر با خطا روبه‌رو شد.");
    }
    if (result?.outputs) {
      const images = Object.values(result.outputs).flatMap((output) => output.images || []);
      if (images.length) return images[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("زمان انتظار برای تولید تصویر تمام شد.");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

  if (request.method === "GET" && url.pathname === "/api/models") {
    try {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ models: await getModels() }));
    } catch (error) {
      response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: `اتصال به Ollama برقرار نشد: ${error.message}` }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/image-models") {
    try {
      sendJson(response, 200, { models: await getComfyCheckpoints() });
    } catch (error) {
      sendJson(response, 502, { error: `اتصال به ComfyUI برقرار نشد: ${error.message}` });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/image") {
    const imageRequest = await readJsonRequest(request, response);
    if (!imageRequest) return;
    if (
      typeof imageRequest.model !== "string" ||
      typeof imageRequest.prompt !== "string" ||
      !imageRequest.prompt.trim() ||
      imageRequest.prompt.length > 4000
    ) {
      sendJson(response, 400, { error: "مدل یا توضیح تصویر معتبر نیست." });
      return;
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const checkpoints = await getComfyCheckpoints(controller.signal);
      if (!checkpoints.includes(imageRequest.model)) {
        sendJson(response, 400, { error: "این مدل در ComfyUI موجود نیست؛ فهرست مدل‌ها را تازه‌سازی کنید." });
        return;
      }

      const queued = await fetch(`${comfyUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: makeImageWorkflow(imageRequest.model, imageRequest.prompt.trim()) }),
        signal: controller.signal,
      });
      if (!queued.ok) {
        const details = await queued.text();
        throw new Error(details || `ComfyUI returned ${queued.status}`);
      }
      const { prompt_id: promptId } = await queued.json();
      if (typeof promptId !== "string" || !promptId) {
        throw new Error("ComfyUI شناسهٔ درخواست معتبری برنگرداند.");
      }

      const image = await waitForImage(promptId, controller.signal);
      const imageParams = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || "",
        type: image.type || "output",
      });
      sendJson(response, 200, { imageUrl: `/api/image-file?${imageParams}`, model: imageRequest.model });
    } catch (error) {
      if (error.name !== "AbortError" && !response.writableEnded) {
        sendJson(response, 502, { error: `خطا در تولید تصویر: ${error.message}` });
      }
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/image-file") {
    const filename = url.searchParams.get("filename") || "";
    const subfolder = url.searchParams.get("subfolder") || "";
    const type = url.searchParams.get("type") || "output";
    if (
      !/^[\w .-]+\.png$/i.test(filename) ||
      (subfolder && !/^(?:[\w-]+\/)*[\w-]+$/.test(subfolder)) ||
      type !== "output"
    ) {
      sendJson(response, 400, { error: "مسیر تصویر معتبر نیست." });
      return;
    }
    try {
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
    } catch (error) {
      sendJson(response, 502, { error: `دریافت تصویر از ComfyUI ناموفق بود: ${error.message}` });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const chatRequest = await readJsonRequest(request, response);
    if (!chatRequest) return;

    if (
      typeof chatRequest.model !== "string" ||
      !Array.isArray(chatRequest.messages) ||
      chatRequest.messages.length === 0 ||
      chatRequest.messages.some(
        (message) =>
          !message ||
          !["user", "assistant", "system"].includes(message.role) ||
          typeof message.content !== "string",
      )
    ) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "مدل یا پیام‌های گفتگو معتبر نیستند." }));
      return;
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const messages = [identitySystemPrompt, ...chatRequest.messages];
      const upstream = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chatRequest.model,
          messages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const details = await upstream.text();
        response.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: details || `Ollama returned ${upstream.status}` }));
        return;
      }

      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });

      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) {
          await new Promise((resolve) => response.once("drain", resolve));
        }
      }
      response.end();
    } catch (error) {
      if (error.name !== "AbortError" && !response.headersSent) {
        response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: `خطا در ارتباط با Ollama: ${error.message}` }));
      } else if (!response.writableEnded && error.name !== "AbortError") {
        response.end();
      }
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD, POST" });
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
});

server.listen(port, host, () => {
  console.log(`چت محلی آماده است: http://${host}:${port}`);
  console.log(`آدرس Ollama: ${ollamaUrl}`);
});
