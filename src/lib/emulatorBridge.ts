import type { AIKey, CapturedFrame } from '../types/emulator';

interface EJSGameManager {
  getState?: () => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;
  loadState?: (data: Uint8Array) => void | Promise<void>;
  screenshot?: () => Uint8Array | Promise<Uint8Array>;
  simulateInput?: (player: number, index: number, value: number) => void;
  toggleMainLoop?: (running: number) => void;
  restart?: () => void;
}

interface EJSEmulatorInstance {
  gameManager?: EJSGameManager;
  started?: boolean;
  paused?: boolean;
  pause?: (silent?: boolean) => void;
}

declare global {
  interface Window {
    EJS_player?: string;
    EJS_core?: string;
    EJS_gameUrl?: string;
    EJS_pathtodata?: string;
    EJS_startOnLoaded?: boolean;
    EJS_language?: string;
    EJS_color?: string;
    EJS_defaultOptions?: Record<string, unknown>;
    EJS_defaultControls?: Record<number, Record<number, { value: string; value2: string }>>;
    EJS_Buttons?: Record<string, boolean>;
    EJS_onGameStart?: () => void;
    EJS_emulator?: EJSEmulatorInstance;
    __retroplayGlPatched?: boolean;
  }
}

export const KEYBOARD_MAP: Record<Exclude<AIKey, 'NONE'>, { key: string; code: string; keyCode: number; ejsIndex: number }> = {
  B: { key: 'x', code: 'KeyX', keyCode: 88, ejsIndex: 0 },
  Y: { key: 's', code: 'KeyS', keyCode: 83, ejsIndex: 1 },
  SELECT: { key: 'v', code: 'KeyV', keyCode: 86, ejsIndex: 2 },
  START: { key: 'Enter', code: 'Enter', keyCode: 13, ejsIndex: 3 },
  UP: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, ejsIndex: 4 },
  DOWN: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, ejsIndex: 5 },
  LEFT: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, ejsIndex: 6 },
  RIGHT: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, ejsIndex: 7 },
  A: { key: 'z', code: 'KeyZ', keyCode: 90, ejsIndex: 8 },
  X: { key: 'a', code: 'KeyA', keyCode: 65, ejsIndex: 9 },
  L: { key: 'q', code: 'KeyQ', keyCode: 81, ejsIndex: 10 },
  R: { key: 'e', code: 'KeyE', keyCode: 69, ejsIndex: 11 },
};

// 240×160 é a tela do GBA. O SNES é 256×224: com as constantes antigas, o letterbox jogava
// ~24% das colunas (29+28 px) dentro da grade de análise como barra preta — os métricos de
// movimento/contraste ficavam diluídos e o mapa do jogo perdia resolução. Passamos a casar o
// tamanho do core; o agente lê width/height do frame, então nada mais precisa saber disso.
const CAPTURE_W = 256;
const CAPTURE_H = 224;
const CAPTURE_GBA_W = 240;
const CAPTURE_GBA_H = 160;

function captureSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: CAPTURE_W, h: CAPTURE_H };
  return window.EJS_core === 'gba' ? { w: CAPTURE_GBA_W, h: CAPTURE_GBA_H } : { w: CAPTURE_W, h: CAPTURE_H };
}

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let currentHeldKeys = new Set<Exclude<AIKey, 'NONE'>>();

function ensureOffscreenCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const size = captureSize();
  if (!offscreenCanvas || !offscreenCtx || offscreenCanvas.width !== size.w || offscreenCanvas.height !== size.h) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = size.w;
    offscreenCanvas.height = size.h;
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!offscreenCtx) {
    throw new Error('Contexto 2D indisponível para análise visual.');
  }
  return { canvas: offscreenCanvas, ctx: offscreenCtx };
}

export function ensureWebGLPreserveBuffer(): void {
  if (typeof window === 'undefined' || window.__retroplayGlPatched) return;
  window.__retroplayGlPatched = true;
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attrs?: Record<string, unknown>,
  ) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      return origGetContext.call(this, type, {
        ...(attrs || {}),
        preserveDrawingBuffer: true,
      } as WebGLContextAttributes) as ReturnType<typeof origGetContext>;
    }
    return origGetContext.call(this, type, attrs) as ReturnType<typeof origGetContext>;
  } as typeof HTMLCanvasElement.prototype.getContext;
}

