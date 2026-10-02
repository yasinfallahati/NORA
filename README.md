# NORA

Local chat and image generation that run on your own machine.

![NORA](docs/preview.jpg)

NORA is a small web app for talking to models served by [Ollama](https://ollama.com) and for generating images through [ComfyUI](https://github.com/Comfy-Org/ComfyUI). The interface is in Persian. Conversations are saved in the browser, and the server listens only on `127.0.0.1`.

## What it does

- Chat with local Ollama models, with replies streamed to the page.
- Generate a 512×512 image from a text prompt.
- Switch between chat and image mode, and pick a model from the lists returned by each service.
- Keep recent conversations in the sidebar.

The default chat model is `qwen2.5:7b` when it is installed. Image generation uses Stable Diffusion 1.5 settings suited to a graphics card with about 4 GB of VRAM.

## Requirements

- Node.js 18 or newer
- Ollama, with at least one chat model pulled
- For images: ComfyUI, plus a checkpoint such as DreamShaper 8 (see `models/checkpoints/README.md`)

## Run

Start Ollama, then from this folder:

```bash
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

To use image generation, install ComfyUI once if you do not already have it:

```bash
git clone https://github.com/Comfy-Org/ComfyUI.git ~/ComfyUI
python3 -m venv ~/ComfyUI/venv
~/ComfyUI/venv/bin/pip install -r ~/ComfyUI/requirements.txt
```

Place `dreamshaper_8.safetensors` in `models/checkpoints/`, then start ComfyUI from a second terminal:

```bash
./start-image-backend.sh
```

That script links the checkpoint into ComfyUI and starts it on [http://127.0.0.1:8188](http://127.0.0.1:8188) with low-VRAM settings. The checkpoint file is large and is not included in this repository.

## Configuration

| Variable | Default | Used for |
| --- | --- | --- |
| `PORT` | `3000` | NORA |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI |
| `COMFYUI_DIR` | `~/ComfyUI` | ComfyUI install path for the start script |
