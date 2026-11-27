/**
 * Simulação de NAVEGAÇÃO do agente em um mundo de várias salas (sem emulador).
 *
 *   npm run check:nav
 *
 * Diferente do bossAgentSim (uma sala só, foco na luta), aqui o que se verifica é o ciclo
 * "estou perdido → abrir o mapa do jogo (START) → ler a tela → fechar → seguir para onde o
 * mapa diz que há desconhecido", mais o reconhecimento de cor de porta e o "volta quando
 * tiver a munição". O mundo é pintado de verdade no frame sintético: o agente não recebe
 * nenhuma dica por fora — ele tem que ver o batente vermelho e a tela de mapa.
 */
import { LocalVisionAgent } from '../src/lib/localVisionAI';
import type { MetroidWramSnapshot, DoorInfo, EnemyInfo } from '../src/lib/snesWram';
import type { AIAction, AIKey, ArmorAnalysis, CapturedFrame } from '../src/types/emulator';

const W = 256;
const H = 224;
const FLOOR_Y = 120;
const DOOR_X = { LEFT: 10, RIGHT: 246 } as const;
const VALID_KEYS: AIKey[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT', 'NONE'];

type DoorColor = 'RED' | 'GREEN' | 'BLUE' | 'YELLOW' | 'PINK' | 'UNKNOWN';

interface SimDoor {
  side: 'LEFT' | 'RIGHT';
  to: number;
  color: DoorColor;
  closed: boolean;
}
interface SimItem {
  x: number;
  y: number;
  kind: 'MISSILE' | 'TANK' | 'SUPER';
}
interface SimRoom {
  id: number;
  doors: SimDoor[];
  items: SimItem[];
  bossHp?: number;
}

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

type RGB = [number, number, number];
const BG: RGB = [14, 16, 22];
const FLOOR: RGB = [96, 96, 104];
const ROSE: RGB = [210, 120, 190];
const MAP_BLUE: RGB = [40, 60, 170];
const WHITE: RGB = [255, 255, 255];
const DOOR_RGB: Record<DoorColor, RGB> = {
  RED: [205, 30, 30],
  GREEN: [40, 205, 60],
  BLUE: [50, 120, 220],
  YELLOW: [220, 200, 40],
  PINK: [220, 150, 200],
  UNKNOWN: [120, 120, 130],
};

function armor(): ArmorAnalysis {
  return {
    suitTier: 'Varia Suit',
    damageReductionPct: 0,
    thermalProtected: false,
    liquidMobility: false,
    effectiveHp: 199,
    energyTanks: 1,
    reserveEnergy: 0,
    reserveMax: 0,
    reserveMode: 'Desativado',
    collectedCount: 0,
    equippedCount: 0,
    totalPieces: 16,
    missingPieces: [],
    unequippedCollected: [],
    saxReadinessPct: 0,
    pieces: [],
  };
}

class World {
  rooms = new Map<number, SimRoom>();
  cur = 0x10;
  sx = 120;
  sy = FLOOR_Y;
  vy = 0;
  tick = 0;
  mapShown = false;
  startPresses = 0;
  missiles = 4;
  maxMissiles = 20;
  supers = 0;
  maxSupers = 0;
  bombs = 0;
  maxBombs = 0;
  health = 199;
  maxHealth = 199;
  itemsMask = 0;
  beamsMask = 0;
  selectedHudItem = 0;
  hatchShots = 0;
  missileShotsAtHatch = 0;

  room(id: number): SimRoom {
    let r = this.rooms.get(id);
    if (!r) {
      r = { id, doors: [], items: [] };
      this.rooms.set(id, r);
    }
    return r;
  }
  link(a: number, b: number, color: DoorColor, closed = false): void {
    this.room(a).doors.push({ side: 'RIGHT', to: b, color, closed });
    this.room(b).doors.push({ side: 'LEFT', to: a, color: 'PINK', closed: false });
  }
  private doorAt(side: 'LEFT' | 'RIGHT'): SimDoor | undefined {
    return this.room(this.cur).doors.find((d) => d.side === side);
  }

  /** onde a porta está na tela (camera = 0) */
  doorX(side: 'LEFT' | 'RIGHT'): number {
    return DOOR_X[side];
  }

  private baseGame: Uint8ClampedArray | null = null;
  private baseMap: Uint8ClampedArray | null = null;

  frame(): CapturedFrame {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const put = (x: number, y: number, c: RGB) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = 255;
    };
    const rect = (x0: number, y0: number, x1: number, y1: number, c: RGB) => {
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) put(x, y, c);
    };
    // fundo pronto: reaproveitar a base evita 57k chamadas de put() por tick
    if (!this.baseGame) {
      const b = new Uint8ClampedArray(W * H * 4);
      const bp = (x: number, y: number, c: RGB) => {
        const i = (y * W + x) * 4;
        b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = 255;
      };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bp(x, y, BG);
      for (let y = 128; y < H; y++) for (let x = 0; x < W; x++) bp(x, y, FLOOR);
      this.baseGame = b;
    }
    if (!this.baseMap) {
      const b = new Uint8ClampedArray(W * H * 4);
      const bp = (x: number, y: number, c: RGB) => {
        const i = (y * W + x) * 4;
        b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = 255;
      };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bp(x, y, [8, 10, 16]);
      // rosa = mapeado · azul = ainda desconhecido · ponto branco = Samus
      for (let y = 60; y <= 180; y++) for (let x = 10; x <= 110; x++) bp(x, y, ROSE);
      for (let y = 46; y <= 120; y++) for (let x = 150; x <= 248; x++) bp(x, y, MAP_BLUE);
      for (let y = 118; y <= 122; y++) for (let x = 88; x <= 92; x++) bp(x, y, WHITE);
      this.baseMap = b;
    }
    rgba.set(this.mapShown ? this.baseMap : this.baseGame);

    if (this.mapShown) {
      return { base64Jpeg: '', width: W, height: H, rgba: rgba as unknown as Uint8ClampedArray, signature: `map-${this.tick}`, source: 'canvas.drawImage', fresh: true };
    }
    // batentes pintados na cor real da comporta
    for (const d of this.room(this.cur).doors) {
      const x = this.doorX(d.side);
      rect(x - 7, FLOOR_Y - 6, x + 7, FLOOR_Y + 6, d.closed ? DOOR_RGB[d.color] : DOOR_RGB.PINK);
    }
    // itens brilham em dourado
    for (const it of this.room(this.cur).items) rect(it.x - 6, it.y - 6, it.x + 6, it.y + 6, [220, 180, 60]);
    // chefe (corpo grande, só para o teste de "não interromper a luta")
    if ((this.room(this.cur).bossHp ?? 0) > 0) rect(170, 90, 214, 134, [200, 40, 60]);
    // Samus
    rect(this.sx - 6, this.sy - 14, this.sx + 6, this.sy + 2, [230, 90, 60]);
    return { base64Jpeg: '', width: W, height: H, rgba: rgba as unknown as Uint8ClampedArray, signature: `w-${this.tick}`, source: 'canvas.drawImage', fresh: true };
  }

  wram(): MetroidWramSnapshot {
    const room = this.room(this.cur);
    const doors: DoorInfo[] = room.doors.map((d) => {
      const x = this.doorX(d.side);
      return {
        key: `${d.side}@${Math.floor(x / 16)}:7-${FLOOR_Y / 16}`,
        side: d.side,
        bx: Math.floor(x / 16),
        by: 7,
        x,
        y: FLOOR_Y,
        blockedByWall: d.closed,
        hasCapPlm: false,
        capCount: 0,
      };
    });
    const enemies: EnemyInfo[] = [];
    if ((room.bossHp ?? 0) > 0) {
      enemies.push({ slot: 0, id: 0x1234, x: 192, y: 112, xRadius: 22, yRadius: 22, hp: room.bossHp as number, props: 0, extraProps: 0, aiHandler: 0x8000 });
    }
    const blockTypes = new Uint8Array(16 * 14);
    for (let by = 8; by < 14; by += 1) for (let bx = 0; bx < 16; bx += 1) blockTypes[by * 16 + bx] = 0x8;
    return {
      valid: true,
      gameState: this.mapShown ? 9 : 8,
      roomId: this.cur,
      areaIndex: 1,
      roomWidthBlocks: 16,
      roomHeightBlocks: 14,
      roomWidthPx: W,
      roomHeightPx: H,
      cameraX: 0,
      cameraY: 0,
      health: this.health,
      maxHealth: this.maxHealth,
      reserveEnergy: 0,
      reserveMax: 0,
      reserveMode: 0,
      missiles: this.missiles,
      maxMissiles: this.maxMissiles,
      supers: this.supers,
      maxSupers: this.maxSupers,
      powerBombs: this.bombs,
      maxPowerBombs: this.maxBombs,
      selectedHudItem: this.selectedHudItem,
      itemsMask: this.itemsMask,
      itemsEquipped: this.itemsMask,
      beamsMask: this.beamsMask,
      beamsEquipped: this.beamsMask,
      abilities: [],
      armorAnalysis: armor(),
      samusX: Math.round(this.sx),
      samusY: Math.round(this.sy),
      pose: 0,
      facingDir: 1,
      menuScreen: this.mapShown ? 1 : 0,
      menuCursor: 0,
      controls: { shoot: 'X', jump: 'A', run: 'B', cancel: 'Y', select: 'SELECT', aimDown: 'L', aimUp: 'R' },
      enemies,
      ignoredBackgroundEnemies: 0,
      timerStatus: 0,
      countdownActive: false,
      countdownSeconds: 0,
      roomItems: room.items.map((it) => ({ plmId: it.kind === 'TANK' ? 0xeee2 : 0xeee0, x: it.x, y: it.y })),
      plms: [],
      doors,
      blockTypes,
      btsBytes: new Uint8Array(16 * 14),
    };
  }

  apply(action: AIAction): void {
    const keys = new Set<AIKey>(action.keys && action.keys.length > 0 ? action.keys : [action.key]);
    for (const k of keys) if (!VALID_KEYS.includes(k)) throw new Error(`tecla inválida emitida: ${k}`);
    this.tick++;

    // START abre/fecha o mapa do jogo; com o mapa na tela o jogo está pausado — nada se move
    if (keys.has('START')) {
      this.startPresses++;
      this.mapShown = !this.mapShown;
      return;
    }
    if (this.mapShown) return;

    if (keys.has('SELECT')) this.selectedHudItem = (this.selectedHudItem + 1) % 4;
    if (keys.has('Y')) this.selectedHudItem = 0;
    if (keys.has('RIGHT')) this.sx = Math.min(W - 8, this.sx + 5);
    if (keys.has('LEFT')) this.sx = Math.max(8, this.sx - 5);
    if (keys.has('A') && this.sy >= FLOOR_Y - 1) this.vy = -9;
    this.vy += 1.6;
    this.sy += this.vy;
    if (this.sy >= FLOOR_Y) {
      this.sy = FLOOR_Y;
      this.vy = 0;
    }

    // atirar na comporta fechada: cada cor tem seu preço, exatamente como no manual
    if (keys.has('X')) {
      for (const d of this.room_.doors) {
        if (!d.closed) continue;
        if (Math.abs(this.sx - this.doorX(d.side)) > 26) continue;
        this.hatchShots++;
        // míssil de verdade custa munição: conta e descontar (o feixe é grátis)
        if (this.selectedHudItem >= 1) {
          this.missileShotsAtHatch++;
          if (this.missiles > 0 && !((d.color === 'RED') && this.missiles < 5)) this.missiles = Math.max(0, this.missiles - 1);
        }
        if ((d.color === 'BLUE' || d.color === 'PINK' || d.color === 'UNKNOWN') && this.selectedHudItem === 0) d.closed = false;
        else if (d.color === 'RED' && this.selectedHudItem >= 1 && this.missiles >= 5) {
          d.closed = false;
          this.missiles -= 5;
        } else if (d.color === 'GREEN' && this.selectedHudItem >= 2 && this.supers >= 1) {
          d.closed = false;
          this.supers -= 1;
        } else if (d.color === 'YELLOW' && this.bombs >= 1) {
          d.closed = false;
          this.bombs -= 1;
        }
      }
    }

    // atravessar
    for (const d of this.room_.doors) {
      if (d.closed) continue;
      const x = this.doorX(d.side);
      if ((d.side === 'RIGHT' && this.sx >= x - 6) || (d.side === 'LEFT' && this.sx <= x + 6)) {
        const from = this.cur;
        this.cur = d.to;
        this.sx = d.side === 'RIGHT' ? 24 : W - 24;
        this.sy = FLOOR_Y;
        this.vy = 0;
        void from;
        break;
      }
    }

    // coletar
    const items = this.room(this.cur).items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (Math.abs(it.x - this.sx) > 14) continue;
      items.splice(i, 1);
      if (it.kind === 'MISSILE') {
        this.maxMissiles += 5;
        this.missiles += 5;
      } else if (it.kind === 'SUPER') {
        this.maxSupers += 5;
        this.supers += 5;
      } else {
        this.maxHealth += 100;
        this.health = this.maxHealth;
      }
    }
  }

  get room_(): SimRoom {
    return this.room(this.cur);
  }
}

