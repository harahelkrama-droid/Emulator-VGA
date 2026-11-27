/**
 * Simulação do agente contra uma WRAM sintética (sem emulador).
 *
 *   npm run check:agent
 *
 * O objetivo é validar o *wiring* do Codex de Chefes dentro do `LocalVisionAgent`:
 * reconhecimento → diretiva → teclas. Para isso há um modelo de física de brinquedo:
 * a Samus anda/pula, o slot do HUD cicla com SELECT e o HP do chefe só cai quando a
 * janela de vulnerabilidade está aberta — janela esta que o cenário controla pintando a
 * cor do ponto frato no frame. Assim nada é "mágico": o agente tem que *sentir* a abertura.
 */
import { LocalVisionAgent } from '../src/lib/localVisionAI';
import type { MetroidWramSnapshot, EnemyInfo, DoorInfo } from '../src/lib/snesWram';
import type { AIAction, AIKey, ArmorAnalysis, CapturedFrame } from '../src/types/emulator';

const W = 256;
const H = 224;
const VALID_KEYS: AIKey[] = ['UP','DOWN','LEFT','RIGHT','A','B','X','Y','L','R','START','SELECT','NONE'];

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

type RGB = [number, number, number];
const PALETTE: Record<string, RGB> = {
  dark: [16, 18, 24],
  red: [200, 20, 20],
  gold: [220, 180, 60],
  purple: [140, 40, 180],
  yellowGreen: [150, 160, 40],
  silverCyan: [180, 200, 220],
  orange: [220, 120, 40],
  neonGreen: [60, 220, 60],
};

interface SimEnemy {
  slot: number;
  id: number;
  x: number;
  y: number;
  xRadius: number;
  yRadius: number;
  hp: number;
  maxHp: number;
  bodyColor: string;
  coreColor: string;
  /** move-se (chefe móvel) ou fica enraizado */
  mobile: boolean;
  wallHugging?: boolean;
}

interface SimConfig {
  name: string;
  bossHp: number;
  /** raio da hitbox em px (o codex vê diâmetro = 2×raio) */
  bossSpan: [number, number];
  /** cor do corpo (assinatura do chefe) e do ponto fraco (só visível com a janela aberta) */
  bossBody: string;
  bossCore: string;
  mobile: boolean;
  /** janela de vulnerabilidade: fixa, alterna por tick, ou só abre depois de N ticks */
  window: 'always' | 'never' | 'alternate' | { after: number };
  loadout?: Partial<SimLoadout>;
  extraStatics?: number;
  samusStart?: [number, number];
  bossX?: number;
}

interface SimLoadout {
  missiles: number;
  supers: number;
  selectedHudItem: number;
  itemsMask: number;
  beamsMask: number;
  beamsEquipped: number;
  maxHealth: number;
  health: number;
}

const DEFAULT_LOADOUT: SimLoadout = {
  missiles: 40,
  supers: 10,
  selectedHudItem: 0,
  itemsMask: 0x0004 | 0x1000 | 0x0100 | 0x0200, // morph + bombs + hi-jump + space jump
  beamsMask: 0x1000 | 0x0008 | 0x0002, // charge + plasma + ice
  beamsEquipped: 0x1000 | 0x0008,
  maxHealth: 399,
  health: 300,
};

function armor(): ArmorAnalysis {
  return {
    suitTier: 'Varia Suit',
    damageReductionPct: 50,
    thermalProtected: true,
    liquidMobility: false,
    effectiveHp: 600,
    energyTanks: 3,
    reserveEnergy: 0,
    reserveMax: 0,
    reserveMode: 'Desativado',
    collectedCount: 8,
    equippedCount: 8,
    totalPieces: 16,
    missingPieces: [],
    unequippedCollected: [],
    saxReadinessPct: 60,
    pieces: [],
  };
}

class Sim {
  name: string;
  tick = 0;
  samusX: number;
  samusY = 120;
  vy = 0;
  floorY = 120;
  loadout: SimLoadout;
  boss: SimEnemy;
  statics: SimEnemy[] = [];
  windowMode: SimConfig['window'];
  damageFrames: number[] = [];
  actions: AIAction[] = [];
  bossHitThisTick = false;

