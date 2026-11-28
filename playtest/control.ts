// Control experiment: reproduce the agent's lock-up in the real ROM, then ask whether a
// dumb 2-key macro can leave the same room. Separates "policy is broken" from "the room
// was actually impassable".
//
//   phase A  LocalVisionAgent drives (identical to the 25-min session) until (room,x) is
//            frozen for STALL ticks.
//   phase B  the same state, but input comes from fixed macros (RIGHT, RIGHT+run,
//            RIGHT+jump, DOWN+BOMBS, LEFT...).
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import { LibretroHost } from 'romdev-core-host';
// @ts-ignore
import * as snesPlatform from 'romdev-platform-snes';
import { LocalVisionAgent } from '../src/lib/localVisionAI';
import { readMetroidWram } from '../src/lib/snesWram';
import type { AIAction, AIKey, CapturedFrame } from '../src/types/emulator';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROM = path.join(ROOT, 'public/games/Super Metroid.sfc');
const OUT = path.join(ROOT, 'playtest/out/control');
fs.mkdirSync(OUT, { recursive: true });
const STALL_TICKS = Number(process.env.STALL_TICKS || 420);
const MAX_AGENT_TICKS = Number(process.env.MAX_AGENT_TICKS || 4000);

// @ts-ignore
const host = new LibretroHost({ log: () => {} });
await host.loadCore(snesPlatform.core.jsPath, snesPlatform.core.wasmPath);
await host.loadMedia({ platform: 'snes', path: ROM });

const W = 240;
const H = 160;
const rgbaBuf = new Uint8ClampedArray(W * H * 4);
function captureFrame(fresh: boolean): CapturedFrame {
  const shot = host.screenshotRgba();
  const src = shot.rgba as Uint8ClampedArray;
  const sw = shot.width as number;
  const sh = shot.height as number;
  const scale = Math.min(W / sw, H / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const dx = Math.round((W - w) / 2);
  const dy = Math.round((H - h) / 2);
  rgbaBuf.fill(0);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor((y - dy + 0.5) / scale);
    if (sy < 0 || sy >= sh) continue;
    for (let x = 0; x < W; x++) {
      const sx = Math.floor((x - dx + 0.5) / scale);
      if (sx < 0 || sx >= sw) continue;
      const si = (sy * sw + sx) * 4;
      const di = (y * W + x) * 4;
      rgbaBuf[di] = src[si];
      rgbaBuf[di + 1] = src[si + 1];
      rgbaBuf[di + 2] = src[si + 2];
      rgbaBuf[di + 3] = 255;
    }
  }
  let sig = '';
  for (let i = 0; i < rgbaBuf.length; i += 1024) sig += rgbaBuf[i] + ',';
  return { base64Jpeg: '', width: W, height: H, rgba: rgbaBuf, signature: sig, source: 'canvas.drawImage', fresh };
}
const stateBuf = new Uint8Array(5 + 0x20000);
stateBuf.set([0x52, 0x41, 0x4d, 0x3a, 0x3a], 0);
const RAM = 5;
function refreshRam(): void {
  stateBuf.set(host.readMemory('system_ram', 0, 0x20000).subarray(0, 0x20000), RAM);
}
const u16 = (a: number) => stateBuf[RAM + a] | (stateBuf[RAM + a + 1] << 8);
// @ts-ignore
globalThis.window = {
  EJS_core: 'snes',
  EJS_emulator: {
    started: true,
    // @ts-ignore
    gameManager: { getState: async () => stateBuf, simulateInput: () => {} },
  },
};
const BTN: Record<string, string> = { B: 'b', Y: 'y', SELECT: 'select', START: 'start', UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right', A: 'a', X: 'x', L: 'l', R: 'r' };
function applyKeys(keys: AIKey[]): void {
  const port: Record<string, boolean> = {};
  for (const k of keys) if (k !== 'NONE' && BTN[k]) port[BTN[k]] = true;
  host.setInput({ ports: [port] });
}
function step(n: number): void {
  for (let i = 0; i < n; i++) host.renderOneFrame();
}
function snap(tag: string): void {
  try {
    const { pngBase64 } = host.screenshot();
    fs.writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(pngBase64, 'base64'));
  } catch {
    /* ignore */
  }
}

const agent = new LocalVisionAgent();
agent.reset();
const out: Record<string, unknown> = { agentTicks: 0, notes: [] as string[] };

