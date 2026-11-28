// Control experiments against the same ROM/core while the platform agent is stuck.
//
//  1. let the real agent play until it locks up (same room + same x for `STALL_TICKS`);
//  2. audit what the agent *believes* (itemsMask/abilities/PLM/block types) against raw WRAM;
//  3. hand the pads to three dumb macros (walk right, right+jump, morph+bomb) and measure
//     whether the room is actually escapable — separating "bad movement policy" from
//     "the emulator/state is wrong".
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
const OUT = path.join(ROOT, 'playtest/out/probe');
fs.mkdirSync(OUT, { recursive: true });

// @ts-ignore
const host = new LibretroHost({ log: () => {} });
await host.loadCore(snesPlatform.core.jsPath, snesPlatform.core.wasmPath);
await host.loadMedia({ platform: 'snes', path: ROM });

const CAPTURE_W = 240;
const CAPTURE_H = 160;
const rgbaBuf = new Uint8ClampedArray(CAPTURE_W * CAPTURE_H * 4);

function captureFrame(fresh: boolean): CapturedFrame {
  const shot = host.screenshotRgba();
  const src = shot.rgba as Uint8ClampedArray;
  const sw = shot.width as number;
  const sh = shot.height as number;
  const scale = Math.min(CAPTURE_W / sw, CAPTURE_H / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const dx = Math.round((CAPTURE_W - w) / 2);
  const dy = Math.round((CAPTURE_H - h) / 2);
  rgbaBuf.fill(0);
  for (let y = 0; y < CAPTURE_H; y++) {
    const sy = Math.floor((y - dy + 0.5) / scale);
    if (sy < 0 || sy >= sh) continue;
    for (let x = 0; x < CAPTURE_W; x++) {
      const sx = Math.floor((x - dx + 0.5) / scale);
      if (sx < 0 || sx >= sw) continue;
      const si = (sy * sw + sx) * 4;
      const di = (y * CAPTURE_W + x) * 4;
      rgbaBuf[di] = src[si];
      rgbaBuf[di + 1] = src[si + 1];
      rgbaBuf[di + 2] = src[si + 2];
      rgbaBuf[di + 3] = 255;
    }
  }
  let sig = '';
  for (let i = 0; i < rgbaBuf.length; i += 1024) sig += rgbaBuf[i] + ',';
  return { base64Jpeg: '', width: CAPTURE_W, height: CAPTURE_H, rgba: rgbaBuf, signature: sig, source: 'canvas.drawImage', fresh };
}

const stateBuf = new Uint8Array(5 + 0x20000);
stateBuf.set([0x52, 0x41, 0x4d, 0x3a, 0x3a], 0);
const RAM = 5;
function refreshRam(): void {
  stateBuf.set(host.readMemory('system_ram', 0, 0x20000).subarray(0, 0x20000), RAM);
}
// @ts-ignore
globalThis.window = {
  EJS_core: 'snes',
  EJS_emulator: {
    started: true,
    // @ts-ignore
    gameManager: { getState: async () => stateBuf, simulateInput: () => {} },
  },
};

const BTN: Record<string, string> = {
  B: 'b', Y: 'y', SELECT: 'select', START: 'start', UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right', A: 'a', X: 'x', L: 'l', R: 'r',
};
function applyKeys(keys: AIKey[]): void {
  const port: Record<string, boolean> = {};
  for (const k of keys) if (k !== 'NONE' && BTN[k]) port[BTN[k]] = true;
  host.setInput({ ports: [port] });
}
function step(n: number): void {
  for (let i = 0; i < n; i++) host.renderOneFrame();
}
function snap(tag: string): void {
  const { pngBase64 } = host.screenshot();
  fs.writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(pngBase64, 'base64'));
}
function u16(a: number): number {
  return stateBuf[RAM + a] | (stateBuf[RAM + a + 1] << 8);
}

const report: Record<string, unknown> = { notes: [] as string[] };