export function getEmulatorGameManager(): EJSGameManager | null {
  return window.EJS_emulator?.gameManager ?? null;
}

export function isEmulatorReady(): boolean {
  const gm = getEmulatorGameManager();
  return Boolean(gm && typeof gm.getState === 'function' && window.EJS_emulator?.started);
}

export function releaseAllGameInputs(): void {
  for (const key of currentHeldKeys) {
    sendGameInput(key, false);
  }
  currentHeldKeys.clear();
}

export function restartEmulatorGame(): boolean {
  releaseAllGameInputs();
  const gm = getEmulatorGameManager();
  if (gm && typeof gm.restart === 'function') {
    gm.restart();
    return true;
  }
  return false;
}

export function setHeldGameInputs(nextKeys: AIKey[]): void {
  const target = new Set<Exclude<AIKey, 'NONE'>>();
  for (const k of nextKeys) {
    if (k !== 'NONE' && KEYBOARD_MAP[k]) {
      target.add(k);
    }
  }
  for (const active of currentHeldKeys) {
    if (!target.has(active)) {
      sendGameInput(active, false);
    }
  }
  for (const desired of target) {
    if (!currentHeldKeys.has(desired)) {
      sendGameInput(desired, true);
    }
  }
  currentHeldKeys = target;
}

/**
 * Lê o estado do núcleo com TTL. `getState()` do EmulatorJS **serializa o estado inteiro**
 * (alguns MB): chamado a cada decisão, no mesmo frame do render, é a maior fonte de jitter do
 * laço — e a IA local só precisa das posições/HP/portas, que não mudam entre dois frames
 * seguidos. Um cache de ~90 ms corta ~95% desses pedidos sem perder informação relevante.
 */
let ramCache: { at: number; data: Uint8Array } | null = null;
let ramCacheTtl = 0;

export function invalidateRamCache(): void {
  ramCache = null;
}

export async function readEmulatorRam(ttlMs = 0): Promise<Uint8Array | null> {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (ramCache && now - ramCache.at <= Math.max(ttlMs, ramCacheTtl)) return ramCache.data;
  const gm = getEmulatorGameManager();
  if (!gm || typeof gm.getState !== 'function') return null;
  try {
    const raw = await Promise.resolve(gm.getState());
    if (!raw) return null;
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    ramCache = { at: now, data };
    ramCacheTtl = ttlMs;
    return data;
  } catch {
    return null;
  }
}

/** carregar save state / reset: o cache tem que morrer junto, senão a IA lê o mundo antigo */
export function primeRamCacheAfterStateChange(): void {
  invalidateRamCache();
}

export function destroyEmulator(): void {
  releaseAllGameInputs();
  try {
    const emu = window.EJS_emulator;
    if (emu) {
      if (typeof emu.pause === 'function') emu.pause(true);
      if (emu.gameManager && typeof emu.gameManager.toggleMainLoop === 'function') {
        emu.gameManager.toggleMainLoop(0);
      }
    }
  } catch {
    // Ignore teardown errors
  }
  const oldScript = document.getElementById('ejs-script');
  if (oldScript) oldScript.remove();
  const mount = document.getElementById('emulator-mount');
  if (mount) mount.innerHTML = '';
  delete window.EJS_emulator;
  delete window.EJS_onGameStart;
}