  constructor(cfg: SimConfig) {
    this.name = cfg.name;
    this.samusX = cfg.samusStart?.[0] ?? 60;
    this.samusY = cfg.samusStart?.[1] ?? 120;
    this.floorY = this.samusY;
    this.loadout = { ...DEFAULT_LOADOUT, ...(cfg.loadout ?? {}) };
    this.windowMode = cfg.window;
    this.boss = {
      slot: 0,
      id: 0x1234,
      x: cfg.bossX ?? 180,
      y: this.samusY,
      xRadius: cfg.bossSpan[0],
      yRadius: cfg.bossSpan[1],
      hp: cfg.bossHp,
      maxHp: cfg.bossHp,
      bodyColor: cfg.bossBody,
      coreColor: cfg.bossCore,
      mobile: cfg.mobile,
    };
    for (let i = 0; i < (cfg.extraStatics ?? 0); i++) {
      this.statics.push({
        slot: 20 + i,
        id: 0x90 + i,
        x: i % 2 === 0 ? 12 : W - 12,
        y: 100 + i * 8,
        xRadius: 8,
        yRadius: 8,
        hp: 30,
        maxHp: 30,
        bodyColor: 'silverCyan',
        coreColor: 'silverCyan',
        mobile: false,
        wallHugging: true,
      });
    }
  }

