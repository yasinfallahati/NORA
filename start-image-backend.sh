#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
comfy_dir="${COMFYUI_DIR:-$HOME/ComfyUI}"
checkpoint="$project_dir/models/checkpoints/dreamshaper_8.safetensors"
comfy_checkpoint_dir="$comfy_dir/models/checkpoints"
comfy_checkpoint="$comfy_checkpoint_dir/dreamshaper_8.safetensors"
python="$comfy_dir/venv/bin/python"

if [ ! -x "$python" ] || [ ! -f "$comfy_dir/main.py" ]; then
  printf 'ComfyUI نصب نیست یا محیط مجازی آن پیدا نشد: %s\n' "$comfy_dir" >&2
  exit 1
fi

if [ ! -f "$checkpoint" ]; then
  printf 'فایل مدل DreamShaper 8 پیدا نشد: %s\n' "$checkpoint" >&2
  exit 1
fi

mkdir -p "$comfy_checkpoint_dir"
if [ ! -e "$comfy_checkpoint" ]; then
  ln -s "$checkpoint" "$comfy_checkpoint"
fi

exec "$python" "$comfy_dir/main.py" \
  --cpu-vae \
  --lowvram \
  --preview-method none \
  --listen 127.0.0.1 \
  --port 8188
