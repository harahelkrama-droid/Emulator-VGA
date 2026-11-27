/**
 * visionDanger.ts — detecção de perigo visual por cor (fallback sem WRAM).
 *
 * Quando a memória WRAM do SNES não está disponível, o agente enxerga apenas pixels.
 * Este módulo detecta cores que indicam perigo imediato no chão à frente da Samus:
 *   - Vermelho intenso   → espinho / dano de contato
 *   - Laranja/amarelo    → lava
 *
 * É usado pelo `decideUniversalVision` para a IA não andar para dentro da morte
 * quando está jogando às cegas (sem leitura de memória).
 */

import type { CapturedFrame } from '../types/emulator';

/**
 * Amostra uma região à frente da Samus e retorna true se detectar perigo por cor.
 *
 * @param frame  quadro capturado do emulador
 * @param dir    direção para a qual a Samus está se movendo ('LEFT' | 'RIGHT')
 * @returns true quando >18% dos pixels amostrados na região são vermelho ou laranja intenso
 */
export function detectDangerColor(frame: CapturedFrame, dir: 'LEFT' | 'RIGHT'): boolean {
  const { rgba, width, height } = frame;
  if (!rgba || width < 64 || height < 64) return false;

  const cx = dir === 'RIGHT' ? Math.floor(width * 0.62) : Math.floor(width * 0.38);
  const cy = Math.floor(height * 0.62); // faixa do chão / à frente dos pés
  const radius = 26;

  let danger = 0;
  let sampled = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 2) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 2) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      sampled++;
      // vermelho intenso (espinho / dano de contato)
      if (r > 150 && g < 90 && b < 90) danger++;
      // laranja/amarelo intenso (lava)
      if (r > 170 && g > 90 && g < 170 && b < 70) danger++;
    }
  }
  return sampled > 0 && danger / sampled > 0.18;
}