interface Run {
  agent: LocalVisionAgent;
  world: World;
  actions: AIAction[];
}

function run(world: World, ticks: number, log: (t: number, a: AIAction) => void = () => {}): Run {
  const agent = new LocalVisionAgent();
  const actions: AIAction[] = [];
  for (let t = 0; t < ticks; t++) {
    const action = agent.decide(world.frame(), 'action', 'Difícil', world.wram());
    actions.push(action);
    log(t, action);
    world.apply(action);
  }
  return { agent, world, actions };
}

const ks = (a: AIAction): AIKey[] => (a.keys && a.keys.length > 0 ? a.keys : [a.key]);
const snap = (a: AIAction) => a.snapshot;
const nav = (a: AIAction) => snap(a)?.mapExploration;

const DUMP = process.env.DUMP ?? '';

/* =========================================================== A. perdido → mapa */
section('A. Perdido → consultar o mapa do jogo (START) e seguir o desconhecido');
{
  const w = new World();
  w.link(0x10, 0x20, 'PINK');
  const seen: string[] = [];
  const { actions } = run(w, 2000, (t, a) => {
    if (DUMP === 'a' && t % 200 === 0) {
      const n = nav(a);
      seen.push(`[${t}] ${a.sceneLabel} lost=${n?.lost} sev=${n?.lostSeverity} dir=${n?.preferredDirection} cover=${n?.mapRead?.coveragePct ?? '-'}`);
    }
  });
  if (seen.length > 0) console.log(seen.join('\n'));
  const lostTick = actions.findIndex((a) => nav(a)?.lost === true);
  const startPresses = actions.filter((a) => ks(a).includes('START')).length;
  const readOk = actions.some((a) => nav(a)?.mapRead?.ok === true);
  const last = actions[actions.length - 1]!;
  let maxMenuRun = 0;
  let run0 = 0;
  for (const a of actions) {
    if ((a.sceneLabel ?? '').startsWith('Mapa')) {
      run0++;
      maxMenuRun = Math.max(maxMenuRun, run0);
    } else run0 = 0;
  }

  check('detecta que está perdido (oscilação entre 2 salas)', lostTick >= 0, `primeiro tick perdido: ${lostTick}`);
  check('aperta START para abrir o mapa', startPresses > 0, `START x${startPresses}`);
  check('não fica segurando o mapa aberto (abre e fecha em ≤ 24 ticks)', maxMenuRun <= 24, `máx ${maxMenuRun} ticks`);
  check('não spam: leitura com moderação em 2000 ticks', startPresses <= 12, `${startPresses} pressionamentos`);
  check('a tela de mapa foi lida de verdade (pixels)', readOk);
  check('cobertura do mapa registrada no snapshot', (nav(last)?.mapRead?.coveragePct ?? 0) > 0, `cov=${nav(last)?.mapRead?.coveragePct}`);
  check('hint do mapa vira preferência de direção (RIGHT: azul à direita)', nav(last)?.preferredDirection === 'RIGHT', `dir=${nav(last)?.preferredDirection}`);
  check('as duas salas ficaram no grafo', (nav(last)?.roomsExplored ?? 0) >= 2, `salas=${nav(last)?.roomsExplored}`);

  check('a consulta não travou a exploração (o agente anda de verdade)', actions.filter((a) => ks(a).includes('RIGHT') || ks(a).includes('LEFT')).length > 700, `${actions.filter((a) => ks(a).includes('RIGHT') || ks(a).includes('LEFT')).length} ticks andando`);
  check('o mapa não ficou na tela no fim da corrida', !w.mapShown);
}

