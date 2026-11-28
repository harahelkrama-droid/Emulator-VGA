// Headless playtest harness for RetroPlay's local AI agent.
//
// Why this exists: the agent loop lives in the browser (EmulatorPlayer + EmulatorJS),
// so measuring "how does the platform AI behave over a long session" needs a harness
// that reproduces that loop outside the browser:
//
//   snes9x (WASM libretro core, romdev-core-host)  ->  256x224 RGB frame
//        |                                                     |
//        |  input: RetroPad bits                letterbox 240x160 (same as emulatorBridge)
//        v                                                     v
//   host.setInput({ports:[...]})  <-  AIAction.keys  <-  LocalVisionAgent.decide(frame, profile, diff, wram)
//
// The WRAM snapshot is produced by the app's own `readMetroidWram()`, which is handed a
// save-state blob with the EmulatorJS "RAM:" marker pointing at the core's 128 KB WRAM.
// Nothing in the agent is stubbed or re-implemented: same decide(), same keys, same cadence
// (the app sleeps 90-160 ms between decisions, so we hold the buttons for the equivalent
// number of emulated frames, ~5-10).
//
// Usage:
//   npx tsx playtest/aiPlaytest.ts                # 25 minutes of game time (default)
//   GAME_MINUTES=5 SNAPSHOT_EVERY=600 npx tsx playtest/aiPlaytest.ts
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - untyped CJS/ESM mix from the romdev host package
import { LibretroHost } from 'romdev-core-host';
// @ts-ignore
import * as snesPlatform from 'romdev-platform-snes';
import { LocalVisionAgent } from '../src/lib/localVisionAI';
import { readMetroidWram } from '../src/lib/snesWram';
import type { AIAction, AIKey, CapturedFrame } from '../src/types/emulator';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROM = path.join(ROOT, 'public/games/Super Metroid.sfc');
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(ROOT, 'playtest/out');
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
fs.mkdirSync(FRAMES_DIR, { recursive: true });

const GAME_MINUTES = Number(process.env.GAME_MINUTES || 25);
const FRAME_MS = 1000 / 60;
const TARGET_FRAMES = Math.round(GAME_MINUTES * 60 * 60);
const SNAPSHOT_EVERY = Number(process.env.SNAPSHOT_EVERY || 1800); // ~30 s of game time
const MENU_BUDGET_TICKS = Number(process.env.MENU_BUDGET_TICKS || 320); // ~60 s for the agent to escape the title on its own
const AI_PROFILE = (process.env.AI_PROFILE || 'action') as 'action' | 'rpg';
const TARGET_DIFF = process.env.TARGET_DIFF || 'Super / Super Fácil';

// --- EmulatorJS-shaped host on top of the WASM core --------------------------------------
// @ts-ignore
const host = new LibretroHost({ log: () => {} });
await host.loadCore(snesPlatform.core.jsPath, snesPlatform.core.wasmPath);
await host.loadMedia({ platform: 'snes', path: ROM });

// the app now captures at the core's native size (see CAPTURE_W in emulatorBridge): the
// 240x160 letterbox used to burn 29/28 columns of black into the analysis grid (finding F10).
const CAPTURE_W = 256;
const CAPTURE_H = 224;
let rgbaBuf = new Uint8ClampedArray(CAPTURE_W * CAPTURE_H * 4);