  windowOpen(): boolean {
    if (this.windowMode === 'always') return true;
    if (this.windowMode === 'never') return false;
    if (this.windowMode === 'alternate') return this.tick % 20 < 8;
    return this.tick >= this.windowMode.after;
  }

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
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        rgba[i] = 16;
        rgba[i + 1] = 18;
        rgba[i + 2] = 24;
        rgba[i + 3] = 255;
      }
    }
    const paint = (e: SimEnemy) => {
      // corpo inteiro
      const body = PALETTE[e.bodyColor] ?? PALETTE.dark;
      const rx = Math.max(6, Math.round(e.xRadius * 1.25));
      const ry = Math.max(6, Math.round(e.yRadius * 1.25));
      for (let y = e.y - ry; y <= e.y + ry; y += 1) {
        for (let x = e.x - rx; x <= e.x + rx; x += 1) put(Math.round(x), Math.round(y), body);
      }
      // ponto fraco: só aparece com a janela aberta (é isto que o agente precisa sentir)
      if (this.windowOpen() && e.slot === 0) {
        const core = PALETTE[e.coreColor] ?? PALETTE.dark;
        const crx = Math.round(rx * 0.45);
        const cry = Math.round(ry * 0.45);
        for (let y = e.y - cry; y <= e.y + cry; y += 1) {
          for (let x = e.x - crx; x <= e.x + crx; x += 1) put(Math.round(x), Math.round(y), core);
        }
      }
    };
    paint(this.boss);
    for (const s of this.statics) paint(s);
    return {
      base64Jpeg: '',
      width: W,
      height: H,
      rgba: rgba as unknown as Uint8ClampedArray,
      signature: `sim-${this.tick}`,
      source: 'canvas.drawImage',
      fresh: true,
    };
  }

  wram(): MetroidWramSnapshot {
    const enemies: EnemyInfo[] = [];
    const all = [this.boss, ...this.statics].filter((e) => e.hp > 0);
    for (const e of all) {
      enemies.push({
        slot: e.slot,
        id: e.id,
        x: e.x,
        y: e.y,
        xRadius: e.xRadius,
        yRadius: e.yRadius,
        hp: e.hp,
        props: 0,
        extraProps: 0,
        aiHandler: 0x8000,
      });
    }
    const doors: DoorInfo[] = [
      { key: 'LEFT', side: 'LEFT', bx: 0, by: 7, x: 8, y: 120, blockedByWall: false, hasCapPlm: false, capCount: 0 },
      { key: 'RIGHT', side: 'RIGHT', bx: 15, by: 7, x: 248, y: 120, blockedByWall: false, hasCapPlm: false, capCount: 0 },
    ];
    const blockTypes = new Uint8Array(16 * 14).fill(0x8);
    for (let by = 1; by < 13; by++) {
      for (let bx = 1; bx < 15; bx++) blockTypes[by * 16 + bx] = 0;
    }
    return {
      valid: true,
      gameState: 8,
      roomId: 0x2a,
      areaIndex: 1,
      roomWidthBlocks: 16,
      roomHeightBlocks: 14,
      roomWidthPx: W,
      roomHeightPx: H,
      cameraX: 0,
      cameraY: 0,
      health: this.loadout.health,
      maxHealth: this.loadout.maxHealth,
      reserveEnergy: 0,
      reserveMax: 0,
      reserveMode: 0,
      missiles: this.loadout.missiles,
      maxMissiles: 40,
      supers: this.loadout.supers,
      maxSupers: 10,
      powerBombs: 3,
      maxPowerBombs: 6,
      selectedHudItem: this.loadout.selectedHudItem,
      itemsMask: this.loadout.itemsMask,
      itemsEquipped: this.loadout.itemsMask,
      beamsMask: this.loadout.beamsMask,
      beamsEquipped: this.loadout.beamsEquipped,
      abilities: ['Morph Ball', 'Bombs', 'Hi-Jump', 'Space Jump', 'Charge', 'Plasma', 'Ice'],
      armorAnalysis: armor(),
      samusX: Math.round(this.samusX),
      samusY: Math.round(this.samusY),
      pose: 0,
      facingDir: 1,
      menuScreen: 0,
      menuCursor: 0,
      controls: { shoot: 'X', jump: 'A', run: 'B', cancel: 'Y', select: 'SELECT', aimDown: 'L', aimUp: 'R' },
      enemies,
      ignoredBackgroundEnemies: 0,
      timerStatus: 0,
      countdownActive: false,
      countdownSeconds: 0,
      roomItems: [],
      plms: [],
      doors,
      blockTypes,
      btsBytes: new Uint8Array(16 * 14),
    };
  }

  /** Aplica as teclas ao modelo de brinquedo. */
  apply(action: AIAction): void {
    const keys = new Set<AIKey>(action.keys && action.keys.length > 0 ? action.keys : [action.key]);
    for (const k of keys) {
      if (!VALID_KEYS.includes(k)) throw new Error(`tecla inválida emitida: ${k}`);
    }
    if (keys.has('RIGHT')) this.samusX = Math.min(W - 8, this.samusX + 3);
    if (keys.has('LEFT')) this.samusX = Math.max(8, this.samusX - 3);
    if (keys.has('A')) {
      if (this.samusY >= this.floorY - 1) this.vy = -6;
    }
    this.vy += this.samusY < this.floorY || this.vy < 0 ? 1.6 : 0;
    this.samusY += this.vy;
    if (this.samusY >= this.floorY) {
      this.samusY = this.floorY;
      this.vy = 0;
    }
    // SELECT cicla o item do HUD; Y volta ao feixe.
    if (keys.has('SELECT')) this.loadout.selectedHudItem = ((this.loadout.selectedHudItem + 1) % 4) as 0 | 1 | 2 | 3;
    if (keys.has('Y')) this.loadout.selectedHudItem = 0;

    const shooting = keys.has('X');
    if (shooting) {
      // Só fere com a janela aberta: é assim que o modelo premia o timing certo.
      if (this.windowOpen()) {
        const heavy = this.loadout.selectedHudItem === 1 || this.loadout.selectedHudItem === 2;
        const dmg = heavy ? 14 : 4;
        if (this.boss.hp > 0) this.boss.hp = Math.max(0, this.boss.hp - dmg);
        if (this.loadout.selectedHudItem === 1) this.loadout.missiles = Math.max(0, this.loadout.missiles - 1);
        if (this.loadout.selectedHudItem === 2) this.loadout.supers = Math.max(0, this.loadout.supers - 1);
        this.damageFrames.push(this.tick);
      }
    }
    // chefe móvel anda de verdade, senão fica enraizado
    if (this.boss.mobile) this.boss.x = Math.max(40, Math.min(W - 30, this.boss.x + (this.tick % 2 === 0 ? 2 : -2)));
    // estáticos encostados na parede: um tick simula Samus atirando e derrubando após 60 ticks
    for (const s of this.statics) {
      if (s.wallHugging && this.tick === 60) s.hp = 0;
    }
  }

  run(agent: LocalVisionAgent, ticks: number, cfgName = ''): void {
    void cfgName;
    this.actions = [];
    for (let i = 0; i < ticks; i++) {
      this.tick += 1;
      const wram = this.wram();
      const frame = this.frame();
      const action = agent.decide(frame, 'action', 'Normal', wram);
      this.actions.push(action);
      if (process.env.DUMP && (this.name === process.env.DUMP || process.env.DUMP === 'all')) {
        const bf = action.snapshot?.bossFight;
        console.log(
          `    [${this.tick}] mode=${action.snapshot?.mode} strat=${bf?.strategyId ?? '-'} ammo=${bf?.ammo ?? '-'} ` +
          `win=${bf?.windowOpen ? 'O' : 'c'} fire=${bf?.mayFire ? 'y' : 'n'} keys=[${(action.keys ?? [action.key]).join(',')}] ` +
          `hud=${this.loadout.selectedHudItem} mis=${this.loadout.missiles} sup=${this.loadout.supers} bossHp=${this.boss.hp} x=${Math.round(this.samusX)} why=${action.reason ?? action.snapshot?.reason ?? ''} ent=${action.snapshot?.detectedEntityLabel ?? '-'}`,
        );
      }
      this.apply(action);
    }
  }
}