/* ================================================== B. comporta vermelha → voltar */
section('B. Comporta vermelha: não gasta agora, volta quando tiver munição');
{
  const w = new World();
  const right = { side: 'RIGHT' as const, to: 0x30, color: 'RED' as const, closed: true };
  w.room(0x10).doors.push(right);
  w.room(0x30).doors.push({ side: 'LEFT', to: 0x10, color: 'PINK', closed: false });
  w.room(0x30).items.push({ x: 130, y: FLOOR_Y - 4, kind: 'MISSILE' });

  const first = run(w, 500);
  const colors = nav(first.actions[first.actions.length - 1]!)?.currentRoomDoors ?? [];
  check('reconheceu a cor vermelha da comporta olhando o frame', colors.some((d) => d.color === 'RED' && d.key.startsWith('RIGHT')), colors.map((c) => `${c.key}:${c.color}`).join(','));
  check('com porta vermelha sem 5 mísseis, a sala do outro lado fica por abrir', w.cur === 0x10 && right.closed, `sala=0x${w.cur.toString(16)} closed=${right.closed} tiros=${w.hatchShots}`);
  check('não queima munição em comporta que não pode abrir', w.missileShotsAtHatch <= 6 && w.missiles >= 0, `${w.missileShotsAtHatch} mísseis gastos, resta ${w.missiles}`);

  // "e depois volta quando tiver a habilidade necessária"
  w.missiles = 50;
  w.maxMissiles = 50;
  const after = run(w, 500);
  const lastSnap = nav(after.actions[after.actions.length - 1]!);
  check('com munição, a porta trancada volta a ser candidata', !right.closed, `closed=${right.closed} tiros=${w.hatchShots}`);
  check('atravessou e coletou a expansão do outro lado', w.cur === 0x30 || w.room(0x30).items.length === 0, `sala=0x${w.cur.toString(16)} itens=${w.room(0x30).items.length}`);
  check('capacidade subiu com a coleta (55 = 11 expansões)', w.maxMissiles === 55, `cap=${w.maxMissiles}`);
  const missileRow = lastSnap?.checklist.find((c) => c.id === 'missiles');
  check('checklist mostra 11/46 expansões de míssil', missileRow?.have === 11, `${missileRow?.have}/${missileRow?.total}`);
  check('resumo do checklist presente no snapshot', (lastSnap?.checklistSummary ?? '').length > 5, lastSnap?.checklistSummary ?? 'vazio');
}

