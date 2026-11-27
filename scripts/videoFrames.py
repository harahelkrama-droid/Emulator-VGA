#!/usr/bin/env python3
"""Extrai frames de um vídeo de gameplay para inspeção visual + calibração de cor.

Uso:
  /tmp/vid/bin/python scripts/videoFrames.py <video.mp4|webm|mov> [--every S] [--max N] [--out DIR]

O que sai em DIR:
  frame-<seg>s.png   — os frames amostrados (resolução nativa; 256x224 = SNES cru)
  palette.txt        — por frame: cores dominantes da faixa inferior (chão/lava),
                       da faixa do meio (inimigos/portas) e do topo (HUD/overlay)
  info.json          — duração, fps, resolução, contagem de frames

Por que isso existe: a IA lê o estado por pixel (lava não é bloco no mapa de sala;
o HUD do X-Fusion desenha um mapa por cima do jogo; cores de comporta variam no hack).
Cada threshold vive de calibração com quadro real — este script entrega o quadro real.
"""
import argparse, json, os, sys
from collections import Counter

import av
import numpy as np
from PIL import Image


def dominant(colors: np.ndarray, k: int = 4) -> list[str]:
    """quantiza em blocos de 16 níveis e devolve as k cores mais frequentes"""
    q = (colors // 16 * 16 + 8).astype(np.uint8)
    packed = (q[:, 0].astype(np.int32) << 16) | (q[:, 1].astype(np.int32) << 8) | q[:, 2].astype(np.int32)
    tally = Counter(packed.tolist())
    out = []
    for rgb, n in tally.most_common(k):
        r, g, b = (rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF
        out.append(f"#{r:02x}{g:02x}{b:02x} ({n})")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--every", type=float, default=1.0, help="um frame a cada N segundos")
    ap.add_argument("--max", type=int, default=64, help="máximo de frames (amostra uniformemente)")
    ap.add_argument("--out", default="video-analysis")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    container = av.open(args.video)
    stream = container.streams.video[0]
    fps = float(stream.average_rate or 30)
    dur = float(container.duration / av.time_base) if container.duration else 0.0
    step_frames = max(1, int(round(args.every * fps)))

    kept, idx, next_keep = [], 0, 0
    total = 0
    for frame in container.decode(stream):
        if idx == next_keep:
            next_keep = idx + step_frames
            img = frame.to_ndarray(format="rgb24")
            total += 1
            kept.append((frame.pts * float(stream.time_base) if frame.pts else idx / fps, img))
        idx += 1
    container.close()

    if len(kept) > args.max:
        # amostra uniforme: mantém args.max frames igualmente espaçados
        sel = np.linspace(0, len(kept) - 1, args.max).round().astype(int)
        kept = [kept[i] for i in sel]

    lines = []
    for t, img in kept:
        h, w, _ = img.shape
        tag = f"{int(t * 10):d}ds"
        path = os.path.join(args.out, f"frame-{tag.zfill(5)}.png")
        Image.fromarray(img).save(path)
        bot = img[int(h * 0.72):, :, :].reshape(-1, 3) if h >= 40 else img[-1]
        mid = img[int(h * 0.35):int(h * 0.65), :, :].reshape(-1, 3) if h >= 40 else img[0]
        top = img[: int(h * 0.14), :, :].reshape(-1, 3) if h >= 40 else img[0]
        lines.append(
            f"frame {t:7.2f}s  {w}x{h}\n"
            f"  fundo/ chão-lava : {', '.join(dominant(bot))}\n"
            f"  meio   / mundo   : {', '.join(dominant(mid))}\n"
            f"  topo   / HUD     : {', '.join(dominant(top))}"
        )

    info = {
        "video": args.video,
        "duration_s": round(dur, 2),
        "fps": round(fps, 3),
        "frames_total_decoded": idx,
        "frames_kept": len(kept),
        "resolution": f"{kept[0][1].shape[1]}x{kept[0][1].shape[0]}" if kept else None,
        "snes_native": bool(kept and kept[0][1].shape[:2] == (224, 256)),
    }
    with open(os.path.join(args.out, "info.json"), "w") as f:
        json.dump(info, f, indent=2)
    with open(os.path.join(args.out, "palette.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")

    print(json.dumps(info, indent=2))
    print(f"\n{len(kept)} frames em {args.out}/ · paleta em {args.out}/palette.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