const agent = new LocalVisionAgent();

console.log('\n\x1b[1mA. Luta começa de fato (sem a conferência de menu no meio)\x1b[0m');
{
  const sim = new Sim({
    name: 'torizo-always',
    bossHp: 600,
    bossSpan: [16, 18],
    bossBody: 'gold',
    bossCore: 'orange',
    mobile: false,
    window: 'always',
  });
  agent.reset();
  sim.run(agent, 30);
  const modes = sim.actions.map((a) => a.snapshot?.mode);
  const combat = modes.filter((m) => m === 'COMBAT').length;
  check('agente entra em COMBAT (não fica em MENU andando para o lado)', combat > 5, `${combat}/30 ticks em COMBAT`);
  const bossFight = sim.actions.map((a) => a.snapshot?.bossFight).filter(Boolean);
  check('snapshot traz o estado da luta do codex', bossFight.length > 5, `${bossFight.length}`);
  check('reconheceu um chefe enraizado dourado (Torizo)', bossFight.some((b) => b!.strategyId === 'torizo'), String(bossFight[0]?.strategyId));
  const times = sim.actions.map((a) => a.time);
  check('tempo por tick dentro do previsto', Math.min(...times) >= 90 && Math.max(...times) <= 220, `${Math.min(...times)}..${Math.max(...times)}`);
  check('HP do chefe caiu (o agente está de fato acertando)', sim.boss.hp < 600, `hp ${sim.boss.hp}`);
  check(
    'todas as teclas emitidas são válidas',
    sim.actions.every((a) => [...(a.keys ?? [a.key])].every((k) => VALID_KEYS.includes(k))),
  );
}

console.log('\n\x1b[1mB. Timing: não queima munição com a janela fechada\x1b[0m');
{
  const sim = new Sim({
    name: 'spore-closed',
    bossHp: 600,
    bossSpan: [26, 22],
    bossBody: 'yellowGreen',
    bossCore: 'orange',
    mobile: false,
    window: 'never',
    loadout: { missiles: 40, supers: 10 },
  });
  agent.reset();
  sim.run(agent, 60);
  const supersAfter = sim.loadout.supers;
  check('Super Mísseis preservados (casco fechado o tempo todo)', supersAfter >= 8, `supers ${supersAfter}/10`);
  const roles = new Set(sim.actions.map((a) => a.snapshot?.bossFight?.role));
  check('papel da luta é SETUP (preparação) enquanto fechado', roles.has('SETUP'), [...roles].join(','));
  check('Samus foi para o canto da sala', sim.samusX < 40 || sim.samusX > W - 40, `x=${Math.round(sim.samusX)}`);

  const openSim = new Sim({
    name: 'spore-open',
    bossHp: 600,
    bossSpan: [26, 22],
    bossBody: 'yellowGreen',
    bossCore: 'orange',
    mobile: false,
    window: { after: 20 },
  });
  agent.reset();
  openSim.run(agent, 70);
  check('abriu o casco → HP caiu', openSim.boss.hp < 600, `hp ${openSim.boss.hp}`);
  const firedAfterOpen = openSim.actions.slice(20).some((a) => (a.keys ?? [a.key]).includes('X'));
  check('passa a atirar quando a janela abre', firedAfterOpen);
}