export function mountEmulator(options: {
  mountElement: HTMLElement;
  gameUrl: string;
  fileName: string;
  onReady: () => void;
  onError: (message: string) => void;
}): () => void {
  const ext = options.fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!['gba', 'sfc', 'smc'].includes(ext)) {
    options.onError('Formato não suportado. Use arquivos .gba, .sfc ou .smc.');
    return () => {};
  }

  let cancelled = false;
  ensureWebGLPreserveBuffer();
  destroyEmulator();

  options.mountElement.innerHTML = '<div id="emulator"></div>';
  window.EJS_player = '#emulator';
  window.EJS_core = ext === 'gba' ? 'gba' : 'snes';
  window.EJS_gameUrl = options.gameUrl;
  window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
  window.EJS_startOnLoaded = true;
  window.EJS_language = 'pt-BR';
  window.EJS_color = '#6ee7b7';
  window.EJS_defaultOptions = {
    'save-state-location': 'browser',
    'save-state-slot': 1,
  };
  window.EJS_defaultControls = {
    0: {
      0: { value: 'x', value2: 'BUTTON_2' },
      1: { value: 's', value2: 'BUTTON_4' },
      2: { value: 'v', value2: 'SELECT' },
      3: { value: 'enter', value2: 'START' },
      4: { value: 'up arrow', value2: 'DPAD_UP' },
      5: { value: 'down arrow', value2: 'DPAD_DOWN' },
      6: { value: 'left arrow', value2: 'DPAD_LEFT' },
      7: { value: 'right arrow', value2: 'DPAD_RIGHT' },
      8: { value: 'z', value2: 'BUTTON_1' },
      9: { value: 'a', value2: 'BUTTON_3' },
      10: { value: 'q', value2: 'LEFT_TOP_SHOULDER' },
      11: { value: 'e', value2: 'RIGHT_TOP_SHOULDER' },
    },
    1: {},
    2: {},
    3: {},
  };
  window.EJS_Buttons = {
    saveState: false,
    loadState: false,
    quickSave: false,
    quickLoad: false,
  };

  window.EJS_onGameStart = () => {
    if (!cancelled) options.onReady();
  };

  const pollId = window.setInterval(() => {
    if (cancelled) {
      window.clearInterval(pollId);
      return;
    }
    if (isEmulatorReady()) {
      window.clearInterval(pollId);
      options.onReady();
    }
  }, 350);

  const EJS_MIRRORS = [
    'https://cdn.emulatorjs.org/stable/data/loader.js',
    'https://cdnjs.cloudflare.com/ajax/libs/emulatorjs/3.1.0/loader.js',
    'https://cdn.jsdelivr.net/npm/emulatorjs@3.1.0/dist/loader.js',
  ];

  let mirrorIndex = 0;
  const tryLoadMirror = () => {
    if (cancelled) return;
    const src = EJS_MIRRORS[mirrorIndex];
    const script = document.createElement('script');
    script.id = 'ejs-script';
    script.src = src;
    script.onerror = () => {
      window.clearInterval(pollId);
      if (cancelled) return;
      mirrorIndex++;
      if (mirrorIndex < EJS_MIRRORS.length) {
        // Tenta o próximo espelho automaticamente
        tryLoadMirror();
        return;
      }
      options.onError('Falha ao carregar o runtime do EmulatorJS em todos os espelhos. Verifique sua conexão.');
    };
    script.onload = () => {
      // script carregado com sucesso; o poll de isEmulatorReady já está rodando
    };
    document.body.appendChild(script);
  };

  tryLoadMirror();

  return () => {
    cancelled = true;
    window.clearInterval(pollId);
    destroyEmulator();
  };
}

