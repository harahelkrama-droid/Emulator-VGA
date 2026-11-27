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
  side: 'LEFT' | 'RIGHT' | 'UP';
  to: number;
  color: DoorColor;
  closed: boolean;
  /** posição em px para portas verticais */
  x?: number;
  y?: number;
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
  /** lava pintada mas INOFENSIVA: é assim que se prova o falso-positivo de paleta (a IA tem
   * que descobrir sozinha que aquele vermelho é cenário, não lago) */
  lavaHarmless?: boolean;
  /** Metroid que atravessa a sala — a IA tem que ESCOLTAR, não atirar nele */
  /** `big` = Metroid Grande (o do evento de dreno); sem ele é o ômega/larva que atravessa */
  metroid?: { x: number; y: number; vx: number; big?: boolean };
  /** linha (em blocos) onde a lava começa e a coluna onde ela existe à direita; `rgb`
   * permite pintar uma paleta que NENHUM tier do detector conhece — é assim que se testa a
   * autocorreção (a IA tem que descobrir o corte sozinha, depois de apanhar) */
  lava?: { topRow: number; fromBx: number; rgb?: RGB; bubble?: RGB };
  /** linha do "chão" em px (o bloco abaixo é sólido no mapa) */
  floorY?: number;
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
  /** contagem regressiva do evento (a IA tem que treating o tempo como recurso) */
  countdownActive = false;
  itemsMask = 0;
  beamsMask = 0;
  selectedHudItem = 0;
  hatchShots = 0;
  missileShotsAtHatch = 0;

  room(id: number): SimRoom {
    let r = this.rooms.get(id);
    if (!r) {
      r = { id, doors: [], items: [], floorY: FLOOR_Y };
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
  doorX(d: SimDoor): number {
    return d.x ?? DOOR_X[d.side as 'LEFT' | 'RIGHT'];
  }
  doorY(d: SimDoor): number {
    return d.y ?? this.room(this.cur).floorY ?? FLOOR_Y;
  }
  inLava(sx: number, sy: number): boolean {
    const lava = this.room(this.cur).lava;
    if (!lava) return false;
    if (this.room(this.cur).lavaHarmless) return false;
    return sy >= (lava.topRow - 1) * 16 && Math.floor(sx / 16) >= lava.fromBx;
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
      const x = this.doorX(d);
      const y = this.doorY(d);
      rect(x - 7, y - 6, x + 7, y + 6, d.closed ? DOOR_RGB[d.color] : DOOR_RGB.PINK);
    }
    // lago de lava: a partir da linha indicada, à direita da coluna indicada
    const lake = this.room(this.cur).lava;
    if (lake) {
      for (let y = lake.topRow * 16; y < H; y += 1) {
        for (let x = lake.fromBx * 16; x < W; x += 1) {
          const bubble = ((x * 7 + y * 13) % 41) < 6;
          put(x, y, bubble ? lake.bubble ?? [250, 168, 70] : lake.rgb ?? [240, 120, 40]);
        }
      }
    }
    // itens brilham em dourado
    for (const it of this.room(this.cur).items) rect(it.x - 6, it.y - 6, it.x + 6, it.y + 6, [220, 180, 60]);
    // chefe (corpo grande, só para o teste de "não interromper a luta")
    if ((this.room(this.cur).bossHp ?? 0) > 0) rect(170, 90, 214, 134, [200, 40, 60]);
    // Metroid atravessando a sala: anel verde-neon com núcleo vermelho (a assinatura que o
    // detector de entidade especial lê)
    const met = this.room(this.cur).metroid;
    if (met) {
      const ax = met.big ? 24 : 18;
      const ay = met.big ? 22 : 16;
      for (let y = -ay; y <= ay; y++) {
        for (let x = -ax; x <= ax; x++) {
          const d = Math.hypot(x / ax, y / ay);
          if (d > 1.05) continue;
          put(Math.round(met.x) + x, Math.round(met.y) + y, d > 0.55 ? [70, 225, 96] : [222, 42, 58]);
        }
      }
    }
    // Samus
    rect(this.sx - 6, this.sy - 14, this.sx + 6, this.sy + 2, [230, 90, 60]);
    return { base64Jpeg: '', width: W, height: H, rgba: rgba as unknown as Uint8ClampedArray, signature: `w-${this.tick}`, source: 'canvas.drawImage', fresh: true };
  }

  wram(): MetroidWramSnapshot {
    const room = this.room(this.cur);
    const doors: DoorInfo[] = room.doors.map((d) => {
      const x = this.doorX(d);
      const y = this.doorY(d);
      return {
        key: `${d.side}@${Math.floor(x / 16)}:${Math.floor(y / 16)}`,
        side: d.side,
        bx: Math.floor(x / 16),
        by: Math.floor(y / 16),
        x,
        y,
        blockedByWall: d.closed,
        hasCapPlm: false,
        capCount: 0,
      };
    });
    const enemies: EnemyInfo[] = [];
    const met = this.room(this.cur).metroid;
    if (met) {
      const rad = met.big ? 22 : 20;
      enemies.push({ slot: 7, id: 0x2ae, x: Math.round(met.x), y: Math.round(met.y), xRadius: rad, yRadius: rad, hp: met.big ? 120 : 400, props: 0, extraProps: 0, aiHandler: 0x8000 });
    }
    if ((room.bossHp ?? 0) > 0) {
      enemies.push({ slot: 0, id: 0x1234, x: 192, y: 112, xRadius: 22, yRadius: 22, hp: room.bossHp as number, props: 0, extraProps: 0, aiHandler: 0x8000 });
    }
    // o mapa de blocos acha que o lago é chão sólido: é exatamente assim que a lava se
    // comporta no Super Metroid, e é por isso que o detector precisa olhar o frame
    const blockTypes = new Uint8Array(16 * 14);
    const floorRow = Math.floor((room.floorY ?? FLOOR_Y) / 16) + 1;
    for (let by = floorRow; by < 14; by += 1) for (let bx = 0; bx < 16; bx += 1) blockTypes[by * 16 + bx] = 0x8;
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
      countdownActive: this.countdownActive,
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
    const fy = this.room(this.cur).floorY ?? FLOOR_Y;
    if (keys.has('A') && this.sy >= fy - 1) this.vy = this.room(this.cur).doors.some((d) => d.side === 'UP') ? -13 : -9;
    const underOpenUp = this.room_.doors.some(
      (d) => d.side === 'UP' && !d.closed && Math.abs(this.doorX(d) - this.sx) < 22,
    );
    if (keys.has('UP') && underOpenUp) this.sy = Math.max(24, this.sy - 6);
    this.vy += 1.6;
    this.sy += this.vy;
    if (this.sy >= fy) {
      this.sy = fy;
      this.vy = 0;
    }
    // o Metroid segue o roteiro dele: atravessa a sala e sai pelo batente
    const metRoom = this.room(this.cur).metroid;
    if (metRoom) {
      metRoom.x += metRoom.vx;
      if (metRoom.x < -30 || metRoom.x > W + 30) this.room(this.cur).metroid = undefined;
    }

    // pisar na lava dói (e é isto que o agente tem que evitar); com Gravity Suit é só um
    // esquentado — o mesmo contrato do jogo real
    if (this.inLava(this.sx, this.sy + 6)) {
      const grav = (this.itemsMask & 0x0020) !== 0;
      this.health = Math.max(1, this.health - (grav ? 1 : 25));
    }

    // atirar na comporta fechada: cada cor tem seu preço, exatamente como no manual
    if (keys.has('X')) {
      for (const d of this.room_.doors) {
        if (!d.closed) continue;
        if (Math.abs(this.sx - this.doorX(d)) > 26) continue;
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
      const x = this.doorX(d);
      if (d.side === 'UP') {
        // porta do teto: precisa estar embaixo, com UP pressionado e altura suficiente
        if (Math.abs(this.sx - x) < 18 && this.sy <= (d.y ?? 60) + 26 && keys.has('UP')) {
          this.cur = d.to;
          this.sx = x;
          this.sy = this.room(this.cur).floorY ?? FLOOR_Y;
          this.vy = 0;
          return;
        }
        continue;
      }
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

function run(
  world: World,
  ticks: number,
  log: (t: number, a: AIAction, agent: LocalVisionAgent) => void = () => {},
): Run {
  const agent = new LocalVisionAgent();
  agent.menuArmAfterTicks = 0; // nestes cenários o portão de 3 min não é o objeto do teste
  const actions: AIAction[] = [];
  for (let t = 0; t < ticks; t++) {
    const action = agent.decide(world.frame(), 'action', 'Difícil', world.wram());
    actions.push(action);
    log(t, action, agent);
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


/* =========================================== E. sala cercada por lava (screenshot) */
section('E. Lava no chão: não andar para dentro, procurar a saída vertical');
{
  // Reproduz a forma da sala do print: Samus numa saliência, o lago ocupando o resto do
  // "chão" (que o mapa de blocos jura que é sólido) e a saída sendo uma porta PARA CIMA.
  const w = new World();
  const ledge = w.room(0x10);
  ledge.floorY = 144;
  ledge.lava = { topRow: 10, fromBx: 8 };
  ledge.doors.push({ side: 'UP', to: 0x11, color: 'PINK', closed: false, x: 72, y: 74 });
  const above = w.room(0x11);
  above.floorY = FLOOR_Y;
  above.items.push({ x: 150, y: FLOOR_Y - 6, kind: 'TANK' });
  const { actions } = run(w, 480);
  const inLedgeRoom = actions.filter((a) => (a.reason ?? '').includes('0x10'));
  const n = nav(inLedgeRoom[0] ?? actions[actions.length - 1]!);
  const hpWhilePinned = actions.map((a) => a.snapshot?.health ?? 199);
  const sawLavaReason = actions.some((a) => (a.reason ?? '').includes('lava') || (a.sceneLabel ?? '').includes('lava'));
  check('o lago foi reconhecido do frame', n?.floorHazard === 'LAVA', `hazard=${n?.floorHazard} topRow=${n?.lavaTopRow}`);
  check('linha da surface registrada (>= 9)', (n?.lavaTopRow ?? -1) >= 9 && (n?.lavaTopRow ?? 99) <= 12, `row=${n?.lavaTopRow}`);
  check('a vida nunca caiu enquanto na sala de lava', Math.min(...hpWhilePinned.slice(0, 20)) >= 199, `min-vida=${Math.min(...hpWhilePinned)}`);
  check('o motivo das ações explica a beira de lava', sawLavaReason);
  check('subiu pela porta superior e saiu da sala', w.cur === 0x11, `sala=0x${w.cur.toString(16)}`);
  check('chegou ao tanque de energia da sala de cima', w.maxHealth === 299 || w.room(0x11).items.length === 0, `vida máx=${w.maxHealth} itens=${w.room(0x11).items.length}`);
}

/* =============================================== F. lava sem saída: não se matar */
section('F. Lava cercada, sala sem saída vertical: parar em vez de morrer');
{
  const w = new World();
  const trap = w.room(0x10);
  trap.floorY = 144;
  trap.lava = { topRow: 10, fromBx: 9 };
  const { actions } = run(w, 1400);
  const n = nav(actions[actions.length - 1]!);
  check('não morreu andando na lava (vida >= 190)', w.health >= 190, `vida=${w.health}`);
  check('ficou na sala, preso na beirada (não teletransportou)', w.cur === 0x10, `sala=0x${w.cur.toString(16)}`);
  check('declarou-se perdido (o que libera a consulta de mapa)', (n?.lostSeverity ?? 0) >= 1, `sev=${n?.lostSeverity} causa=${n?.lostCause}`);
  check('tentou a leitura do mapa em vez de só andar de um lado para o outro', actions.some((a) => ks(a).includes('START')));
}

/* ============================== G. comporta no teto sobre a lava: atirar para cima */
section('G. Porta do teto FECHADA sobre o lago: atirar nela e pular');
{
  const w = new World();
  const ledge = w.room(0x10);
  ledge.floorY = 144;
  ledge.lava = { topRow: 10, fromBx: 8 };
  ledge.doors.push({ side: 'UP', to: 0x11, color: 'RED', closed: true, x: 72, y: 74 });
  w.missiles = 20;
  const above = w.room(0x11);
  above.items.push({ x: 150, y: FLOOR_Y - 6, kind: 'TANK' });
  const { actions } = run(w, 600);
  const opened = ledge.doors.every((d) => !d.closed);
  const hpMin = Math.min(...actions.map((a) => a.snapshot?.health ?? 199));
  check('selecionou míssil no HUD', actions.some((a) => ks(a).includes('SELECT')), 'SELECT nunca apareceu');
  check('atirou PARA CIMA na comporta', actions.some((a) => (a.reason ?? '').includes('atirando para cima')));
  // no simulador cada disparo também custa 1 míssil, além dos 5 da abertura: 20 → 14-15
  check('pagou o preço da porta vermelha', w.missiles >= 14 && w.missiles <= 15, `restam ${w.missiles}, tiros=${w.missileShotsAtHatch}`);
  check('a comporta abriu', opened);
  check('subiu por ela e saiu da sala', w.cur === 0x11, `sala=0x${w.cur.toString(16)}`);
  check('a vida nunca caiu (lava intacta)', hpMin >= 199, `min=${hpMin}`);
}

/* ==================== H. Gravity Suit: lava vira chão — atravessa com pulos em cadeia */
section('H. Gravity Suit + Space Jump: atravessa o lago em vez de evitar');
{
  const w = new World();
  w.itemsMask = 0x0020 | 0x0200; // Gravity Suit + Space Jump
  const lakeRoom = w.room(0x10);
  lakeRoom.floorY = 144;
  lakeRoom.lava = { topRow: 10, fromBx: 5 };
  lakeRoom.doors.push({ side: 'RIGHT', to: 0x21, color: 'PINK', closed: false });
  w.room(0x21).items.push({ x: 150, y: FLOOR_Y - 6, kind: 'MISSILE' });
  const { actions } = run(w, 400);
  const n = nav(actions[0]!);
  const jumps = actions.filter((a) => ks(a).includes('A')).length;
  check('com a suit, nenhuma célula de lava é vetada', n?.floorHazard === 'NONE', `hazard=${n?.floorHazard}`);
  check('atravessou o lago até a porta direita', w.cur === 0x21, `sala=0x${w.cur.toString(16)}`);
  check('pegou a expansão do outro lado', w.room(0x21).items.length === 0);
  check('usou pulo em cadeia sobre a lava (space jump)', jumps >= 3, `${jumps} pulos`);
  check('o custo foi o de raspão, não morte', w.health >= 140 && w.health <= 198, `vida=${w.health}`);
}

/* ============ I. menu só depois de 3 min do load (ou logo após carregar um Save) ============ */
section('I. Portão do menu: 3 minutos após o load, ou a permissão de um save');
{
  const buildTrapWorld = () => {
    const w = new World();
    const trap = w.room(0x10);
    trap.floorY = 144;
    trap.lava = { topRow: 10, fromBx: 9 };
    return w;
  };
  // (1) portão por tempo
  {
    const w = buildTrapWorld();
    const agent: any = new LocalVisionAgent();
    agent.menuArmAfterTicks = 300; // "3 minutos" encolhidos para caber no teste
    let firstStart = -1;
    let panRight = false;
    let panLeft = false;
    for (let t = 0; t < 700; t++) {
      const a = agent.decide(w.frame(), 'action', 'Difícil', w.wram());
      if (firstStart < 0 && ks(a).includes('START')) firstStart = t;
      if ((a.sceneLabel ?? '').includes('área à direita')) panRight = true;
      if ((a.sceneLabel ?? '').includes('área à esquerda')) panLeft = true;
      w.apply(a);
    }
    check('antes do tempo, o START nunca aparece', firstStart >= 300, `primeiro START no tick ${firstStart}`);
    check('abre o menu assim que o tempo fecha', firstStart >= 300 && firstStart < 420, `tick ${firstStart}`);
    check('varre direita e esquerda procurando a habilidade', panRight && panLeft, `→=${panRight} ←=${panLeft}`);
    check('fecha o mapa de novo', !w.mapShown);
  }
  // (2) carregar um save dá permissão imediata
  {
    const w = buildTrapWorld();
    const agent: any = new LocalVisionAgent();
    agent.menuArmAfterTicks = 1_000_000; // "nunca" por tempo
    let firstStart = -1;
    for (let t = 0; t < 560; t++) {
      if (t === 400) agent.noteSaveStateLoaded();
      const a = agent.decide(w.frame(), 'action', 'Difícil', w.wram());
      if (firstStart < 0 && ks(a).includes('START')) firstStart = t;
      w.apply(a);
    }
    check('save carregado libera o menu na hora', firstStart >= 400 && firstStart < 460, `tick ${firstStart}`);
  }
}

/* ============ J. autocorreção: paleta que nenhum tier conhece, descoberta apanhando ============ */
section('J. Lava de paleta DESCONHECIDA: a IA descobre o corte sozinha e para de andar nela');
{
  // #aa2222 (r=170) está abaixo do corte calibrado à mão (r>185) e fora do laranja clássico:
  // no primeiro passo o detector NÃO vê nada — é exatamente a situação do print do usuário,
  // com a diferença que aqui ninguém mexe no código. Bolhas #e8b060 existem (a estrutura do
  // poço continua sendo a de um lago), só o corpo é escuro demais para o threshold fixo.
  const w = new World();
  const room = w.room(0x10);
  room.floorY = 144;
  room.lava = { topRow: 10, fromBx: 8, rgb: [170, 34, 34], bubble: [232, 176, 96] };
  const { actions } = run(w, 700);
  const snap = (i: number) => actions[i]?.snapshot?.mapExploration;
  const firstHazard = actions.findIndex((a) => a.snapshot?.mapExploration?.floorHazard === 'LAVA');
  const firstDamage = actions.findIndex((a) => (a.snapshot?.health ?? 199) < 199);
  const corrected = actions.find((a) => (a.snapshot?.mapExploration?.corrections?.length ?? 0) > 0);
  const rec = corrected?.snapshot?.mapExploration?.corrections?.[0];
  const calib = actions[actions.length - 1]?.snapshot?.mapExploration?.lavaCalib;
  check('o detector cego no início (nenhum lago reconhecido antes do dano)', firstHazard < 0 || firstDamage < firstHazard, `dano=${firstDamage} lava=${firstHazard}`);
  check('o dano aconteceu (é o rótulo do erro)', firstDamage >= 0, `tick=${firstDamage}`);
  check('a IA registrou o próprio erro', !!rec && rec.kind === 'LAVA_UNSIGHTED', rec ? `${rec.kind}` : 'nenhuma correção');
  check('o diagnóstico cita as cores medidas do frame', /#[0-9a-f]{6}/i.test(rec?.diagnosis ?? ''), rec?.diagnosis ?? '');
  check('a calibração adotada é DERIVADA, não a fixa', !!calib && calib.minRed !== 185 && calib.minRed >= 150 && calib.minRed <= 214, `r>${calib?.minRed}`);
  check('depois da correção o lago passa a ser reconhecido', firstHazard >= 0 && firstDamage >= 0 && firstHazard > firstDamage && firstHazard - firstDamage <= 3, `Δ=${firstHazard - firstDamage}`);
  const tail = actions.slice(-120);
  const hpTail = tail.map((a) => a.snapshot?.health ?? 999);
  check('e a vida para de cair (saiu do lago)', Math.min(...hpTail) === Math.max(...hpTail), `${Math.min(...hpTail)}→${Math.max(...hpTail)}`);
  check('não ficou andando para dentro: terminou fora da lava', w.sx < 8 * 16, `x=${Math.round(w.sx)}`);
  check('a revisão classificou a correção', rec?.status === 'ACTIVE' || rec?.status === 'HELPED', rec?.status);
  console.log(`    \x1b[2m↳ ${rec?.diagnosis}\n      ↳ ${rec?.action}\x1b[0m`);
}

/* ========== K0. Metroid Grande: dreno só no prólogo; depois do resgate, seguir em frente */
section('K0. Evento do Metroid Grande: deixar drenar e NÃO ficar esperando depois');
{
  // (1) prólogo: o dreno é o roteiro — ela tem que IR para o contato, não fugir;
  // (2) passado o resgate, o bicho é boletim: o que vale é a próxima coisa da lista.
  const mk = () => {
    const w = new World();
    w.health = 60;
    w.maxHealth = 99;
    w.countdownActive = true;
    const room = w.room(0x10);
    room.floorY = 144;
    room.metroid = { x: 200, y: 128, vx: 0, big: true };
    w.sx = 110;
    w.sy = 144;
    return w;
  };

  const prologue = mk();
  prologue.room(0x10).items.push({ x: 240, y: 138, kind: 'MISSILE' });
  const r1 = run(prologue, 120);
  const closedIn = Math.abs((prologue.room(0x10).metroid?.x ?? 0) - prologue.sx);
  check('no prólogo ela NÃO foge do Metroid Grande', !r1.actions.some((a) => (a.reason ?? '').includes('fugir')), 'sem fuga');
  check('ela fecha para o contato (o dreno é por toque)', closedIn < 110, `distância=${Math.round(closedIn)}`);
  check(
    'o motivo diz que ela está SEGUINDO o bicho (e não atirando nele)',
    r1.actions.some((a) => /dreno|escolt|acompanh/i.test(`${a.reason ?? ''} ${a.sceneLabel ?? ''}`)),
    r1.actions[r1.actions.length - 1]?.sceneLabel,
  );
  check(
    'sem bala gasta no Metroid (ele não morre sem gelo)',
    !r1.actions.some((a) => (a.keys ?? []).some((k) => k === 'X') || a.key === 'X'),
  );

  const after = mk();
  // já saiu do estado "prólogo" (tem o lançador de mísseis): o bicho deixa de ser o ROTEIRO
  // e passa a ser só um dado do quadro — o que vale é o item parado na sala
  after.itemsMask = 0x0001;
  after.room(0x10).items.push({ x: 60, y: 138, kind: 'MISSILE' });
  // t=4: o resgate do prólogo aconteceu (o codex marca o heal); o que vem depois é o teste
  const r2 = run(after, 300, (t, _a, agent) => {
    if (t === 4) (agent as unknown as { bigMetroidHealedTick: number }).bigMetroidHealedTick = 4;
  });
  const idle = r2.actions.filter((a) => !ks(a).some((k) => k === 'LEFT' || k === 'RIGHT' || k === 'UP' || k === 'DOWN')).length;
  check('depois do resgate ela não fica parada ao lado do bicho', idle < r2.actions.length * 0.35, `${idle}/${r2.actions.length} ticks parado`);
  check('volta a buscar o item da sala (tempo é recurso)', after.room(0x10).items.length === 0, `itens=${after.room(0x10).items.length}`);
}

/* ============ K. falso-positivo de paleta: vermelho de cenário não é lago ============ */
section('K. "Lava" que não machuca: ela descobre pisando e para de vetar o chão');
{
  // A paleta do print do usuário enganou o detector numa sala SEM lava (estrutura carmim
  // idêntica à do poço). Se o veto não puder ser desmentido, a IA fica parada na beira para
  // sempre — é o "está confusa, não consegue avançar". Aqui o chão é pintado como lava mas
  // não causa dano: a prova negativa tem que derrubar o veto.
  const w = new World();
  const room = w.room(0x10);
  room.floorY = 144;
  room.lava = { topRow: 9, fromBx: 6 };
  room.lavaHarmless = true;
  room.items.push({ x: 214, y: 138, kind: 'MISSILE' });
  // ela COMEÇA em cima do "lago": é assim que o chão do print aparece — vermelhíssimo sob os
  // próprios pés, com o veto ligado
  w.sx = 140;
  w.sy = 144;
  const { actions } = run(w, 520);
  const first = nav(actions[0]!);
  const last = nav(actions[actions.length - 1]!);
  check('no começo o detector vê o "lago" (é o engano real)', first?.floorHazard === 'LAVA', `hazard=${first?.floorHazard}`);
  check('o veto chegou a travar o caminho (lava citada nas ações)', actions.some((a) => /lava/i.test(a.reason ?? '')));
  check('pisar sem dano derruba o veto da sala', last?.floorHazard === 'NONE', `hazard=${last?.floorHazard}`);
  check('e ela pega o item do outro lado', w.room(0x10).items.length === 0, `itens=${w.room(0x10).items.length}`);
  const rec = last?.corrections?.find((c) => c.kind === 'HAZARD_FALSE_POSITIVE');
  check('o caderno registra o falso-positivo como erro MEU', Boolean(rec), JSON.stringify(last?.corrections?.map((c) => c.kind) ?? []));
  const atVetoOff = actions.findIndex((a) => a.snapshot?.mapExploration?.floorHazard === 'NONE');
  check('e isso acontece cedo (segundos, não um minuto parado)', atVetoOff > 0 && atVetoOff < 300, `tick=${atVetoOff}`);
}

/* ============ L. Metroid atravessando a sala: escoltar, não atirar ============ */
section('L. Metroid na sala: seguir o bicho até a saída em vez de gastar a run');
{
  // O relato: "fica muito tempo ali acabando perdendo o tempo por bobagem em vez de seguir o
  // ômega metroid". O Metroid atravessa a sala para a direita, pela porta aberta; a IA tem que
  // IR ATRÁS dele, sem atirar (matar Metroid exige Ice Beam + míssil, e ela não tem aqui).
  const w = new World();
  const room = w.room(0x10);
  room.floorY = 144;
  room.metroid = { x: 150, y: 120, vx: 0.8 };
  room.doors.push({ side: 'RIGHT', to: 0x21, color: 'PINK', closed: false });
  const missilesBefore = w.missiles;
  const { actions } = run(w, 460);
  const escorting = actions.filter((a) => /scolt/i.test(a.reason ?? ''));
  check('reconheceu o Metroid e entrou em modo de escolta', escorting.length > 20, `${escorting.length} ticks`);
  check('o motivo diz para seguir, não para atirar', escorting.some((a) => /sa\u00edda|escolt/i.test(a.reason ?? '')));
  check('atravessou a porta atrás dele', w.cur === 0x21, `sala=0x${w.cur.toString(16)}`);
  check('sem gastar munição no bicho', w.missiles === missilesBefore, `${missilesBefore}→${w.missiles}`);
  check('e sem tiroteio de mob no caminho', !actions.some((a) => /atirando para cima/i.test(a.reason ?? '')));
  const leftAt = actions.findIndex((a) => a.snapshot?.sceneLabel?.includes('Escoltando'));
  check('não ficou parado esperando: começou a andar na hora', leftAt >= 0 && leftAt < 30, `tick=${leftAt}`);
}

console.log(
  failures.length === 0
    ? `\n\x1b[1m\x1b[32mSIMULAÇÃO DE NAVEGAÇÃO OK\x1b[0m  · ${passed} verificações\n`
    : `\n\x1b[1m\x1b[31m${failures.length} FALHA(S)\x1b[0m  · ${passed + failures.length} verificações\n\nFalhas:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