console.log('\n\x1b[1mC. Regras duras do guia respeitadas pelo agente\x1b[0m');
{
  // Phantoon: NUNCA pode parar no slot de Super Míssil.
  const sim = new Sim({
    name: 'phantoon',
    bossHp: 700,
    bossSpan: [18, 20],
    bossBody: 'purple',
    bossCore: 'red',
    mobile: true,
    window: 'always',
  });
  agent.reset();
  sim.run(agent, 80);
  const phantoonTicks = sim.actions.filter((a) => a.snapshot?.bossFight?.strategyId === 'phantoon');
  const ammos = new Set(phantoonTicks.map((a) => a.snapshot?.bossFight?.ammo));
  check('Phantoon: estratégia aplicada', phantoonTicks.length > 5, `${phantoonTicks.length}/80 ticks`);
  check('Phantoon: nunca seleciona Super Míssil', !ammos.has('SUPER_MISSILE'), [...ammos].join(','));
  check('Phantoon: usa míssil ou feixe carregado', ammos.has('MISSILE') || ammos.has('CHARGE_BEAM'), [...ammos].join(','));

  // Core-X com poder exposto: o agente deve ir coletar (CHASE) em vez de atirar.
  const core = new Sim({
    name: 'corex',
    bossHp: 120,
    bossSpan: [16, 16],
    bossBody: 'silverCyan',
    bossCore: 'gold',
    mobile: true,
    window: 'always',
    samusStart: [40, 120],
    bossX: 200,
  });
  agent.reset();
  core.run(agent, 40);
  const coreFight = core.actions.map((a) => a.snapshot?.bossFight).filter(Boolean);
  check('Core-X entra pelo codex (entidade especial do classificador)', coreFight.length > 0, `${coreFight.length} ticks`);
  check(
    'com o poder exposto, para de atirar e vai coletar',
    coreFight.some((b) => b!.collectWhenExposed || b!.movement === 'CHASE' || b!.ammo === 'BASIC_BEAM'),
    String(coreFight[0]?.movement),
  );
}

console.log('\n\x1b[1mD. Vitória gera conhecimento persistido\x1b[0m');
{
  const sim = new Sim({
    name: 'torizo-kill',
    bossHp: 480,
    bossSpan: [16, 18],
    bossBody: 'gold',
    bossCore: 'orange',
    mobile: false,
    window: 'always',
  });
  agent.reset();
  sim.run(agent, 160);
  const learned = sim.actions.flatMap((a) => a.learnedKnowledge ?? []);
  check('chefe derrotado', sim.boss.hp <= 0, `hp ${sim.boss.hp}`);
  check('emitir learnedKnowledge com a estratégia vencedora', learned.length > 0 && learned[0].powerId.length > 0, JSON.stringify(learned[0] ?? null).slice(0, 120));
}

console.log('\n\x1b[1mE. Ligação sala→estratégia (volta e aplica direto)\x1b[0m');
{
  const cfg: SimConfig = {
    name: 'kraid',
    bossHp: 900,
    bossSpan: [30, 28],
    bossBody: 'yellowGreen',
    bossCore: 'red',
    mobile: false,
    window: 'alternate',
  };
  const first = new Sim(cfg);
  agent.reset();
  first.run(agent, 60);
  const detectedFirst = first.actions.find((a) => a.snapshot?.bossFight)?.snapshot?.bossFight?.strategyId;
  const catalogued = ['kraid', 'crocomire', 'spore-spawn', 'mother-brain', 'generic-boss'];
  check('chefe verde enraizado cai num gigante catalogado (não em qualquer coisa)', catalogued.includes(String(detectedFirst)), String(detectedFirst));
  const wf = first.actions.find((a) => a.snapshot?.bossFight)?.snapshot?.bossFight;
  check('mira num ponto fraco específico em vez de atirar em cheio no corpo', wf?.weakPoint !== 'ANY' || wf?.probeMode === true, String(wf?.weakPoint));
  const second = new Sim(cfg);
  second.run(agent, 20);
  const detectedSecond = second.actions.find((a) => a.snapshot?.bossFight)?.snapshot?.bossFight?.strategyId;
  check('vínculo por sala mantém a estratégia entre visitas', detectedSecond === detectedFirst, `${detectedFirst} → ${detectedSecond}`);
}

console.log('\n\x1b[1mF. Mob comum não é tratado como chefe\x1b[0m');
{
  const sim = new Sim({
    name: 'mob',
    bossHp: 40,
    bossSpan: [8, 8],
    bossBody: 'red',
    bossCore: 'red',
    mobile: true,
    window: 'always',
  });
  agent.reset();
  sim.run(agent, 30);
  check('inimigo fraco não ganha estado de luta do codex', sim.actions.every((a) => !a.snapshot?.bossFight), `${sim.actions.filter((a) => a.snapshot?.bossFight).length} ticks com bossFight`);
  check('munição pesada preservada contra mob', sim.loadout.supers === 10 && sim.loadout.missiles >= 36, `mísseis ${sim.loadout.missiles}`);
}

if (process.env.SIM_DEBUG && failures.length > 0) {
  for (const f of failures) console.log(`\n[debug] ${f}`);
}

console.log(`\n\x1b[1m${failures.length === 0 ? '\x1b[32mSIMULAÇÃO DO AGENTE OK' : `\x1b[31m${failures.length} FALHA(S)`}\x1b[0m  · ${passed} verificações`);
if (failures.length > 0) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