/* ==================================================== C. item → objetivo real */
section('C. Item conhecido em sala vizinha vira objetivo com rota');
{
  const w = new World();
  w.link(0x10, 0x20, 'PINK');
  w.room(0x20).items.push({ x: 200, y: FLOOR_Y - 4, kind: 'TANK' });
  const { actions } = run(w, 200);
  const targetTicks = actions.filter((a) => nav(a)?.target?.kind === 'ITEM').length;
  check('o plano escolhe a sala com item como alvo', targetTicks > 0, `${targetTicks} ticks com alvo ITEM`);
  check(
    'na sala sem mapa, o alvo é a fronteira pela porta RIGHT',
    actions.some((a) => {
      const n = nav(a);
      return snap(a)?.roomId === 0x10 && n?.target?.kind === 'FRONTIER' && String(n.target.firstDoor ?? '').startsWith('RIGHT');
    }),
  );
  check('chegou e pegou o tanque de energia', w.maxHealth === 299, `vida máx ${w.maxHealth}`);
  check('tanque registrado no checklist (2 de 14)', (nav(actions[actions.length - 1]!)?.checklist.find((c) => c.id === 'energy-tanks')?.have ?? 0) === 2);
}

/* ================================================== D. chefe vivo não interrompe */
section('D. Com chefe na sala, nada de abrir o mapa no meio da luta');
{
  const w = new World();
  w.link(0x10, 0x20, 'PINK');
  w.room(0x10).bossHp = 900;
  w.room(0x20).bossHp = 900; // o mundo inteiro tem chefe: nenhuma sala é "limpa" para ler mapa
  const { actions } = run(w, 500);
  const starts = actions.filter((a) => ks(a).includes('START')).length;
  check('nenhum START com chefe vivo na tela', starts === 0, `${starts} pressionamentos`);
  check('luta priorizada (modo de combate/observação do chefe)', actions.some((a) => a.snapshot?.bossFight !== undefined) || actions.some((a) => (a.sceneLabel ?? '').includes('Chefe') || (a.sceneLabel ?? '').includes('Combate')));
}

console.log(
  failures.length === 0
    ? `\n\x1b[1m\x1b[32mSIMULAÇÃO DE NAVEGAÇÃO OK\x1b[0m  · ${passed} verificações\n`
    : `\n\x1b[1m\x1b[31m${failures.length} FALHA(S)\x1b[0m  · ${passed + failures.length} verificações\n\nFalhas:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