function captureFrame(fresh: boolean): CapturedFrame {
  const shot = host.screenshotRgba();
  const src: Uint8ClampedArray | Uint8Array = shot.rgba;
  const sw = shot.width as number;
  const sh = shot.height as number;
  const scale = Math.min(CAPTURE_W / sw, CAPTURE_H / sh);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const dx = Math.round((CAPTURE_W - w) / 2);
  const dy = Math.round((CAPTURE_H - h) / 2);
  rgbaBuf.fill(0);
  for (let y = 0; y < CAPTURE_H; y++) {
    let sy = Math.floor((y - dy + 0.5) / scale);
    if (sy < 0) continue;
    if (sy >= sh) break;
    for (let x = 0; x < CAPTURE_W; x++) {
      let sx = Math.floor((x - dx + 0.5) / scale);
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
  return {
    base64Jpeg: '',
    width: CAPTURE_W,
    height: CAPTURE_H,
    rgba: rgbaBuf,
    signature: sig,
    source: 'canvas.drawImage',
    fresh,
  };
}

// save-state blob in the shape readMetroidWram() expects from EmulatorJS
const stateBuf = new Uint8Array(5 + 0x20000);
stateBuf.set([0x52, 0x41, 0x4d, 0x3a, 0x3a], 0); // "RAM::"
function readRamIntoState(): void {
  try {
    const ram = host.readMemory('system_ram', 0, 0x20000);
    stateBuf.set(ram.subarray(0, 0x20000), 5);
  } catch {
    /* core not ready */
  }
}

// @ts-ignore
globalThis.window = {
  // @ts-ignore
  EJS_core: 'snes',
  EJS_emulator: {
    started: true,
    paused: false,
    // @ts-ignore
    gameManager: {
      getState: async () => stateBuf,
      simulateInput: () => {},
      screenshot: async () => {
        throw new Error('harness uses screenshotRgba directly');
      },
    },
  },
};

const RETRO_BUTTON: Record<Exclude<AIKey, 'NONE'>, string> = {
  B: 'b',
  Y: 'y',
  SELECT: 'select',
  START: 'start',
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  A: 'a',
  X: 'x',
  L: 'l',
  R: 'r',
};

function applyKeys(keys: AIKey[]): void {
  const port: Record<string, boolean> = {};
  for (const k of keys) {
    if (k === 'NONE') continue;
    const b = RETRO_BUTTON[k as Exclude<AIKey, 'NONE'>];
    if (b) port[b] = true;
  }
  host.setInput({ ports: [port] });
}

function step(n: number): void {
  for (let i = 0; i < n; i++) host.renderOneFrame();
}

// --- logging ------------------------------------------------------------------------------
const jsonlPath = path.join(OUT_DIR, 'session.jsonl');
const eventsPath = path.join(OUT_DIR, 'events.jsonl');
fs.writeFileSync(jsonlPath, '');
fs.writeFileSync(eventsPath, '');
let jsonlBuf = '';
let eventsBuf = '';
let frameIdx = 0;
let startedWall = Date.now();

function emitEvent(e: Record<string, unknown>): void {
  eventsBuf += JSON.stringify({ t: Math.round(frameIdx / 60), ...e }) + '\n';
}

function maybeSnapshot(): void {
  if (SNAPSHOT_EVERY <= 0 || frameIdx % SNAPSHOT_EVERY !== 0) return;
  try {
    const { pngBase64 } = host.screenshot();
    fs.writeFileSync(path.join(FRAMES_DIR, `g${String(Math.round(frameIdx / 60)).padStart(4, '0')}s.png`), Buffer.from(pngBase64, 'base64'));
  } catch {
    /* ignore */
  }
}

function wramPeek(): { gameState: number; health: number; roomId: number; menuScreen: number } {
  readRamIntoState();
  const base = 5;
  const u16 = (a: number) => stateBuf[base + a] | (stateBuf[base + a + 1] << 8);
  return { gameState: u16(0x0998), health: u16(0x09c2), roomId: u16(0x079b), menuScreen: stateBuf[base + 0x00d1] ?? 0 };
}

// --- phase A: can the agent get itself out of the title screen? ---------------------------
const agent = new LocalVisionAgent();
agent.reset();

const runLog: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  rom: path.basename(ROM),
  core: 'snes9x (romdev-core-host, WASM libretro)',
  agent: 'src/lib/localVisionAI.ts LocalVisionAgent.decide()',
  profile: AI_PROFILE,
  targetDifficulty: TARGET_DIFF,
  targetGameMinutes: GAME_MINUTES,
  capture: `${CAPTURE_W}x${CAPTURE_H} letterboxed from 256x224`,
};

emitEvent({ kind: 'RUN_START', ...runLog });

let tick = 0;
let decisionMsTotal = 0;
let phase: 'MENU_AGENT' | 'MENU_SCRIPTED' | 'RUN' = 'MENU_AGENT';
let lastHealth = -1;
let lastRoom = -1;
let deaths = 0;

// scripted menu escape (what a human does: Enter on title, Enter/A on file select)
async function scriptedStart(budgetTicks: number): Promise<boolean> {
  for (let i = 0; i < budgetTicks; i++) {
    const p = wramPeek();
    if (p.gameState === 8) return true;
    const cycle = i % 8;
    // tap START, and once in a while also A (confirm) / UP (cursor)
    if (cycle === 0) {
      applyKeys(['START']);
      step(6);
      applyKeys([]);
      step(10);
    } else if (cycle === 3) {
      applyKeys(['A']);
      step(6);
      applyKeys([]);
      step(10);
    } else if (cycle === 5) {
      applyKeys(['UP']);
      step(4);
      applyKeys([]);
      step(6);
    } else {
      step(12);
    }
    frameIdx += 12;
  }
  return wramPeek().gameState === 8;
}

let tickWall = Date.now();
while (frameIdx < TARGET_FRAMES) {
  tick++;
  readRamIntoState();
  const wram = await readMetroidWram();
  const frameFresh = tick % 2 === 1; // emulate the app's frame cache (maxCacheAgeMs)
  const frame = captureFrame(frameFresh);
  const t0 = Date.now();
  let action: AIAction;
  try {
    action = agent.decide(frame, AI_PROFILE, TARGET_DIFF, wram);
  } catch (err) {
    emitEvent({ kind: 'AGENT_THROW', tick, message: (err as Error).message, stack: ((err as Error).stack || '').split('\n').slice(0, 4).join(' | ') });
    action = { key: 'NONE', keys: ['NONE'], time: 120, phase: 'run', reason: 'exception' } as AIAction;
  }
  const decisionMs = Date.now() - t0;
  decisionMsTotal += decisionMs;

  const keys = action.keys && action.keys.length > 0 ? action.keys : [action.key];

  if (phase === 'MENU_AGENT') {
    if (wram && wram.valid && wram.gameState === 8) {
      phase = 'RUN';
      emitEvent({ kind: 'PHASE', tick, phase: 'RUN', note: 'agente saiu do menu sozinho' });
    } else if (tick >= MENU_BUDGET_TICKS) {
      phase = 'MENU_SCRIPTED';
      emitEvent({ kind: 'PHASE', tick, phase: 'MENU_SCRIPTED', note: `agente nao saiu do menu em ${tick} ticks` });
      const ok = await scriptedStart(4000);
      if (!ok) {
        emitEvent({ kind: 'FATAL', tick, note: 'menu nao superado nem pelo roteiro de start' });
        break;
      }
      phase = 'RUN';
      emitEvent({ kind: 'PHASE', tick: tickWall = Date.now(), phase: 'RUN', note: 'start aplicado por macro' });
      continue;
    }
  }

  if (wram && wram.valid) {
    if (lastHealth >= 0 && wram.health < lastHealth) {
      emitEvent({
        kind: 'DAMAGE',
        tick,
        from: lastHealth,
        to: wram.health,
        room: wram.roomId,
        area: wram.areaIndex,
        x: wram.samusX,
        y: wram.samusY,
        mode: action.snapshot?.mode,
        reason: action.reason,
      });
    }
    if (wram.health === 0 && lastHealth > 0) {
      deaths++;
      emitEvent({ kind: 'DEATH', tick, room: wram.roomId, mode: action.snapshot?.mode });
    }
    lastHealth = wram.health;
    if (wram.roomId !== lastRoom) {
      emitEvent({ kind: 'ROOM', tick, from: lastRoom, to: wram.roomId, area: wram.areaIndex, mode: action.snapshot?.mode });
      lastRoom = wram.roomId;
    }
  }

  applyKeys(keys);
  // same cadence contract as EmulatorPlayer: floor is one frame (17 ms), not 90 ms — that
  // floor is what made a short hop physically unexpressible (finding F5).
  const holdMs = Math.min(160, Math.max(17, action.time || 120));
  const holdFrames = Math.max(1, Math.round(holdMs / FRAME_MS));
  step(holdFrames);
  frameIdx += holdFrames;
  maybeSnapshot();

  const snap = action.snapshot;
  const mapx = snap?.mapExploration;
  const boss = snap?.bossFight;
  const rec = {
    tick,
    f: frameIdx,
    gms: Math.round(frameIdx * FRAME_MS),
    phase,
    fresh: frameFresh,
    dms: decisionMs,
    mode: snap?.mode,
    label: snap?.behaviorLabel,
    scene: snap?.sceneLabel,
    reason: snap?.reason,
    keys: keys.join('+'),
    holdFrames,
    hp: wram?.valid ? wram.health : null,
    hpMax: wram?.valid ? wram.maxHealth : null,
    room: wram?.valid ? wram.roomId : null,
    area: wram?.valid ? wram.areaIndex : null,
    x: wram?.valid ? wram.samusX : null,
    y: wram?.valid ? wram.samusY : null,
    gs: wram?.valid ? wram.gameState : null,
    pose: wram?.valid ? wram.pose : null,
    face: wram?.valid ? wram.facingDir : null,
    camX: wram?.valid ? wram.cameraX : null,
    camY: wram?.valid ? wram.cameraY : null,
    hud: wram?.valid ? wram.selectedHudItem : null,
    rsv: wram?.valid ? wram.reserveEnergy : null,
    st: wram?.valid ? wram.roomWidthBlocks : null,
    sb: wram?.valid ? wram.roomHeightBlocks : null,
    en: wram?.valid ? wram.enemies.length : null,
    ig: wram?.valid ? wram.ignoredBackgroundEnemies : null,
    doors: wram?.valid ? wram.doors.length : null,
    plm: wram?.valid ? wram.plms.length : null,
    items: wram?.valid ? wram.roomItems.length : null,
    mis: wram?.valid ? wram.missiles : null,
    sup: wram?.valid ? wram.supers : null,
    pb: wram?.valid ? wram.powerBombs : null,
    abil: wram?.valid ? wram.abilities.length : null,
    lost: mapx?.lost ?? false,
    lostCause: mapx?.lostCause ?? null,
    lostSev: mapx?.lostSeverity ?? 0,
    cover: mapx ? Math.round((mapx.mapRead?.coveragePct ?? 0) * 10) / 10 : null,
    targetKind: mapx?.target?.kind ?? null,
    target: mapx?.target?.label ?? null,
    route: mapx?.target?.route?.length ?? 0,
    backlog: mapx?.backlog?.length ?? 0,
    hazard: mapx?.floorHazard ?? null,
    corr: mapx?.corrections?.length ?? 0,
    stuck: snap?.interaction?.stuckInRoomTicks ?? 0,
    rooms: mapx?.roomsExplored ?? 0,
    boss: boss ? `${boss.bossName}/${boss.role}/${boss.ammoLabel}${boss.windowOpen ? '/WIN' : ''}/dmg${boss.damageDealt}` : null,
    cd: wram?.valid && wram.countdownActive ? wram.countdownSeconds : null,
  };
  jsonlBuf += JSON.stringify(rec) + '\n';

  if (tick % 60 === 0) {
    fs.appendFileSync(jsonlPath, jsonlBuf);
    fs.appendFileSync(eventsPath, eventsBuf);
    jsonlBuf = '';
    eventsBuf = '';
    const wallS = (Date.now() - startedWall) / 1000;
    const gameS = frameIdx / 60;
    process.stdout.write(
      `[tick ${tick}] game=${gameS.toFixed(0)}s wall=${wallS.toFixed(1)}s x${(gameS / wallS).toFixed(1)} ` +
        `mode=${rec.mode} keys=${rec.keys} hp=${rec.hp}/${rec.hpMax} room=${rec.room} x=${rec.x} ` +
        `dec=${(decisionMsTotal / tick).toFixed(2)}ms :: ${(rec.reason || '').slice(0, 90)}\n`,
    );
  }
}

fs.appendFileSync(jsonlPath, jsonlBuf);
fs.appendFileSync(eventsPath, eventsBuf);

// final state dump for the report
const finalPeek = wramPeek();
const summary = {
  ...runLog,
  ticks: tick,
  frames: frameIdx,
  gameSeconds: Math.round(frameIdx / 60),
  wallSeconds: Math.round((Date.now() - startedWall) / 1000),
  avgDecisionMs: Math.round((decisionMsTotal / tick) * 100) / 100,
  deaths,
  phase,
  finalPeek,
  selfCorrections: agent.exportSelfCorrections(),
};
fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
process.stdout.write('\n' + JSON.stringify(summary, null, 2) + '\n');