// ---- phase A: reproduce the lock-up --------------------------------------------------------
let tick = 0;
let lastKey = '';
let same = 0;
let stallRoom = -1;
while (tick < MAX_AGENT_TICKS) {
  tick++;
  refreshRam();
  const wram = await readMetroidWram();
  const frame = captureFrame(tick % 2 === 1);
  let action: AIAction;
  try {
    action = agent.decide(frame, 'action', 'Super / Super Fácil', wram);
  } catch (e) {
    (out.notes as string[]).push(`throw @${tick}: ${(e as Error).message}`);
    action = { key: 'NONE', keys: ['NONE'], time: 120, phase: 'run' } as AIAction;
  }
  const keys = action.keys && action.keys.length ? action.keys : [action.key];
  applyKeys(keys);
  step(Math.max(1, Math.round(Math.min(160, Math.max(90, action.time || 120)) / (1000 / 60))));
  if (wram && wram.valid && wram.gameState === 8 && wram.roomId > 0) {
    const k = `${wram.roomId}@${wram.samusX}`;
    if (k === lastKey) same++;
    else {
      same = 0;
      lastKey = k;
      stallRoom = wram.roomId;
    }
    if (same >= STALL_TICKS) break;
  }
}
refreshRam();
out.agentTicks = tick;
out.lock = { room: stallRoom, x: u16(0x0af6), y: u16(0x0afa), hp: u16(0x09c2), frozenTicks: same };
snap('agent_locked');
console.log('phase A', JSON.stringify(out.lock), 'after', tick, 'ticks');

// ---- phase B: macros on the same state -----------------------------------------------------
type M = { name: string; frames: number; fn: (f: number) => AIKey[] };
const macros: M[] = [
  { name: 'RIGHT_hold', frames: 1800, fn: () => ['RIGHT'] },
  { name: 'RIGHT_run', frames: 1800, fn: () => ['RIGHT', 'X'] },
  { name: 'RIGHT_run_jump', frames: 1800, fn: (f) => (f % 20 < 12 ? ['RIGHT', 'X', 'A'] : ['RIGHT', 'X']) },
  { name: 'RIGHT_morph', frames: 1200, fn: () => ['RIGHT', 'DOWN'] },
  { name: 'LEFT_run_jump', frames: 1200, fn: (f) => (f % 20 < 12 ? ['LEFT', 'X', 'A'] : ['LEFT', 'X']) },
  { name: 'DOWN_bombs', frames: 1200, fn: (f) => (f % 40 < 10 ? ['DOWN', 'B'] : ['DOWN']) },
  { name: 'UP_shoot', frames: 900, fn: () => ['UP', 'B'] },
  { name: 'door_buster', frames: 1200, fn: (f) => (f % 30 < 10 ? ['RIGHT', 'UP', 'B'] : ['RIGHT', 'SELECT', 'B']) },
];
const results: Array<Record<string, unknown>> = [];
for (const m of macros) {
  refreshRam();
  const before = { room: u16(0x079b), x: u16(0x0af6), y: u16(0x0afa), hp: u16(0x09c2) };
  let roomChanged = -1;
  let minX = before.x;
  let maxX = before.x;
  let minY = before.y;
  let maxY = before.y;
  for (let f = 0; f < m.frames; f++) {
    applyKeys(m.fn(f));
    step(1);
    if (f % 20 === 0) {
      refreshRam();
      const x = u16(0x0af6);
      const y = u16(0x0afa);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (roomChanged < 0 && u16(0x079b) !== before.room) roomChanged = f;
    }
  }
  applyKeys([]);
  step(60);
  refreshRam();
  const after = { room: u16(0x079b), x: u16(0x0af6), y: u16(0x0afa), hp: u16(0x09c2) };
  results.push({
    macro: m.name,
    before,
    after,
    dx: after.x - before.x,
    moved: maxX - minX,
    yRange: [minY, maxY],
    roomChangedAfterFrames: roomChanged,
    escapedRoom: after.room !== before.room,
  });
  snap(`macro_${m.name}`);
  console.log('macro', JSON.stringify(results[results.length - 1]));
}
out.macros = results;

// what did the agent think, right at the lock?
refreshRam();
const wramNow = await readMetroidWram();
out.agentBeliefs = wramNow
  ? {
      room: wramNow.roomId,
      dims: [wramNow.roomWidthBlocks, wramNow.roomHeightBlocks],
      doors: wramNow.doors.map((d) => `${d.side}@${d.bx},${d.by}${d.blockedByWall ? ' (wall)' : ''}`),
      abilities: wramNow.abilities.length,
      itemsMask: '0x' + wramNow.itemsMask.toString(16),
      beamsMask: '0x' + wramNow.beamsMask.toString(16),
      enemies: wramNow.enemies.length,
      plms: wramNow.plms.length,
      missiles: wramNow.missiles,
    }
  : null;
out.selfCorrections = agent.exportSelfCorrections();
fs.writeFileSync(path.join(OUT, 'control.json'), JSON.stringify(out, null, 2));
console.log('\nwrote', path.join(OUT, 'control.json'));