// ---- get to gameplay fast (same trick the agent uses: START then skip with X) -------------
let guard = 0;
while (u16(0x0998) !== 8 && guard++ < 4000) {
  refreshRam();
  const gs = u16(0x0998);
  if (gs === 2 || gs === 3) {
    applyKeys(['START']);
    step(6);
    applyKeys([]);
    step(14);
  } else {
    applyKeys(['X']);
    step(4);
    applyKeys([]);
    step(8);
  }
}
report.reachedInGameFrames = guard * 18;

const agent = new LocalVisionAgent();
agent.reset();

// ---- phase 1: let the agent drive until it locks up --------------------------------------
const STALL_TICKS = 320;
let tick = 0;
let lockRoom: number | null = null;
let lockX: number | null = null;
let sameCount = 0;
const agentLog: Array<Record<string, unknown>> = [];
let lastX = -1;
while (tick < 6000) {
  tick++;
  refreshRam();
  const wram = await readMetroidWram();
  const frame = captureFrame(tick % 2 === 1);
  let action: AIAction;
  try {
    action = agent.decide(frame, 'action', 'Super / Super Fácil', wram);
  } catch (e) {
    (report.notes as string[]).push(`agent threw: ${(e as Error).message}`);
    action = { key: 'NONE', keys: ['NONE'], time: 120, phase: 'run' } as AIAction;
  }
  const keys = action.keys && action.keys.length ? action.keys : [action.key];
  applyKeys(keys);
  const hold = Math.max(1, Math.round(Math.min(160, Math.max(90, action.time || 120)) / (1000 / 60)));
  step(hold);
  if (wram?.valid) {
    if (wram.samusX === lastX && wram.roomId === lockRoom) sameCount++;
    else {
      sameCount = 0;
      lockRoom = wram.roomId;
      lockX = wram.samusX;
    }
    lastX = wram.samusX;
    agentLog.push({ tick, room: wram.roomId, x: wram.samusX, y: wram.samusY, keys: keys.join('+'), reason: action.reason });
    if (sameCount >= STALL_TICKS && wram.gameState === 8 && wram.roomId > 0) break;
  }
}
report.agentStuckAt = { tick, room: lockRoom, x: lockX, sameTicks: sameCount };
snap('stuck');

// ---- phase 2: audit perception -----------------------------------------------------------
refreshRam();
const wram = await readMetroidWram();
const roomW = wram?.roomWidthBlocks ?? 0;
const roomH = wram?.roomHeightBlocks ?? 0;
const blockAt = (bx: number, by: number) => (wram?.blockTypes ? wram.blockTypes[by * roomW + bx] : -1);
const btsAt = (bx: number, by: number) => (wram?.btsBytes ? wram.btsBytes[by * roomW + bx] : -1);
report.rawWram = {
  gameState: u16(0x0998),
  roomId: u16(0x079b),
  areaIndex: u16(0x079f),
  roomDims: [u16(0x07a5), u16(0x07a7)],
  health: u16(0x09c2),
  maxHealth: u16(0x09c4),
  missiles: u16(0x09c6),
  maxMissiles: u16(0x09c8),
  reserveMax: u16(0x09d4),
  selectedHudItem: u16(0x09d2),
  itemsEquipped: '0x' + u16(0x09a2).toString(16),
  itemsMask: '0x' + u16(0x09a4).toString(16),
  beamsEquipped: '0x' + u16(0x09a6).toString(16),
  beamsMask: '0x' + u16(0x09a8).toString(16),
  samusXY: [u16(0x0af6), u16(0x0afa)],
  pose: u16(0x0a1c),
};
report.snapshot = wram
  ? {
      valid: wram.valid,
      roomId: wram.roomId,
      dims: [roomW, roomH],
      samus: [wram.samusX, wram.samusY],
      camera: [wram.cameraX, wram.cameraY],
      abilities: wram.abilities,
      enemies: wram.enemies.length,
      ignoredBg: wram.ignoredBackgroundEnemies,
      plms: wram.plms.map((p) => ({ id: '0x' + p.id.toString(16), bx: p.bx, by: p.by })),
      roomItems: wram.roomItems,
      doors: wram.doors.map((d) => ({ key: d.key, side: d.side, bx: d.bx, by: d.by, blockedByWall: d.blockedByWall, cap: d.capCount })),
      blockTypesAtSamus: (() => {
        const bx = Math.floor(wram.samusX / 16);
        const by = Math.floor(wram.samusY / 16);
        const out: Record<string, number> = {};
        for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0]] as const) {
          out[`${bx + dx},${by + dy}`] = blockAt(bx + dx, by + dy);
        }
        return out;
      })(),
      fakeBlockCandidate: { at: '0,23', type: blockAt(0, 23), bts: btsAt(0, 23) },
      blockTypeHistogram: (() => {
        const c: Record<string, number> = {};
        if (wram.blockTypes) for (let i = 0; i < wram.blockTypes.length; i++) c[wram.blockTypes[i]] = (c[wram.blockTypes[i]] || 0) + 1;
        return c;
      })(),
    }
  : null;