export function sendGameInput(key: AIKey, pressed: boolean): void {
  if (key === 'NONE') return;
  const mapping = KEYBOARD_MAP[key];
  if (!mapping) return;

  const gm = getEmulatorGameManager();
  if (gm && typeof gm.simulateInput === 'function') {
    gm.simulateInput(0, mapping.ejsIndex, pressed ? 1 : 0);
    return;
  }

  const event = new KeyboardEvent(pressed ? 'keydown' : 'keyup', {
    key: mapping.key,
    code: mapping.code,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.defineProperty(event, 'keyCode', { get: () => mapping.keyCode });
  Object.defineProperty(event, 'which', { get: () => mapping.keyCode });
  document.dispatchEvent(event);
}

let cachedFrame: CapturedFrame | null = null;
let cachedFrameAt = 0;

export interface CaptureFrameOptions {
  skipJpeg?: boolean;
  maxCacheAgeMs?: number;
}

export async function captureGameFrame(options: CaptureFrameOptions = {}): Promise<CapturedFrame> {
  const now = performance.now();
  const maxAge = options.maxCacheAgeMs ?? 0;
  if (cachedFrame && maxAge > 0 && now - cachedFrameAt < maxAge) {
    if (options.skipJpeg || cachedFrame.base64Jpeg) {
      return { ...cachedFrame, fresh: false };
    }
  }

  const { canvas, ctx } = ensureOffscreenCanvas();
  const CAPTURE_W = canvas.width;
  const CAPTURE_H = canvas.height;
  const gm = getEmulatorGameManager();
  const skipJpeg = Boolean(options.skipJpeg);

  // Ordem do caminho de captura: `gameManager.screenshot()` devolve PNG, que ainda precisa de
  // `createImageBitmap` para virar pixel — um encode + decode de imagem por decisão, no thread
  // do render. O `drawImage` direto do canvas do jogo (com o patch de preserveDrawingBuffer)
  // entrega os mesmos pixels sem passar por codec nenhum, então ele vem primeiro e o PNG fica
  // como reserva (núcleos que não expõem o canvas, e.g. hardware renderer sem leitura).
  let directOk = false;
  {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('#emulator-mount canvas'));
    const source = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (source && source.width && source.height) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CAPTURE_W, CAPTURE_H);
      const scale = Math.min(CAPTURE_W / source.width, CAPTURE_H / source.height);
      const w = Math.max(1, Math.round(source.width * scale));
      const h = Math.max(1, Math.round(source.height * scale));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, Math.round((CAPTURE_W - w) / 2), Math.round((CAPTURE_H - h) / 2), w, h);
      const rgba = ctx.getImageData(0, 0, CAPTURE_W, CAPTURE_H).data;
      let sig = '';
      for (let i = 0; i < rgba.length; i += 1024) sig += rgba[i] + ',';
      // frame preto = canvas sem conteúdo legível (preserveDrawingBuffer não aplicado): cai no PNG
      let nonBlack = false;
      for (let i = 0; i < rgba.length; i += 4096) {
        if (rgba[i] || rgba[i + 1] || rgba[i + 2]) { nonBlack = true; break; }
      }
      if (nonBlack) {
        directOk = true;
        const freshFrame: CapturedFrame = {
          base64Jpeg: skipJpeg ? '' : canvas.toDataURL('image/jpeg', 0.55).split(',')[1] ?? '',
          width: CAPTURE_W,
          height: CAPTURE_H,
          rgba,
          signature: sig,
          source: 'canvas.drawImage',
          fresh: true,
        };
        cachedFrame = freshFrame;
        cachedFrameAt = now;
        return freshFrame;
      }
    }
  }

  if (!directOk && gm && typeof gm.screenshot === 'function') {
    try {
      const raw = await gm.screenshot();
      if (raw && raw.length > 0) {
        const bytes = new Uint8Array(raw).slice();
        const blob = new Blob([bytes], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, CAPTURE_W, CAPTURE_H);
        const scale = Math.min(CAPTURE_W / bitmap.width, CAPTURE_H / bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, Math.round((CAPTURE_W - w) / 2), Math.round((CAPTURE_H - h) / 2), w, h);
        bitmap.close();

        const rgba = ctx.getImageData(0, 0, CAPTURE_W, CAPTURE_H).data;
        let sig = '';
        for (let i = 0; i < rgba.length; i += 1024) {
          sig += rgba[i] + ',';
        }
        const base64Jpeg = skipJpeg ? '' : canvas.toDataURL('image/jpeg', 0.55).split(',')[1] ?? '';
        const freshFrame: CapturedFrame = {
          base64Jpeg,
          width: CAPTURE_W,
          height: CAPTURE_H,
          rgba,
          signature: sig,
          source: 'gameManager.screenshot',
          fresh: true,
        };
        cachedFrame = freshFrame;
        cachedFrameAt = performance.now();
        return freshFrame;
      }
    } catch {
      // Fallback
    }
  }

  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('#emulator-mount canvas'));
  const source = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!source || !source.width || !source.height) {
    throw new Error('A tela do emulador ainda está carregando.');
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CAPTURE_W, CAPTURE_H);
  const scale = Math.min(CAPTURE_W / source.width, CAPTURE_H / source.height);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, Math.round((CAPTURE_W - w) / 2), Math.round((CAPTURE_H - h) / 2), w, h);

  const rgba = ctx.getImageData(0, 0, CAPTURE_W, CAPTURE_H).data;
  let sig = '';
  for (let i = 0; i < rgba.length; i += 1024) {
    sig += rgba[i] + ',';
  }
  const base64Jpeg = skipJpeg ? '' : canvas.toDataURL('image/jpeg', 0.55).split(',')[1] ?? '';
  const freshFrame: CapturedFrame = {
    base64Jpeg,
    width: CAPTURE_W,
    height: CAPTURE_H,
    rgba,
    signature: sig,
    source: 'canvas.drawImage',
    fresh: true,
  };
  cachedFrame = freshFrame;
  cachedFrameAt = performance.now();
  return freshFrame;
}