report.selfCorrections = agent.exportSelfCorrections();

// ---- phase 3: dumb macros against the same state ------------------------------------------
type Macro = { name: string; keys: AIKey[]; frames: number };
const MACROS: Macro[] = [
  { name: 'hold_RIGHT_30s', keys: ['RIGHT'], frames: 1800 },
  { name: 'RIGHT+run_30s', keys: ['RIGHT', 'X'], frames: 1800 },
  { name: 'RIGHT+jump_spam_30s', keys: ['RIGHT', 'A'], frames: 1800 },
  { name: 'RIGHT+jump+pulse_30s', keys: ['RIGHT'], frames: 1800 },
  { name: 'LEFT+jump_20s', keys: ['LEFT', 'A'], frames: 1200 },
  { name: 'morph_bomb_20s', keys: ['DOWN'], frames: 1200 },
  { name: 'shoot_LEFT_15s', keys: ['LEFT', 'B'], frames: 900 },
];
const macroResults: Array<Record<string, unknown>> = [];
for (const m of MACROS) {
  refreshRam();
  const before = { room: u16(0x079b), x: u16(0x0af6), y: u16(0x0afa), hp: u16(0x09c2) };
  let changedRoomAt = -1;
  let minX = before.x;
  let maxX = before.x;
  for (let f = 0; f < m.frames; f++) {
    // jump pulse: hold A every 12 frames for 10 frames
    if (m.name === 'RIGHT+jump_spam_30s' || m.name === 'RIGHT+jump+pulse_30s') {
      const jumping = f % 22 < 12;
      applyKeys(jumping ? ['RIGHT', 'A'] : ['RIGHT']);
    } else if (m.name === 'morph_bomb_20s') {
      // morph ball + bomb drop (DOWN twice then B), the user's "secret passage" recipe
      const phase = f % 40;
      applyKeys(phase < 8 ? ['DOWN'] : phase < 16 ? ['DOWN', 'B'] : []);
    } else {
      applyKeys(m.keys);
    }
    step(1);
    if (f % 30 === 0) {
      refreshRam();
      const x = u16(0x0af6);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      if (changedRoomAt < 0 && u16(0x079b) !== before.room) changedRoomAt = f;
    }
  }
  applyKeys([]);
  step(30);
  refreshRam();
  const after = { room: u16(0x079b), x: u16(0x0af6), y: u16(0x0afa), hp: u16(0x09c2) };
  macroResults.push({
    macro: m.name,
    before,
    after,
    roomChangedAfterFrames: changedRoomAt,
    xRange: [minX, maxX],
    escaped: after.room !== before.room,
  });
  snap(`macro_${m.name}`);
}
report.macros = macroResults;

fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT, 'agentLog.json'), JSON.stringify(agentLog.slice(-40), null, 2));
console.log(JSON.stringify(report, null, 2));
