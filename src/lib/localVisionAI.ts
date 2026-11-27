import type {
  AgentBehaviorMode,
  AIAction,
  AIKey,
  AIProfile,
  AIStatusSnapshot,
  CapturedFrame,
  CoreXStage,
  EncounterKnowledgeRecord,
  SpecialEntityType,
  USearchPhase,
} from '../types/emulator';
import type { DoorInfo, EnemyInfo, MetroidWramSnapshot, RoomItemTarget } from './snesWram';

interface GridMetrics {
  avgLum: number;
  bottomBandContrast: number;
  topMotion: number;
  leftMotion: number;
  rightMotion: number;
  midLeftMotion: number;
  midRightMotion: number;
  totalMotion: number;
}

interface EnemyTrack {
  slot: number;
  id: number;
  initX: number;
  initY: number;
  lastX: number;
  lastY: number;
  totalMoved: number;
  initHp: number;
  lastHp: number;
  seenTicks: number;
  combatTicks: number;
  hostileConfirmed: boolean;
  ignoredAsStatic: boolean;
  isCoreX?: boolean;
  coreXStage?: CoreXStage;
  seenRedStage?: boolean;
  specialType?: SpecialEntityType;
}

interface SpriteColorProfile {
  redRatio: number;
  yellowGreenRatio: number;
  silverCyanRatio: number;
  goldRatio: number;
  purpleRatio: number;
  orangeRatio: number;
  neonGreenRatio: number;
}

const ITEM_POWER_CATALOG: Array<{ bit: number; id: string; name: string; effect: string }> = [
  { bit: 0x0001, id: 'varia-suit', name: 'Varia Suit', effect: 'Resistência ao fogo, frio extremo e 50% menos dano' },
  { bit: 0x0020, id: 'gravity-suit', name: 'Gravity Suit', effect: 'Resistência térmica, movimento livre em lava/água e 75% menos dano' },
  { bit: 0x0004, id: 'morph-ball', name: 'Morph Ball', effect: 'Transforma em esfera para passagens estreitas' },
  { bit: 0x1000, id: 'bombs', name: 'Bombas', effect: 'Destrói blocos em Morph Ball e impulsiona saltos' },
  { bit: 0x0002, id: 'spring-ball', name: 'Spring Ball', effect: 'Permite saltar diretamente em Morph Ball' },
  { bit: 0x0100, id: 'hi-jump', name: 'Hi-Jump Boots', effect: 'Aumenta altura de salto e escalada' },
  { bit: 0x2000, id: 'speed-booster', name: 'Speed Booster', effect: 'Corrida supersônica que rompe blocos de velocidade' },
  { bit: 0x0200, id: 'space-jump', name: 'Space Jump', effect: 'Pulo infinito no ar para alcançar áreas altas' },
  { bit: 0x0008, id: 'screw-attack', name: 'Screw Attack', effect: 'Escudo elétrico giratório no salto que destrói inimigos' },
  { bit: 0x4000, id: 'grapple-beam', name: 'Grapple Beam', effect: 'Gancho para atravessar abismos e blocos especiais' },
  { bit: 0x8000, id: 'xray-scope', name: 'X-Ray Scope', effect: 'Revela blocos falsos e rotas secretas' },
];

const BEAM_POWER_CATALOG: Array<{ bit: number; id: string; name: string; effect: string }> = [
  { bit: 0x1000, id: 'charge-beam', name: 'Charge Beam', effect: 'Disparo carregado capaz de ferir chefes e Core-X' },
  { bit: 0x0001, id: 'wave-beam', name: 'Wave / Wide Beam', effect: 'Feixe atravessa paredes e amplia cobertura' },
  { bit: 0x0002, id: 'ice-beam', name: 'Ice Beam', effect: 'Congela Metroids e parasitas X para finalizar com míssil' },
  { bit: 0x0004, id: 'spazer-beam', name: 'Spazer', effect: 'Feixe triplo paralelo de alta cobertura' },
  { bit: 0x0008, id: 'plasma-beam', name: 'Plasma Beam', effect: 'Feixe perfurante de dano máximo contra SA-X' },
];

interface RoomDoorProgress {
  key: string;
  side: DoorInfo['side'];
  targetRoomId?: number;
  locked: boolean;
  missileProbes: number;
  lastVisitedTick: number;
}

interface RoomNode {
  id: number;
  exits: Partial<Record<'LEFT' | 'RIGHT', number>>;
  doorLinks: Map<string, number>;
  doors: Map<string, RoomDoorProgress>;
  triedLeft: boolean;
  triedRight: boolean;
}

interface TilePathStep {
  dir: 'LEFT' | 'RIGHT';
  jump: boolean;
  drop: boolean;
  shoot: boolean;
  bomb?: boolean;
  wpBx: number;
  wpBy: number;
  goalKey: string;
  goalDist: number;
  viaBreakable: boolean;
}

interface PendingTarget {
  roomId: number;
  x: number;
  y: number;
  dir: 'LEFT' | 'RIGHT';
  note: string;
  unlockedToRetry: boolean;
}

interface InteractiveObject {
  bx: number;
  by: number;
  x: number;
  y: number;
  type:
    | 'TERMINAL'
    | 'COMPUTER'
    | 'POWER_PANEL'
    | 'ENERGY_AUX'
    | 'DOOR_CONTROL'
    | 'SAVE_STATION'
    | 'ITEM';
  interacted: boolean;
  priority: number;
}

interface USearchState {
  active: boolean;
  phase: USearchPhase;
  blockedDir: 'LEFT' | 'RIGHT';
  originX: number;
  originY: number;
  ticksInPhase: number;
  cooldown: number;
}

interface VisualUSearchState {
  active: boolean;
  phase: USearchPhase;
  blockedDir: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
  ticksInPhase: number;
  legIndex: number;
}

const GRID_COLS = 16;
const GRID_ROWS = 12;

const BEHAVIOR_LABELS: Record<AgentBehaviorMode, string> = {
  MENU: 'Menu',
  CUTSCENE: 'Cena / Briefing',
  EXPLORE: 'Exploração',
  COLLECT: 'Coleta',
  COMBAT: 'Combate',
  BACKTRACK: 'Backtracking',
  EVADE_SAX: 'Fuga SA-X',
};

export class LocalVisionAgent {
  private prevLums: Float32Array | null = null;
  private stagnantCount = 0;
  private moveDir: 'RIGHT' | 'LEFT' = 'RIGHT';
  private blockedTicks = 0;
  private stepIndex = 0;
  private menuCycleIdx = 0;
  private darkTickCount = 0;
  private rpgDirIdx = 0;

  // Estado explícito de comportamento
  private currentMode: AgentBehaviorMode = 'EXPLORE';
  private lastMetrics: GridMetrics = {
    avgLum: 120,
    bottomBandContrast: 0,
    topMotion: 0,
    leftMotion: 0,
    rightMotion: 0,
    midLeftMotion: 0,
    midRightMotion: 0,
    totalMotion: 0.05,
  };

  // Controle real de borda de subida (pulo, disparo e menu no SNES)
  private jumpHoldRemaining = 0;
  private jumpCooldown = 0;
  private shootPulse = false;
  private menuPulse = false;
  private cutsceneHoldTicks = 0;

  // Memória de exploração, salas, portas, progresso real e backtracking
  private roomGraph = new Map<number, RoomNode>();
  private pendingTargets: PendingTarget[] = [];
  private lastRoomId = -1;
  private entryDoorKey: string | null = null;
  private activeDoorKey: string | null = null;
  private roomTicks = 0;
  private roomSpawnX = 0;
  private roomSpawnY = 0;
  private roomMovedOnce = false;
  private anchorX = 0;
  private anchorY = 0;
  private prevSamusX = 0;
  private prevSamusY = 0;
  private samusVx = 0;
  private samusVy = 0;
  private sameYStreak = 0;
  private progressStallTicks = 0;
  private missileProbeCount = 0;
  private recentBlockedSpots: Array<{ x: number; y: number; dir: 'LEFT' | 'RIGHT' }> = [];
  private itemChaseTicks = 0;
  private unbreakableGates = new Set<string>();
  // Células do mapa de blocos onde a IA morreu ou ficou presa (aprendizado de falhas)
  private dangerCells = new Set<string>();

  // Sistema de exploração do mapa: rastreia salas visitadas e quando o mapa foi "ganho"
  private roomsExplored = new Set<number>();
  private mapExploredThreshold = 12; // número de salas únicas para considerar o mapa explorado
  private mapFullyExplored = false;
  private lastMapCheckTick = 0;

  // Controle de uso de míssil: só usa míssil em boss, porta bloqueada ou situação especial
  private lastMissileUseTick = -100;
  private missileCooldownTicks = 60; // evita spam de míssil

  // Sistema de interação com objetos/terminal/energia
  private interactiveObjects: Array<{
    bx: number;
    by: number;
    x: number;
    y: number;
    type: 'TERMINAL' | 'COMPUTER' | 'POWER_PANEL' | 'ENERGY_AUX' | 'DOOR_CONTROL' | 'SAVE_STATION' | 'ITEM';
    interacted: boolean;
    priority: number;
  }> = [];
  private currentInteractionTarget: { bx: number; by: number; x: number; y: number; type: string } | null = null;
  private interactionCooldown = 0;
  private lastInteractionTick = -100;
  private roomsWithPowerIssue = new Set<number>(); // salas que precisam de energia auxiliar
  private powerAuxActivated = false; // se a energia auxiliar foi ativada
  private stuckInRoomTicks = 0;
  private lastRoomEntryTick = 0;

  // Sistema de análise periódica do menu do jogo:
  // espera 3 min → abre menu → analisa 3 min → fecha menu → espera 10 min → repete
  private mapAnalyzed = false;
  private mapAnalysisTick = 0;
  // Fluxo de menu: esperar → abrir → analisar → fechar → esperar → repetir
  private menuPhase: 'NONE' | 'OPENING' | 'ANALYZING' | 'CLOSING' | 'DONE' = 'NONE';
  private menuCloseTick = 0;
  private menuCheckedAbilities = false;
  private preferredDirection: 'LEFT' | 'RIGHT' | null = null;
  // Tempos exatos (ticks @ ~125ms por tick):
  // 3 min = 1440 ticks, 10 min = 4800 ticks
  private lastMenuCloseTick = 0;
  private readonly MENU_WAIT_BEFORE_OPEN_TICKS = 1440;    // 3 min esperando antes de abrir o menu
  private readonly MENU_OPEN_INTERVAL_TICKS = 4800;      // 10 min entre aberturas do menu
  private readonly MENU_ANALYSIS_DURATION_TICKS = 1440;   // 3 min de análise com menu aberto
  private initialLoadoutAnalyzed = false;
  private abilitiesSummary: string[] = [];

  // Sistema de priorização de objetivos: qual objetivo perseguir primeiro
  private currentObjective: {
    type: 'ITEM' | 'DOOR' | 'BOSS' | 'SAVE_STATION' | 'ENERGY_AUX' | 'EXPLORE';
    x: number;
    y: number;
    priority: number;
    reason: string;
  } | null = null;
  private objectiveTick = 0;

  // Detecção de loop com escape forçado
  private loopDetected = false;
  private forcedEscapeTick = 0;
  private forcedEscapeDir: 'LEFT' | 'RIGHT' | null = null;
  private lastRoomPositions: Array<{ x: number; y: number; tick: number }> = [];

  // Evasão inteligente da SA-X: considera bloqueio de rota
  private saxBlocksRoute = false;
  private saxBlockRouteTick = 0;
  private alternateEscapeDir: 'LEFT' | 'RIGHT' | null = null;

  // Padrão de busca em 'U' para contornar bloqueios durante Exploração
  private uSearch: USearchState = {
    active: false,
    phase: 'NONE',
    blockedDir: 'RIGHT',
    originX: 0,
    originY: 0,
    ticksInPhase: 0,
    cooldown: 0,
  };

  private visualUSearch: VisualUSearchState = {
    active: false,
    phase: 'NONE',
    blockedDir: 'RIGHT',
    ticksInPhase: 0,
    legIndex: 0,
  };

  // Estado de habilidades, HP, energia reserva e rastreamento de inimigos vs cenário estático
  private prevHealth = 0;
  private prevItemsMask = 0;
  private prevBeamsMask = 0;
  private prevMaxMissiles = 0;
  private prevMaxSupers = 0;
  private prevMaxPbs = 0;
  private prevMaxHealth = 0;
  private prevReserveMax = 0;
  private recentDamageSpikeTick = -100;
  private enemyTracks = new Map<number, EnemyTrack>();
  private lastIgnoredBgCount = 0;
  private visualCombatStreak = 0;
  private visualCombatCooldown = 0;
  private lastCapturedFrame: CapturedFrame | null = null;

  // Classificação especial X-Fusion (Omega+Timer, SA-X, Core-X 4 fases, Metroid, Metroid Grande, SA-X Monstro)
  private activeSpecialEntity: SpecialEntityType = 'NONE';
  private activeSpecialLabel = '';
  private activeCoreXStage: CoreXStage | null = null;
  private lastCoreXSeenTick = -200;
  private lastCoreXRoomId = -1;
  private lastCoreXWasRedTick = -200;
  private lastCoreXWasRedRoomId = -1;
  private lastRoomDoorsSnapshot: DoorInfo[] = [];
  private omegaIntroSeenTicks = 0;
  private omegaVanishedDuringTimer = false;
  private bigMetroidDrainSeen = false;
  private bigMetroidHealedTick = -300;
  private lastEnergyResetTick = -100;
  private pendingLearnedKnowledge: Array<
    Omit<EncounterKnowledgeRecord, 'id' | 'game' | 'defeatedCount' | 'observedAt'>
  > = [];

  reset(): void {
    this.prevLums = null;
    this.stagnantCount = 0;
    this.moveDir = 'RIGHT';
    this.blockedTicks = 0;
    this.stepIndex = 0;
    this.menuCycleIdx = 0;
    this.darkTickCount = 0;
    this.rpgDirIdx = 0;
    this.currentMode = 'EXPLORE';
    this.lastMetrics = {
      avgLum: 120,
      bottomBandContrast: 0,
      topMotion: 0,
      leftMotion: 0,
      rightMotion: 0,
      midLeftMotion: 0,
      midRightMotion: 0,
      totalMotion: 0.05,
    };
    this.jumpHoldRemaining = 0;
    this.jumpCooldown = 0;
    this.shootPulse = false;
    this.menuPulse = false;
    this.cutsceneHoldTicks = 0;
    this.roomGraph.clear();
    this.pendingTargets = [];
    this.lastRoomId = -1;
    this.entryDoorKey = null;
    this.activeDoorKey = null;
    this.roomTicks = 0;
    this.roomSpawnX = 0;
    this.roomSpawnY = 0;
    this.roomMovedOnce = false;
    this.anchorX = 0;
    this.anchorY = 0;
    this.prevSamusX = 0;
    this.prevSamusY = 0;
    this.samusVx = 0;
    this.samusVy = 0;
    this.sameYStreak = 0;
    this.progressStallTicks = 0;
    this.missileProbeCount = 0;
    this.recentBlockedSpots = [];
    this.itemChaseTicks = 0;
    this.unbreakableGates.clear();
    this.dangerCells.clear();
    this.resetUSearch();
    this.visualUSearch = {
      active: false,
      phase: 'NONE',
      blockedDir: 'RIGHT',
      ticksInPhase: 0,
      legIndex: 0,
    };
    this.prevHealth = 0;
    this.prevItemsMask = 0;
    this.prevBeamsMask = 0;
    this.prevMaxMissiles = 0;
    this.prevMaxSupers = 0;
    this.prevMaxPbs = 0;
    this.prevMaxHealth = 0;
    this.prevReserveMax = 0;
    this.recentDamageSpikeTick = -100;
    this.enemyTracks.clear();
    this.lastIgnoredBgCount = 0;
    this.visualCombatStreak = 0;
    this.visualCombatCooldown = 0;
    this.lastCapturedFrame = null;
    this.activeSpecialEntity = 'NONE';
    this.activeSpecialLabel = '';
    this.activeCoreXStage = null;
    this.lastCoreXSeenTick = -200;
    this.lastCoreXRoomId = -1;
    this.lastCoreXWasRedTick = -200;
    this.lastCoreXWasRedRoomId = -1;
    this.lastRoomDoorsSnapshot = [];
    this.omegaIntroSeenTicks = 0;
    this.omegaVanishedDuringTimer = false;
    this.bigMetroidDrainSeen = false;
    this.bigMetroidHealedTick = -300;
    this.lastEnergyResetTick = -100;
    this.pendingLearnedKnowledge = [];
    this.interactiveObjects = [];
    this.currentInteractionTarget = null;
    this.interactionCooldown = 0;
    this.lastInteractionTick = -100;
    this.stuckInRoomTicks = 0;
    this.lastRoomEntryTick = this.stepIndex;
    this.mapAnalyzed = false;
    this.mapAnalysisTick = 0;
    this.menuPhase = 'NONE';
    this.menuCloseTick = 0;
    this.lastMenuCloseTick = 0;
    this.menuCheckedAbilities = false;
    this.preferredDirection = null;
    this.initialLoadoutAnalyzed = false;
    this.abilitiesSummary = [];
    this.currentObjective = null;
    this.objectiveTick = 0;
    this.loopDetected = false;
    this.forcedEscapeTick = 0;
    this.forcedEscapeDir = null;
    this.lastRoomPositions = [];
    this.saxBlocksRoute = false;
    this.saxBlockRouteTick = 0;
    this.alternateEscapeDir = null;
  }

  private resetUSearch(cooldown = 0): void {
    this.uSearch = {
      active: false,
      phase: 'NONE',
      blockedDir: this.moveDir,
      originX: 0,
      originY: 0,
      ticksInPhase: 0,
      cooldown,
    };
  }

  private startUSearch(wram: MetroidWramSnapshot): void {
    this.uSearch = {
      active: true,
      phase: 'BACKSTEP',
      blockedDir: this.moveDir,
      originX: wram.samusX,
      originY: wram.samusY,
      ticksInPhase: 0,
      cooldown: 0,
    };
    this.jumpHoldRemaining = 0;
  }

  private analyzeFrame(frame: CapturedFrame): GridMetrics {
    const { width, height, rgba } = frame;
    const cellW = Math.floor(width / GRID_COLS);
    const cellH = Math.floor(height / GRID_ROWS);
    const lums = new Float32Array(GRID_COLS * GRID_ROWS);

    let totalLum = 0;
    let bottomContrastSum = 0;

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        let sum = 0;
        let minL = 255;
        let maxL = 0;
        let n = 0;

        for (let py = gy * cellH; py < (gy + 1) * cellH; py += 2) {
          for (let px = gx * cellW; px < (gx + 1) * cellW; px += 2) {
            const idx = (py * width + px) * 4;
            const r = rgba[idx];
            const g = rgba[idx + 1];
            const b = rgba[idx + 2];
            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            sum += lum;
            if (lum < minL) minL = lum;
            if (lum > maxL) maxL = lum;
            n++;
          }
        }

        lums[gy * GRID_COLS + gx] = sum / Math.max(1, n);
        totalLum += lums[gy * GRID_COLS + gx];
        if (gy >= GRID_ROWS - 3) {
          bottomContrastSum += maxL - minL;
        }
      }
    }

    let topMotion = 0;
    let leftMotion = 0;
    let rightMotion = 0;
    let midLeftMotion = 0;
    let midRightMotion = 0;
    let totalMotion = 0;

    if (this.prevLums) {
      let topN = 0;
      let leftN = 0;
      let rightN = 0;
      let midLeftN = 0;
      let midRightN = 0;
      for (let gy = 0; gy < GRID_ROWS; gy++) {
        for (let gx = 0; gx < GRID_COLS; gx++) {
          const i = gy * GRID_COLS + gx;
          const d = Math.abs(lums[i] - this.prevLums[i]) / 255;
          totalMotion += d;
          if (gy < 3) {
            topMotion += d;
            topN++;
          }
          if (gx < 5) {
            leftMotion += d;
            leftN++;
            if (gy >= 3 && gy <= 8) {
              midLeftMotion += d;
              midLeftN++;
            }
          } else if (gx > 10) {
            rightMotion += d;
            rightN++;
            if (gy >= 3 && gy <= 8) {
              midRightMotion += d;
              midRightN++;
            }
          }
        }
      }
      totalMotion /= GRID_COLS * GRID_ROWS;
      topMotion /= Math.max(1, topN);
      leftMotion /= Math.max(1, leftN);
      rightMotion /= Math.max(1, rightN);
      midLeftMotion /= Math.max(1, midLeftN);
      midRightMotion /= Math.max(1, midRightN);
    }

    this.prevLums = lums;
    return {
      avgLum: totalLum / (GRID_COLS * GRID_ROWS),
      bottomBandContrast: bottomContrastSum / (GRID_COLS * 3),
      topMotion,
      leftMotion,
      rightMotion,
      midLeftMotion,
      midRightMotion,
      totalMotion,
    };
  }

  private nextJump(wantJump: boolean, holdTicks = 3): boolean {
    if (this.jumpHoldRemaining > 0) {
      this.jumpHoldRemaining--;
      if (this.jumpHoldRemaining === 0) {
        this.jumpCooldown = 2;
      }
      return true;
    }
    if (this.jumpCooldown > 0) {
      this.jumpCooldown--;
      return false;
    }
    if (wantJump) {
      this.jumpHoldRemaining = Math.max(1, holdTicks) - 1;
      if (this.jumpHoldRemaining === 0) {
        this.jumpCooldown = 1;
      }
      return true;
    }
    return false;
  }

  private nextShoot(wantShoot: boolean): boolean {
    if (!wantShoot) {
      this.shootPulse = false;
      return false;
    }
    this.shootPulse = !this.shootPulse;
    return this.shootPulse;
  }

  private getOrCreateRoom(roomId: number): RoomNode {
    let node = this.roomGraph.get(roomId);
    if (!node) {
      node = {
        id: roomId,
        exits: {},
        doorLinks: new Map(),
        doors: new Map(),
        triedLeft: false,
        triedRight: false,
      };
      this.roomGraph.set(roomId, node);
    }
    return node;
  }

  private addPendingTarget(target: Omit<PendingTarget, 'unlockedToRetry'>): void {
    const exists = this.pendingTargets.some(
      (t) => t.roomId === target.roomId && Math.abs(t.x - target.x) < 56 && t.dir === target.dir,
    );
    if (!exists) {
      this.pendingTargets.push({ ...target, unlockedToRetry: false });
    }
  }

  private findBfsStepTowardPending(currentRoomId: number): 'LEFT' | 'RIGHT' | null {
    const targetRooms = new Set(
      this.pendingTargets.filter((t) => t.unlockedToRetry).map((t) => t.roomId),
    );
    if (targetRooms.size === 0 || targetRooms.has(currentRoomId)) return null;

    const queue: Array<{ roomId: number; firstDir: 'LEFT' | 'RIGHT' | null }> = [
      { roomId: currentRoomId, firstDir: null },
    ];
    const visited = new Set<number>([currentRoomId]);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const node = this.roomGraph.get(curr.roomId);
      if (!node) continue;
      for (const dir of ['LEFT', 'RIGHT'] as const) {
        const nextRoom = node.exits[dir];
        if (!nextRoom || visited.has(nextRoom)) continue;
        const firstDir = curr.firstDir ?? dir;
        if (targetRooms.has(nextRoom)) return firstDir;
        visited.add(nextRoom);
        queue.push({ roomId: nextRoom, firstDir });
      }
    }
    return null;
  }

  private findRoomWithUnexploredDoor(currentRoomId: number): number | null {
    const queue: Array<{ roomId: number; firstNextRoom: number | null }> = [
      { roomId: currentRoomId, firstNextRoom: null },
    ];
    const visited = new Set<number>([currentRoomId]);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const node = this.roomGraph.get(curr.roomId);
      if (!node) continue;

      if (curr.roomId !== currentRoomId) {
        for (const d of node.doors.values()) {
          if (!d.locked && d.targetRoomId === undefined) {
            return curr.firstNextRoom;
          }
        }
      }

      for (const nextRoom of node.doorLinks.values()) {
        if (!nextRoom || visited.has(nextRoom)) continue;
        visited.add(nextRoom);
        queue.push({
          roomId: nextRoom,
          firstNextRoom: curr.firstNextRoom ?? nextRoom,
        });
      }
    }
    return null;
  }

  private checkAbilitiesProgress(wram: MetroidWramSnapshot): {
    unlockedLabel: string | null;
    energyOrStateReset: boolean;
  } {
    let unlocked: string | null = null;
    let energyOrStateReset = false;

    const fromCoreX =
      wram.roomId === this.lastCoreXRoomId && this.stepIndex - this.lastCoreXSeenTick <= 180;
    const sourceEntity: SpecialEntityType = fromCoreX ? 'CORE_X_NAKED' : this.activeSpecialEntity;
    const sourceLabel = fromCoreX ? 'Core-X (Poder Absorvido)' : this.activeSpecialLabel || 'Exploração / Chefe';

    if (this.prevMaxHealth > 0) {
      const lostItems = (this.prevItemsMask & ~wram.itemsMask) !== 0;
      const lostBeams = (this.prevBeamsMask & ~wram.beamsMask) !== 0;
      const respawnedFromZero = this.prevHealth === 0 && wram.health > 0;
      const isScriptedMetroidDrain = this.bigMetroidDrainSeen && wram.health > 0 && wram.health <= 30;

      if (
        !isScriptedMetroidDrain &&
        (wram.maxHealth < this.prevMaxHealth || lostItems || lostBeams || respawnedFromZero)
      ) {
        energyOrStateReset = true;
      } else if (!isScriptedMetroidDrain) {
        const newItems = wram.itemsMask & ~this.prevItemsMask;
        const newBeams = wram.beamsMask & ~this.prevBeamsMask;

        for (const item of ITEM_POWER_CATALOG) {
          if (newItems & item.bit) {
            unlocked = `${item.name} (${item.effect})`;
            this.pendingLearnedKnowledge.push({
              entityType: sourceEntity,
              entityLabel: sourceLabel,
              powerId: item.id,
              powerName: item.name,
              powerEffect: item.effect,
              roomId: wram.roomId,
            });
          }
        }

        for (const beam of BEAM_POWER_CATALOG) {
          if (newBeams & beam.bit) {
            unlocked = `${beam.name} (${beam.effect})`;
            this.pendingLearnedKnowledge.push({
              entityType: sourceEntity,
              entityLabel: sourceLabel,
              powerId: beam.id,
              powerName: beam.name,
              powerEffect: beam.effect,
              roomId: wram.roomId,
            });
          }
        }

        if (wram.maxSupers > this.prevMaxSupers) {
          if (!unlocked) unlocked = 'Super Míssil';
          this.pendingLearnedKnowledge.push({
            entityType: sourceEntity,
            entityLabel: sourceLabel,
            powerId: 'super-missile',
            powerName: 'Super Míssil',
            powerEffect: 'Disparo pesado para portas especiais e chefes',
            roomId: wram.roomId,
          });
        } else if (wram.maxPowerBombs > this.prevMaxPbs) {
          if (!unlocked) unlocked = 'Power Bomb';
          this.pendingLearnedKnowledge.push({
            entityType: sourceEntity,
            entityLabel: sourceLabel,
            powerId: 'power-bomb',
            powerName: 'Power Bomb',
            powerEffect: 'Explosão de área que revela segredos e fere parasitas X',
            roomId: wram.roomId,
          });
        } else if (wram.maxMissiles > this.prevMaxMissiles) {
          if (!unlocked) unlocked = 'Expansão de Míssil';
        } else if (wram.maxHealth > this.prevMaxHealth) {
          if (!unlocked) unlocked = 'Tanque de Energia';
        } else if (wram.reserveMax > this.prevReserveMax) {
          if (!unlocked) unlocked = 'Tanque de Reserva';
          this.pendingLearnedKnowledge.push({
            entityType: sourceEntity,
            entityLabel: sourceLabel,
            powerId: 'reserve-tank',
            powerName: 'Reserve Tank',
            powerEffect: 'Armazena energia extra e cura automaticamente em emergência',
            roomId: wram.roomId,
          });
        }
      }
    }

    this.prevItemsMask = wram.itemsMask;
    this.prevBeamsMask = wram.beamsMask;
    this.prevMaxMissiles = wram.maxMissiles;
    this.prevMaxSupers = wram.maxSupers;
    this.prevMaxPbs = wram.maxPowerBombs;
    this.prevMaxHealth = wram.maxHealth;
    this.prevReserveMax = wram.reserveMax;

    if (energyOrStateReset) {
      this.lastEnergyResetTick = this.stepIndex;
      this.enemyTracks.clear();
      this.recentDamageSpikeTick = -100;
      this.progressStallTicks = 0;
      this.itemChaseTicks = 0;
      this.recentBlockedSpots = [];
      this.unbreakableGates.clear();
      this.dangerCells.clear();
      this.omegaIntroSeenTicks = 0;
      this.omegaVanishedDuringTimer = false;
      this.bigMetroidDrainSeen = false;
      this.bigMetroidHealedTick = -300;
      this.resetUSearch();
    } else if (unlocked) {
      for (const p of this.pendingTargets) {
        p.unlockedToRetry = true;
      }
      for (const node of this.roomGraph.values()) {
        for (const d of node.doors.values()) {
          d.locked = false;
          d.missileProbes = 0;
        }
      }
      for (const track of this.enemyTracks.values()) {
        track.ignoredAsStatic = false;
        track.combatTicks = 0;
      }
      this.recentBlockedSpots = [];
      this.unbreakableGates.clear();
      this.dangerCells.clear();
    }
    return { unlockedLabel: unlocked, energyOrStateReset };
  }

  private isReadyToFightSAX(wram: MetroidWramSnapshot): boolean {
    if (this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 320) {
      return true;
    }
    const effectiveMaxHp = wram.maxHealth + (wram.reserveMode === 1 ? wram.reserveMax : 0);
    const hasHighEnergy = effectiveMaxHp >= 600;
    const hasSuit = (wram.itemsEquipped & 0x0021) !== 0 || (wram.itemsMask & 0x0021) !== 0; // Varia ou Gravity
    const hasStrongBeam = (wram.beamsEquipped & 0x1009) !== 0 || (wram.beamsMask & 0x1009) !== 0; // Charge, Plasma ou Wave
    const hasHeavyAmmo = wram.maxSupers >= 10 || wram.maxMissiles >= 40;
    return hasHighEnergy && hasSuit && hasStrongBeam && hasHeavyAmmo;
  }

  // Verifica quais habilidades, armadura e ferramentas o agente possui no momento
  private getAgentLoadout(wram: MetroidWramSnapshot): {
    hasVaria: boolean;
    hasGravity: boolean;
    hasMorphBall: boolean;
    hasBombs: boolean;
    hasSpringBall: boolean;
    hasHiJump: boolean;
    hasSpaceJump: boolean;
    hasSpeedBooster: boolean;
    hasScrewAttack: boolean;
    hasGrapple: boolean;
    hasXRay: boolean;
    hasChargeBeam: boolean;
    hasWaveBeam: boolean;
    hasIceBeam: boolean;
    hasSpazer: boolean;
    hasPlasmaBeam: boolean;
    hasMissiles: boolean;
    hasSupers: boolean;
    hasPowerBombs: boolean;
    hasReserveTank: boolean;
    energyTanks: number;
    missileCount: number;
    superCount: number;
    powerBombCount: number;
    totalAbilities: number;
  } {
    const itemsMask = wram.itemsMask;
    const beamsMask = wram.beamsMask;

    const hasVaria = (itemsMask & 0x0001) !== 0;
    const hasGravity = (itemsMask & 0x0020) !== 0;
    const hasMorphBall = (itemsMask & 0x0004) !== 0;
    const hasBombs = (itemsMask & 0x1000) !== 0;
    const hasSpringBall = (itemsMask & 0x0002) !== 0;
    const hasHiJump = (itemsMask & 0x0100) !== 0;
    const hasSpaceJump = (itemsMask & 0x0200) !== 0;
    const hasSpeedBooster = (itemsMask & 0x2000) !== 0;
    const hasScrewAttack = (itemsMask & 0x0008) !== 0;
    const hasGrapple = (itemsMask & 0x4000) !== 0;
    const hasXRay = (itemsMask & 0x8000) !== 0;

    const hasChargeBeam = (beamsMask & 0x1000) !== 0;
    const hasWaveBeam = (beamsMask & 0x0001) !== 0;
    const hasIceBeam = (beamsMask & 0x0002) !== 0;
    const hasSpazer = (beamsMask & 0x0004) !== 0;
    const hasPlasmaBeam = (beamsMask & 0x0008) !== 0;

    const hasMissiles = wram.missiles > 0;
    const hasSupers = wram.supers > 0;
    const hasPowerBombs = wram.powerBombs > 0;
    const hasReserveTank = wram.reserveMax > 0;

    const energyTanks = Math.max(0, Math.floor((wram.maxHealth - 99) / 100));

    const totalAbilities = [
      hasVaria, hasGravity, hasMorphBall, hasBombs, hasSpringBall, hasHiJump,
      hasSpaceJump, hasSpeedBooster, hasScrewAttack, hasGrapple, hasXRay,
      hasChargeBeam, hasWaveBeam, hasIceBeam, hasSpazer, hasPlasmaBeam,
    ].filter(Boolean).length;

    return {
      hasVaria, hasGravity, hasMorphBall, hasBombs, hasSpringBall, hasHiJump,
      hasSpaceJump, hasSpeedBooster, hasScrewAttack, hasGrapple, hasXRay,
      hasChargeBeam, hasWaveBeam, hasIceBeam, hasSpazer, hasPlasmaBeam,
      hasMissiles, hasSupers, hasPowerBombs, hasReserveTank,
      energyTanks,
      missileCount: wram.missiles,
      superCount: wram.supers,
      powerBombCount: wram.powerBombs,
      totalAbilities,
    };
  }

  // Decide se o agente deve usar míssil com base no loadout e contexto
  // Só usa míssil se: for boss, porta bloqueada, ou situação especial (SA-X, Core-X)
  // Não usa míssil em inimigos comuns para não munição
  private shouldUseMissile(
    wram: MetroidWramSnapshot,
    target: EnemyInfo | null,
    isBoss: boolean,
    isBlockedDoor: boolean,
    isSpecialEntity: boolean,
  ): boolean {
    const loadout = this.getAgentLoadout(wram);

    // Não tem míssil disponível
    if (!loadout.hasMissiles && !loadout.hasSupers) return false;

    // Cooldown de míssil para evitar spam
    if (this.stepIndex - this.lastMissileUseTick < this.missileCooldownTicks) return false;

    // Sem munição suficiente (reserva para boss/porta)
    if (loadout.missileCount < 5 && loadout.superCount === 0) return false;

    // Sempre usa míssil em boss
    if (isBoss) return true;

    // Sempre usa míssil em porta bloqueada
    if (isBlockedDoor) return true;

    // Sempre usa míssil em entidade especial (SA-X, Core-X, etc.)
    if (isSpecialEntity) return true;

    // Não usa míssil em inimigo comum - economiza para boss/porta
    return false;
  }

  // Registra uso de míssil para controle de cooldown
  private registerMissileUse(): void {
    this.lastMissileUseTick = this.stepIndex;
    this.missileProbeCount++;
  }

  // Fluxo de menu periódico: ABRIR → verificar tudo (3 min) → FECHAR → jogar (10 min) → repetir
  private openMapAndAnalyze(
    wram: MetroidWramSnapshot,
    keys: AIKey[],
    motionPct: number,
  ): AIAction | null {
    if (wram.gameState !== 8) return null;

    const mapKey: AIKey = 'SELECT';

    // Fase DONE: menu fechado, esperando 10 minutos antes de abrir novamente
    if (this.menuPhase === 'DONE') {
      const ticksSinceClose = this.stepIndex - this.lastMenuCloseTick;
      if (ticksSinceClose >= this.MENU_OPEN_INTERVAL_TICKS) {
        // 10 minutos passaram — inicia novo ciclo: espera 3 min antes de abrir
        this.menuPhase = 'NONE';
        this.mapAnalyzed = false;
        this.menuCheckedAbilities = false;
        this.mapAnalysisTick = this.stepIndex;
      } else {
        // Ainda faltam minutos para a próxima abertura — segue jogando normalmente
        const remainingMin = Math.round((this.MENU_OPEN_INTERVAL_TICKS - ticksSinceClose) / 60);
        return this.makeMetroidAction(
          'EXPLORE',
          [this.moveDir],
          120,
          'run',
          motionPct,
          `Jogatina · Próxima conferência em ${remainingMin} min`,
          'Menu fechado · explorando e coletando itens até a próxima verificação',
          wram,
        );
      }
    }

    // Fase NONE: esperando 3 minutos antes de abrir o menu do jogo
    if (this.menuPhase === 'NONE') {
      const waitElapsed = this.stepIndex - this.mapAnalysisTick;
      if (waitElapsed < this.MENU_WAIT_BEFORE_OPEN_TICKS) {
        // Ainda está esperando os 3 minutos antes de abrir — segue jogando
        const remainingMin = Math.round((this.MENU_WAIT_BEFORE_OPEN_TICKS - waitElapsed) / 60);
        return this.makeMetroidAction(
          'EXPLORE',
          [this.moveDir],
          120,
          'run',
          motionPct,
          `Jogatina · Abrindo menu em ${remainingMin} min`,
          'Esperando 3 minutos antes de abrir o menu para conferência',
          wram,
        );
      }
      // 3 minutos de espera passaram — hora de abrir o menu
      this.menuPhase = 'OPENING';
      this.mapAnalysisTick = this.stepIndex;
      return this.makeMetroidAction(
        'MENU',
        [mapKey],
        200,
        'run',
        motionPct,
        'Menu · Abrindo',
        'Abrindo menu do jogo para verificar habilidades e atributos',
        wram,
      );
    }

    // Transição de OPENING para ANALYZING após abrir o menu
    if (this.menuPhase === 'OPENING') {
      // Aguarda o menu abrir completamente antes de começar a analisar
      if (this.stepIndex - this.mapAnalysisTick < 20) {
        return this.makeMetroidAction(
          'MENU',
          [mapKey],
          150,
          'run',
          motionPct,
          'Menu · Abrindo',
          'Aguardando abertura completa do menu do jogo',
          wram,
        );
      }
      this.menuPhase = 'ANALYZING';
      this.mapAnalysisTick = this.stepIndex;
    }

    // Fase 2: ANALISANDO — fica com o menu aberto por 3 minutos verificando habilidades/atributos
    if (this.menuPhase === 'ANALYZING') {
      const analysisElapsed = this.stepIndex - this.mapAnalysisTick;

      // Ainda está dentro dos 3 minutos de análise
      if (analysisElapsed < this.MENU_ANALYSIS_DURATION_TICKS) {
        return this.makeMetroidAction(
          'MENU',
          [mapKey],
          150,
          'run',
          motionPct,
          'Menu · Analisando Habilidades',
          `Verificando armadura, peças, mísseis, super mísseis e energia (${Math.round(analysisElapsed / 60)}s / 3min)`,
          wram,
        );
      }

      // 3 minutos passaram — analisa o loadout completo e fecha o menu
      this.analyzeInitialLoadout(wram);
      this.menuCheckedAbilities = true;
      this.menuPhase = 'CLOSING';
      this.menuCloseTick = this.stepIndex;

      return this.makeMetroidAction(
        'MENU',
        [mapKey],
        200,
        'run',
        motionPct,
        'Menu · Fechando',
        'Análise de 3 min concluída · fechando menu para continuar a jogatina',
        wram,
      );
    }

    // Fase 3: FECHAR o menu/mapa
    if (this.menuPhase === 'CLOSING') {
      // Aguarda um pouco antes de fechar para garantir que a análise foi registrada
      if (this.stepIndex - this.menuCloseTick < 30) {
        return this.makeMetroidAction(
          'MENU',
          [mapKey],
          150,
          'run',
          motionPct,
          'Menu · Fechando',
          'Fechando menu · habilidades e atributos confirmados',
          wram,
        );
      }

      // Fecha o menu pressionando SELECT novamente
      this.menuPhase = 'DONE';
      this.lastMenuCloseTick = this.stepIndex;
      return this.makeMetroidAction(
        'MENU',
        [mapKey],
        200,
        'run',
        motionPct,
        'Menu · Fechado · Iniciando Jogatina',
        'Menu fechado · agente pronto para explorar, coletar itens e combater',
        wram,
      );
    }

    return null;
  }

  // Analisa o loadout completo e define direção preferida de exploração
  private analyzeInitialLoadout(wram: MetroidWramSnapshot): void {
    if (this.initialLoadoutAnalyzed) return;

    const loadout = this.getAgentLoadout(wram);

    const skills: string[] = [];
    if (loadout.hasVaria) skills.push('Varia Suit');
    if (loadout.hasGravity) skills.push('Gravity Suit');
    if (loadout.hasMorphBall) skills.push('Morph Ball');
    if (loadout.hasBombs) skills.push('Bombas');
    if (loadout.hasSpaceJump) skills.push('Space Jump');
    if (loadout.hasScrewAttack) skills.push('Screw Attack');
    if (loadout.hasIceBeam) skills.push('Ice Beam');
    if (loadout.hasMissiles) skills.push('Mísseis');
    if (loadout.hasSupers) skills.push('Super Mísseis');

    this.abilitiesSummary = skills;
    this.initialLoadoutAnalyzed = true;

    if (loadout.hasSpaceJump && !loadout.hasMorphBall) {
      this.preferredDirection = 'LEFT';
    } else if (loadout.hasMorphBall && loadout.hasBombs) {
      this.preferredDirection = 'RIGHT';
    } else {
      this.preferredDirection = 'RIGHT';
    }

    this.mapAnalyzed = true;
  }

  // Sistema de priorização de objetivos: decide qual objetivo perseguir primeiro
  private updateObjective(
    wram: MetroidWramSnapshot,
    activeItem: { x: number; y: number; dist: number } | null,
    nearbyEnemy: { x: number; y: number; dist: number; hp: number } | null,
    saxPursuer: { x: number; y: number; dist: number } | null,
    hasSaveStation: boolean,
    hasEnergyAux: boolean,
  ): void {
    if (saxPursuer && saxPursuer.dist < 200) {
      this.currentObjective = {
        type: 'EXPLORE',
        x: saxPursuer.x >= wram.samusX ? 0 : wram.roomWidthPx || 256,
        y: wram.samusY,
        priority: 10,
        reason: 'Fugindo da SA-X',
      };
      this.objectiveTick = this.stepIndex;
      return;
    }

    if (wram.maxHealth > 0 && wram.health < wram.maxHealth * 0.25 && hasSaveStation) {
      this.currentObjective = {
        type: 'SAVE_STATION',
        x: wram.samusX,
        y: wram.samusY,
        priority: 9,
        reason: 'Vida crítica · indo para estação de save',
      };
      this.objectiveTick = this.stepIndex;
      return;
    }

    if (hasEnergyAux && !this.powerAuxActivated) {
      this.currentObjective = {
        type: 'ENERGY_AUX',
        x: wram.samusX,
        y: wram.samusY,
        priority: 8,
        reason: 'Ativando energia auxiliar',
      };
      this.objectiveTick = this.stepIndex;
      return;
    }

    if (activeItem && activeItem.dist < 150) {
      const loadout = this.getAgentLoadout(wram);
      const canReach = loadout.hasMorphBall || loadout.hasSpaceJump || loadout.hasHiJump;

      if (canReach || activeItem.dist < 60) {
        this.currentObjective = {
          type: 'ITEM',
          x: activeItem.x,
          y: activeItem.y,
          priority: 5,
          reason: `Coletando item (${Math.round(activeItem.dist)}px)`,
        };
        this.objectiveTick = this.stepIndex;
        return;
      }
    }

    if (nearbyEnemy && nearbyEnemy.hp >= 450 && this.isReadyToFightSAX(wram)) {
      this.currentObjective = {
        type: 'BOSS',
        x: nearbyEnemy.x,
        y: nearbyEnemy.y,
        priority: 7,
        reason: `Enfrentando chefe (HP ${nearbyEnemy.hp})`,
      };
      this.objectiveTick = this.stepIndex;
      return;
    }

    const dir = this.preferredDirection ?? 'RIGHT';
    this.currentObjective = {
      type: 'EXPLORE',
      x: dir === 'RIGHT' ? (wram.roomWidthPx || 256) : 0,
      y: wram.samusY,
      priority: 1,
      reason: `Explorando para ${dir === 'RIGHT' ? 'direita' : 'esquerda'}`,
    };
    this.objectiveTick = this.stepIndex;
  }

  // Detecção de loop com escape forçado
  private checkForcedEscape(wram: MetroidWramSnapshot): boolean {
    this.lastRoomPositions.push({
      x: wram.samusX,
      y: wram.samusY,
      tick: this.stepIndex,
    });

    if (this.lastRoomPositions.length > 30) {
      this.lastRoomPositions.shift();
    }

    if (this.stuckInRoomTicks > 100 && !this.loopDetected) {
      this.loopDetected = true;
      this.forcedEscapeTick = this.stepIndex;

      const lastPos = this.lastRoomPositions[this.lastRoomPositions.length - 1];
      const firstPos = this.lastRoomPositions[0];
      const netMovement = lastPos.x - firstPos.x;

      if (Math.abs(netMovement) < 10) {
        this.forcedEscapeDir =
          this.preferredDirection === 'RIGHT' ? 'LEFT' : 'RIGHT';
      } else {
        this.forcedEscapeDir = netMovement > 0 ? 'LEFT' : 'RIGHT';
      }

      return true;
    }

    if (this.loopDetected) {
      const escapeDuration = this.stepIndex - this.forcedEscapeTick;
      if (escapeDuration > 60) {
        this.loopDetected = false;
        this.forcedEscapeDir = null;
        this.stuckInRoomTicks = 0;
        this.lastRoomPositions = [];
      }
      return true;
    }

    return false;
  }

  // Evasão inteligente da SA-X: considera se a SA-X está bloqueando a rota
  private improvedEvadeSax(
    motionPct: number,
    wram: MetroidWramSnapshot,
    pursuer: { x: number; y: number; dist: number; saxKind?: string },
    doors: Array<{ key: string; x: number; y: number; blockedByWall: boolean }>,
  ): { keys: AIKey[]; dir: 'LEFT' | 'RIGHT'; reason: string } | null {
    if (!pursuer) return null;

    const { shoot: shootKey, jump: jumpKey, run: dashKey } = wram.controls;
    const safeDist = pursuer.saxKind === 'SAX_MONSTER' ? 88 : 64;
    const tooClose = pursuer.dist < safeDist;

    const saxBlockedRoute = doors.some((d) => {
      const distFromSaxToDoor = Math.hypot(d.x - pursuer.x, d.y - pursuer.y);
      const distFromSamusToDoor = Math.hypot(d.x - wram.samusX, d.y - wram.samusY);
      return !d.blockedByWall && distFromSaxToDoor < 120 && distFromSaxToDoor < distFromSamusToDoor + 40;
    });

    if (saxBlockedRoute && !this.saxBlocksRoute) {
      this.saxBlocksRoute = true;
      this.saxBlockRouteTick = this.stepIndex;
      this.alternateEscapeDir = pursuer.x >= wram.samusX ? 'LEFT' : 'RIGHT';
    }

    if (this.saxBlocksRoute && this.stepIndex - this.saxBlockRouteTick < 30) {
      const escapeDir = this.alternateEscapeDir ?? (pursuer.x >= wram.samusX ? 'LEFT' : 'RIGHT');
      const keys: AIKey[] = [escapeDir, dashKey];
      if (this.nextJump(true, 3)) keys.push(jumpKey);
      if (this.nextShoot(true)) keys.push(shootKey);
      return {
        keys,
        dir: escapeDir,
        reason: 'SA-X bloqueando rota · usando caminho alternativo',
      };
    }

    if (this.saxBlocksRoute && this.stepIndex - this.saxBlockRouteTick >= 30) {
      this.saxBlocksRoute = false;
      this.alternateEscapeDir = null;
    }

    const fleeDir: AIKey = tooClose
      ? (pursuer.x >= wram.samusX ? 'LEFT' : 'RIGHT')
      : pursuer.x >= wram.samusX
        ? 'LEFT'
        : 'RIGHT';

    const keys: AIKey[] = [fleeDir, dashKey];
    const wantsJump = tooClose || Math.abs(pursuer.y - wram.samusY) < 28 || this.stepIndex % 4 === 0;
    if (this.nextJump(wantsJump, 3)) keys.push(jumpKey);
    if (this.nextShoot(true)) keys.push(shootKey);

    return {
      keys,
      dir: fleeDir,
      reason: `Fugindo da SA-X (${Math.round(pursuer.dist)}px)`,
    };
  }

  private buildSnapshot(
    mode: AgentBehaviorMode,
    keys: AIKey[],
    sceneLabel: string,
    reason: string,
    wram: MetroidWramSnapshot | null,
    saxThreat: boolean,
    saxCombatReady: boolean,
    uSearchPhase: USearchPhase = 'NONE',
  ): AIStatusSnapshot {
    const baseLabel = BEHAVIOR_LABELS[mode];
    const behaviorLabel =
      mode === 'EXPLORE' && uSearchPhase !== 'NONE' ? `${baseLabel} · Busca em U` : baseLabel;

    return {
      mode,
      behaviorLabel,
      uSearchPhase,
      keys,
      sceneLabel,
      reason,
      health: wram?.health,
      maxHealth: wram?.maxHealth,
      reserveEnergy: wram?.reserveEnergy,
      reserveMax: wram?.reserveMax,
      missiles: wram?.missiles,
      supers: wram?.supers,
      powerBombs: wram?.powerBombs,
      roomId: wram?.roomId,
      abilities: wram?.abilities ?? [],
      pendingBacktracks: this.pendingTargets.length,
      saxThreat,
      saxCombatReady,
      ignoredBackgroundCount: wram ? this.lastIgnoredBgCount : undefined,
      armorAnalysis: wram?.armorAnalysis,
      detectedEntity: wram && this.activeSpecialEntity !== 'NONE' ? this.activeSpecialEntity : undefined,
      detectedEntityLabel: wram && this.activeSpecialLabel ? this.activeSpecialLabel : undefined,
      coreXStage: wram ? this.activeCoreXStage : null,
      countdownActive: wram?.countdownActive,
      countdownSeconds: wram?.countdownSeconds,
      energyResetDetected: this.lastEnergyResetTick === this.stepIndex,
      // Sistema de loadout: mostra quais habilidades/armadura/ferramentas o agente tem
      agentLoadout: wram ? this.getAgentLoadout(wram) : undefined,
      // Sistema de exploração do mapa
      mapExploration: wram
        ? {
            roomsExplored: this.roomsExplored.size,
            mapFullyExplored: this.mapFullyExplored,
          }
        : undefined,
      // Sistema de interação com objetos/terminal/energia
      interaction: wram
        ? {
            nearbyObjects: this.interactiveObjects
              .filter((o) => {
                const dist = Math.hypot(o.x - wram.samusX, o.y - wram.samusY);
                return dist < 120;
              })
              .map((o) => ({
                type: o.type,
                x: o.x,
                y: o.y,
                priority: o.priority,
                interacted: o.interacted,
              })),
            currentTarget: this.currentInteractionTarget
              ? this.currentInteractionTarget.type
              : null,
            powerAuxActivated: this.powerAuxActivated,
            roomsWithPowerIssue: this.roomsWithPowerIssue.size,
            stuckInRoomTicks: this.stuckInRoomTicks,
          }
        : undefined,
    };
  }

  decide(
    frame: CapturedFrame,
    profile: AIProfile,
    targetDifficulty: string,
    wram: MetroidWramSnapshot | null = null,
  ): AIAction {
    this.stepIndex++;
    this.lastCapturedFrame = frame;
    const shouldAnalyzePixels = !(wram && wram.valid && frame.fresh === false);
    const m = shouldAnalyzePixels ? this.analyzeFrame(frame) : this.lastMetrics;
    this.lastMetrics = m;
    const motionPct = Math.round(m.totalMotion * 1000) / 10;

    // Se a memória do SNES está válida (detectada como Super Metroid por readMetroidWram),
    // use a IA de WRAM independente do perfil escolhido. O perfil 'rpg' não deve bloquear
    // a inteligência real de Metroid (salas, portas, chefes, itens, SA-X, Core-X).
    if (wram && wram.valid) {
      return this.decideMetroidReal(m, motionPct, targetDifficulty, wram);
    }

    return this.decideUniversalVision(m, motionPct, profile, targetDifficulty);
  }

  private makeMetroidAction(
    mode: AgentBehaviorMode,
    keys: AIKey[],
    time: number,
    phase: 'menu' | 'run',
    motionPct: number,
    sceneLabel: string,
    reason: string,
    wram: MetroidWramSnapshot,
    saxThreat = false,
    saxCombatReady = false,
    uSearchPhase: USearchPhase = 'NONE',
  ): AIAction {
    this.currentMode = mode;
    const learnedKnowledge =
      this.pendingLearnedKnowledge.length > 0 ? this.pendingLearnedKnowledge.splice(0) : undefined;
    return {
      key: keys[0] ?? 'NONE',
      keys,
      time,
      phase,
      motionPct,
      sceneLabel,
      reason,
      snapshot: this.buildSnapshot(mode, keys, sceneLabel, reason, wram, saxThreat, saxCombatReady, uSearchPhase),
      learnedKnowledge,
    };
  }

  private updateEnemyTracks(wram: MetroidWramSnapshot, samusDamagedThisTick: boolean): void {
    const activeSlots = new Set<number>();
    let dynamicStaticCount = 0;

    for (const e of wram.enemies) {
      activeSlots.add(e.slot);
      const existing = this.enemyTracks.get(e.slot);
      if (!existing || existing.id !== e.id) {
        this.enemyTracks.set(e.slot, {
          slot: e.slot,
          id: e.id,
          initX: e.x,
          initY: e.y,
          lastX: e.x,
          lastY: e.y,
          totalMoved: 0,
          initHp: e.hp,
          lastHp: e.hp,
          seenTicks: 1,
          combatTicks: 0,
          hostileConfirmed: false,
          ignoredAsStatic: false,
        });
        continue;
      }

      const stepMove = Math.hypot(e.x - existing.lastX, e.y - existing.lastY);
      existing.totalMoved += stepMove;
      existing.lastX = e.x;
      existing.lastY = e.y;
      existing.seenTicks++;

      // Confirmou que é inimigo real: sofreu dano, move-se pelo mapa ou causou dano na Samus
      if (e.hp < existing.initHp || e.hp < existing.lastHp) {
        existing.hostileConfirmed = true;
        existing.ignoredAsStatic = false;
      }
      existing.lastHp = e.hp;

      if (stepMove >= 2 || existing.totalMoved >= 6) {
        existing.hostileConfirmed = true;
        existing.ignoredAsStatic = false;
      }

      const distToSamus = Math.hypot(e.x - wram.samusX, e.y - wram.samusY);
      if (samusDamagedThisTick && distToSamus < 104) {
        existing.hostileConfirmed = true;
        existing.ignoredAsStatic = false;
      }

      // Ignora elementos estáticos/visuais do cenário que não atacam nem sofrem dano (nunca ignora chefes/Core-X)
      const isBossLike =
        e.hp >= 450 ||
        (e.xRadius >= 18 && e.yRadius >= 18) ||
        Boolean(existing.isCoreX) ||
        Boolean(existing.specialType && existing.specialType !== 'NONE');
      if (!existing.hostileConfirmed && !isBossLike) {
        if (existing.combatTicks >= 4 && e.hp >= existing.initHp && existing.totalMoved <= 3) {
          existing.ignoredAsStatic = true;
        } else if (existing.seenTicks >= 8 && existing.totalMoved <= 2 && e.hp === existing.initHp) {
          existing.ignoredAsStatic = true;
        }
      }

      if (existing.ignoredAsStatic) {
        dynamicStaticCount++;
      }
    }

    for (const slot of this.enemyTracks.keys()) {
      if (!activeSlots.has(slot)) {
        this.enemyTracks.delete(slot);
      }
    }

    this.lastIgnoredBgCount = wram.ignoredBackgroundEnemies + dynamicStaticCount;
  }

  private syncRoomAndProgress(wram: MetroidWramSnapshot): {
    unlockedLabel: string | null;
    hitKnownBlocked: boolean;
  } {
    const { unlockedLabel, energyOrStateReset } = this.checkAbilitiesProgress(wram);
    if (wram.roomId !== 0 && wram.roomId !== this.lastRoomId) {
      const prevRoomId = this.lastRoomId;
      const prevDoorKey = this.activeDoorKey;
      if (prevRoomId > 0) {
        const prevNode = this.getOrCreateRoom(prevRoomId);
        const currNode = this.getOrCreateRoom(wram.roomId);
        prevNode.exits[this.moveDir] = wram.roomId;
        const backDir = this.moveDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
        currNode.exits[backDir] = prevRoomId;

        const physicalExitedDoor =
          this.lastRoomDoorsSnapshot.length > 0
            ? [...this.lastRoomDoorsSnapshot]
                .filter((d) => Math.hypot(d.x - this.prevSamusX, d.y - this.prevSamusY) <= 104)
                .sort(
                  (a, b) =>
                    Math.hypot(a.x - this.prevSamusX, a.y - this.prevSamusY) -
                    Math.hypot(b.x - this.prevSamusX, b.y - this.prevSamusY),
                )[0]
            : undefined;
        const linkDoorKey = physicalExitedDoor?.key ?? prevDoorKey;
        if (linkDoorKey) {
          prevNode.doorLinks.set(linkDoorKey, wram.roomId);
          const pd = prevNode.doors.get(linkDoorKey);
          if (pd) {
            pd.targetRoomId = wram.roomId;
            pd.locked = false;
          }
        }
      }

      this.lastRoomId = wram.roomId;
      // Rastreia salas exploradas para detectar quando o mapa foi "ganho"
      if (!this.roomsExplored.has(wram.roomId)) {
        this.roomsExplored.add(wram.roomId);
        // Verifica se o mapa foi explorado o suficiente
        if (!this.mapFullyExplored && this.roomsExplored.size >= this.mapExploredThreshold) {
          this.mapFullyExplored = true;
          this.lastMapCheckTick = this.stepIndex;
        }
      }
      // Reset do contador de preso ao entrar em nova sala
      this.stuckInRoomTicks = 0;
      this.lastRoomEntryTick = this.stepIndex;
      this.activeDoorKey = null;
      this.entryDoorKey = null;
      this.roomTicks = 0;
      this.roomSpawnX = wram.samusX;
      this.roomSpawnY = wram.samusY;
      this.roomMovedOnce = false;
      this.anchorX = wram.samusX;
      this.anchorY = wram.samusY;
      this.prevSamusX = wram.samusX;
      this.prevSamusY = wram.samusY;
      this.samusVx = 0;
      this.samusVy = 0;
      this.sameYStreak = 0;
      this.progressStallTicks = 0;
      this.missileProbeCount = 0;
      this.recentBlockedSpots = [];
      this.itemChaseTicks = 0;
      this.jumpHoldRemaining = 0;
      this.enemyTracks.clear();
      this.lastIgnoredBgCount = 0;
      this.activeSpecialEntity = 'NONE';
      this.activeSpecialLabel = '';
      this.activeCoreXStage = null;
      this.lastCoreXWasRedTick = -200;
      this.lastCoreXWasRedRoomId = -1;
      this.resetUSearch();

      const currNode = this.getOrCreateRoom(wram.roomId);
      for (const door of wram.doors) {
        if (!currNode.doors.has(door.key)) {
          currNode.doors.set(door.key, {
            key: door.key,
            side: door.side,
            locked: door.blockedByWall,
            missileProbes: 0,
            lastVisitedTick: 0,
          });
        } else if (door.blockedByWall) {
          currNode.doors.get(door.key)!.locked = true;
        }
      }

      if (prevRoomId > 0 && wram.doors.length > 0) {
        const nearestDoor = [...wram.doors].sort(
          (a, b) => Math.hypot(a.x - wram.samusX, a.y - wram.samusY) - Math.hypot(b.x - wram.samusX, b.y - wram.samusY),
        )[0];
        if (nearestDoor && Math.hypot(nearestDoor.x - wram.samusX, nearestDoor.y - wram.samusY) < 96) {
          this.entryDoorKey = nearestDoor.key;
          currNode.doorLinks.set(nearestDoor.key, prevRoomId);
          const ed = currNode.doors.get(nearestDoor.key);
          if (ed) ed.targetRoomId = prevRoomId;
        }
      }

      if (currNode.triedRight && !currNode.triedLeft) {
        this.moveDir = 'LEFT';
      } else if (currNode.triedLeft && !currNode.triedRight) {
        this.moveDir = 'RIGHT';
      } else if (wram.roomWidthPx > 0 && wram.samusX > wram.roomWidthPx * 0.72) {
        this.moveDir = 'LEFT';
      } else if (wram.roomWidthPx > 0 && wram.samusX < wram.roomWidthPx * 0.28) {
        this.moveDir = 'RIGHT';
      } else {
        this.moveDir = 'RIGHT';
      }
    } else if (wram.roomId > 0 && wram.doors.length > 0) {
      const currNode = this.getOrCreateRoom(wram.roomId);
      for (const door of wram.doors) {
        if (!currNode.doors.has(door.key)) {
          currNode.doors.set(door.key, {
            key: door.key,
            side: door.side,
            locked: door.blockedByWall,
            missileProbes: 0,
            lastVisitedTick: 0,
          });
        }
      }
    }
    this.lastRoomDoorsSnapshot = wram.doors;

    this.roomTicks++;
    if (!this.roomMovedOnce && Math.hypot(wram.samusX - this.roomSpawnX, wram.samusY - this.roomSpawnY) >= 3) {
      this.roomMovedOnce = true;
    }

    let samusDamagedThisTick = false;
    let samusBigHealThisTick = false;
    if (!energyOrStateReset && this.prevHealth > 0 && wram.health > 0) {
      const deltaHp = this.prevHealth - wram.health;
      if (deltaHp >= 6) {
        samusDamagedThisTick = true;
      }
      if (deltaHp >= 25) {
        this.recentDamageSpikeTick = this.stepIndex;
        // Aprendizado de falhas: marca a célula atual como perigosa para evitar no futuro
        const bx = Math.floor(wram.samusX / 16);
        const by = Math.floor(wram.samusY / 16);
        this.dangerCells.add(`${wram.roomId}:${bx},${by}`);
      } else if (wram.health > this.prevHealth + 15) {
        // Energia recarregada/resetada pelo Metroid Grande, estação ou tanque de reserva
        this.recentDamageSpikeTick = -100;
        if (wram.health - this.prevHealth >= 45 && this.bigMetroidDrainSeen) {
          samusBigHealThisTick = true;
        }
      }
    }
    this.prevHealth = wram.health;

    if (samusBigHealThisTick) {
      this.bigMetroidHealedTick = this.stepIndex;
      this.pendingLearnedKnowledge.push({
        entityType: 'BIG_METROID',
        entityLabel: 'Metroid Grande (Aliado)',
        powerId: 'big-metroid-rescue',
        powerName: 'Cura e Desativação da SA-X',
        powerEffect: 'Restaura sua energia e desativa temporariamente a SA-X para o contra-ataque',
        roomId: wram.roomId,
      });
    }

    this.updateEnemyTracks(wram, samusDamagedThisTick);

    this.samusVx = wram.samusX - this.prevSamusX;
    this.samusVy = wram.samusY - this.prevSamusY;
    this.prevSamusX = wram.samusX;
    if (Math.abs(this.samusVy) <= 1) {
      this.sameYStreak++;
    } else {
      this.sameYStreak = 0;
    }
    this.prevSamusY = wram.samusY;

    if (this.uSearch.cooldown > 0) {
      this.uSearch.cooldown--;
    }

    if (!this.uSearch.active) {
      const horizDist = Math.abs(wram.samusX - this.anchorX);
      const vertMoved = Math.abs(wram.samusY - this.anchorY) >= 28;

      if (horizDist >= 20 || vertMoved) {
        this.anchorX = wram.samusX;
        this.anchorY = wram.samusY;
        this.progressStallTicks = 0;
        if (horizDist >= 40) {
          this.missileProbeCount = 0;
        }
      } else if (this.roomMovedOnce) {
        this.progressStallTicks++;
        this.stuckInRoomTicks++;
      }
    }

    // Decrementa cooldown de interação
    if (this.interactionCooldown > 0) {
      this.interactionCooldown--;
    }

    const hitKnownBlocked =
      !this.uSearch.active &&
      this.progressStallTicks >= 5 &&
      this.recentBlockedSpots.some(
        (b) => b.dir === this.moveDir && Math.abs(b.x - wram.samusX) < 28 && Math.abs(b.y - wram.samusY) < 40,
      );

    return { unlockedLabel, hitKnownBlocked };
  }

  private resolveBlockType(wram: MetroidWramSnapshot, bx: number, by: number): number {
    const bt = wram.blockTypes;
    const bts = wram.btsBytes;
    const rw = wram.roomWidthBlocks;
    const rh = wram.roomHeightBlocks;
    if (!bt || rw <= 0 || rh <= 0) return 0x8;
    let cx = bx;
    let cy = by;
    for (let hop = 0; hop < 8; hop++) {
      if (cx < 0 || cy < 0 || cx >= rw || cy >= rh) return 0x8;
      const idx = cy * rw + cx;
      const t = bt[idx];
      if (t === 0x5) {
        const raw = bts ? bts[idx] : 0xff;
        cx += raw === 0 ? -1 : raw >= 128 ? raw - 256 : raw;
        continue;
      }
      if (t === 0xd) {
        const raw = bts ? bts[idx] : 0xff;
        cy += raw === 0 ? -1 : raw >= 128 ? raw - 256 : raw;
        continue;
      }
      return t;
    }
    return 0x8;
  }

  // Verifica se Samus está pisando em chão sólido (bloco floor abaixo dos pés),
  // em vez de confiar apenas no proxy sameYStreak.
  private isSamusGrounded(wram: MetroidWramSnapshot): boolean {
    const bt = wram.blockTypes;
    const rw = wram.roomWidthBlocks;
    const rh = wram.roomHeightBlocks;
    if (!bt || rw <= 0 || rh <= 0) return false;
    const bx = Math.max(0, Math.min(rw - 1, Math.floor(wram.samusX / 16)));
    const by = Math.max(1, Math.min(rh - 2, Math.floor(wram.samusY / 16)));
    const below = this.resolveBlockType(wram, bx, by + 1);
    const isSolidFloor =
      below === 0x8 ||
      below === 0xa ||
      below === 0x1 ||
      below === 0xb ||
      below === 0xc ||
      below === 0xe ||
      below === 0xf ||
      (below === 0x9 && by === rh - 1);
    return isSolidFloor;
  }

  private planPathInRoom(
    wram: MetroidWramSnapshot,
    targets: Array<{ key: string; bx: number; by: number; priority: number }>,
  ): TilePathStep | null {
    const bt = wram.blockTypes;
    const rw = wram.roomWidthBlocks;
    const rh = wram.roomHeightBlocks;
    if (!bt || rw <= 0 || rh <= 0 || targets.length === 0) return null;

    const tAt = (bx: number, by: number): number => this.resolveBlockType(wram, bx, by);

    const hasMorph = (wram.itemsMask & 0x0004) !== 0;
    const hasBombs = (wram.itemsMask & 0x1000) !== 0;
    const hasBombBreak = (hasMorph && hasBombs) || wram.powerBombs > 0;
    const hasHiJump = (wram.itemsMask & 0x0100) !== 0;
    const hasSpaceJump = (wram.itemsMask & 0x0200) !== 0;
    const maxJumpH = hasSpaceJump ? 14 : hasHiJump ? 7 : 5;

    const isCellAir = (bx: number, by: number, allowBreakable: boolean): boolean => {
      if (bx < 0 || by < 0 || bx >= rw || by >= rh) return false;
      const t = tAt(bx, by);
      if (t === 0x8 || t === 0xa || t === 0xe) return false;
      if (t === 0xf) {
        return allowBreakable && hasBombBreak && !this.unbreakableGates.has(`${wram.roomId}:${bx},${by}`);
      }
      if (t === 0xc) {
        return allowBreakable && !this.unbreakableGates.has(`${wram.roomId}:${bx},${by}`);
      }
      return true;
    };

    const isBodyFree = (bx: number, by: number, allowBreakable: boolean): boolean => {
      if (!isCellAir(bx, by, allowBreakable)) return false;
      if (hasMorph) return true;
      return isCellAir(bx, by - 1, allowBreakable);
    };

    const isFloorTile = (bx: number, by: number): boolean => {
      if (bx < 0 || by < 0 || bx >= rw || by >= rh) return true;
      const t = tAt(bx, by);
      return (
        t === 0x8 ||
        t === 0xa ||
        t === 0x1 ||
        t === 0xb ||
        t === 0xc ||
        t === 0xe ||
        t === 0xf ||
        (t === 0x9 && by === rh - 1)
      );
    };

    const isStandable = (bx: number, by: number, allowBreakable: boolean): boolean =>
      isBodyFree(bx, by, allowBreakable) && isFloorTile(bx, by + 1) && tAt(bx, by + 1) !== 0xa;

    const isHazardCeiling = (bx: number, by: number): boolean =>
      tAt(bx, by - 1) === 0xa || tAt(bx, by - 2) === 0xa;

    const hasVertClear = (bx: number, fromBy: number, toBy: number, allowBreakable: boolean): boolean => {
      for (let cy = fromBy; cy >= toBy; cy--) {
        if (!isBodyFree(bx, cy, allowBreakable)) return false;
      }
      return true;
    };

    const hasDirectTargetSight = (cx: number, cy: number, tx: number, ty: number): boolean => {
      const sySign = ty === cy ? 0 : ty > cy ? 1 : -1;
      for (let y = cy; y !== ty; y += sySign) {
        if (y !== cy && !isCellAir(cx, y, false)) return false;
      }
      const sxSign = tx === cx ? 0 : tx > cx ? 1 : -1;
      for (let x = cx; x !== tx; x += sxSign) {
        if (x !== cx && !isCellAir(x, ty, false)) return false;
      }
      return true;
    };

    let startBx = Math.max(0, Math.min(rw - 1, Math.floor(wram.samusX / 16)));
    let startBy = Math.max(1, Math.min(rh - 2, Math.floor(wram.samusY / 16)));
    const wasAirborne = !isStandable(startBx, startBy, true) && isBodyFree(startBx, startBy, true);

    if (!wasAirborne && !isStandable(startBx, startBy, true)) {
      let found = false;
      for (let dy = 0; dy <= 16; dy++) {
        if (isStandable(startBx, startBy + dy, true)) {
          startBy += dy;
          found = true;
          break;
        }
      }
      if (!found) {
        for (let dy = 0; dy <= 16 && !found; dy++) {
          for (const dx of [-1, 1]) {
            const cx = startBx + dx;
            const cy = startBy + dy;
            if (isStandable(cx, cy, true)) {
              startBx = cx;
              startBy = cy;
              found = true;
              break;
            }
          }
        }
      }
      if (!found) {
        for (let dy = -1; dy >= -3 && !found; dy--) {
          if (isStandable(startBx, startBy + dy, true)) {
            startBy += dy;
            found = true;
          }
        }
      }
    }

    // Posições de inimigos ativos para evitar no pathfinding (obstáculos dinâmicos)
    const enemyCells: Array<{ bx: number; by: number; distPx: number }> = [];
    for (const e of wram.enemies) {
      if (e.hp <= 0) continue;
      const d = Math.hypot(e.x - wram.samusX, e.y - wram.samusY);
      if (d > 220) continue; // só considera inimigos próximos
      enemyCells.push({
        bx: Math.max(0, Math.min(rw - 1, Math.floor(e.x / 16))),
        by: Math.max(1, Math.min(rh - 2, Math.floor(e.y / 16))),
        distPx: d,
      });
    }

    const isNearEnemy = (bx: number, by: number): boolean => {
      const dangerKey = `${wram.roomId}:${bx},${by}`;
      if (this.dangerCells.has(dangerKey)) return true;
      for (const ec of enemyCells) {
        const dx = Math.abs(bx - ec.bx);
        const dy = Math.abs(by - ec.by);
        if (dx <= 2 && dy <= 2) return true; // célula ocupada ou adjacente a inimigo
      }
      return false;
    };

    const total = rw * rh;
    const dist = new Int32Array(total).fill(0x3f3f3f3f);
    const closed = new Uint8Array(total);
    const parent = new Int32Array(total).fill(-1);
    const stepMeta: Array<{
      dir: 'LEFT' | 'RIGHT';
      jump: boolean;
      drop: boolean;
      shoot: boolean;
      bomb: boolean;
      wpBx: number;
      wpBy: number;
      viaBreakable: boolean;
    } | null> = new Array(total).fill(null);

    const startIdx = startBy * rw + startBx;
    dist[startIdx] = 0;

    // Min-heap simples de índices por menor custo real (Dijkstra)
    const heap: number[] = [startIdx];
    const heapPush = (node: number) => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (dist[heap[p]] <= dist[heap[i]]) break;
        const tmp = heap[p];
        heap[p] = heap[i];
        heap[i] = tmp;
        i = p;
      }
    };
    const heapPop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        while (true) {
          const l = i * 2 + 1;
          const r = l + 1;
          let smallest = i;
          if (l < heap.length && dist[heap[l]] < dist[heap[smallest]]) smallest = l;
          if (r < heap.length && dist[heap[r]] < dist[heap[smallest]]) smallest = r;
          if (smallest === i) break;
          const tmp = heap[i];
          heap[i] = heap[smallest];
          heap[smallest] = tmp;
          i = smallest;
        }
      }
      return top;
    };

    const relaxEdge = (
      fromIdx: number,
      nx: number,
      ny: number,
      edgeCost: number,
      dir: 'LEFT' | 'RIGHT',
      jump: boolean,
      drop: boolean,
      shoot: boolean,
      viaBreakable: boolean,
      bomb = false,
      wpOverrideBx?: number,
      wpOverrideBy?: number,
    ) => {
      if (nx < 0 || ny < 1 || nx >= rw || ny >= rh - 1) return;
      const nIdx = ny * rw + nx;
      if (closed[nIdx]) return;
      let nextCost = dist[fromIdx] + edgeCost;
      // Penaliza células próximas a inimigos ativos para evitar caminhar direto neles
      if (isNearEnemy(nx, ny)) nextCost += 40;
      if (nextCost < dist[nIdx]) {
        dist[nIdx] = nextCost;
        parent[nIdx] = fromIdx;
        stepMeta[nIdx] = {
          dir,
          jump,
          drop,
          shoot,
          bomb,
          wpBx: wpOverrideBx ?? nx,
          wpBy: wpOverrideBy ?? ny,
          viaBreakable,
        };
        heapPush(nIdx);
      }
    };

    let expanded = 0;
    const maxExpand = Math.min(total, 4800);
    while (heap.length > 0 && expanded < maxExpand) {
      const idx = heapPop();
      if (closed[idx]) continue;
      closed[idx] = 1;
      expanded++;

      const bx = idx % rw;
      const by = Math.floor(idx / rw);
      const isStartAirborne = idx === startIdx && wasAirborne;

      // 0) Se iniciou no ar (pulo em curva sobre saliências ou queda livre em direção a poços/eixos)
      if (isStartAirborne && !hasSpaceJump) {
        for (let fall = 0; fall <= rh - 2 - by; fall++) {
          const fy = by + fall;
          if (!isBodyFree(bx, fy, true)) break;
          for (const drift of [0, -1, 1, -2, 2]) {
            const fx = bx + drift;
            if (fx < 0 || fx >= rw) continue;
            const sgn = drift > 0 ? 1 : -1;
            let driftClear = true;
            for (let sx = 0; sx !== drift; sx += sgn) {
              if (!isBodyFree(bx + sx + sgn, Math.max(1, fy - 1), true)) {
                driftClear = false;
                break;
              }
            }
            if (!driftClear) continue;
            if (isStandable(fx, fy, true)) {
              const airDir: 'LEFT' | 'RIGHT' =
                drift !== 0 ? (drift > 0 ? 'RIGHT' : 'LEFT') : bx >= rw / 2 ? 'LEFT' : 'RIGHT';
              relaxEdge(idx, fx, fy, 1 + Math.abs(drift) + Math.floor(fall / 2), airDir, false, true, false, false);
            }
          }
        }
        for (let dy = -1; dy >= -4; dy--) {
          const ny = by + dy;
          if (ny < 1) break;
          if (!hasVertClear(bx, by, ny, false)) break;
          for (let dx = -3; dx <= 3; dx++) {
            const tx = bx + dx;
            if (tx < 0 || tx >= rw || !isStandable(tx, ny, true)) continue;
            if (isHazardCeiling(tx, ny)) continue;
            const stepSign = dx >= 0 ? 1 : -1;
            let clear = true;
            for (let cx = 0; Math.abs(cx) <= Math.abs(dx); cx += stepSign) {
              if (!isBodyFree(bx + cx, ny, true)) {
                clear = false;
                break;
              }
            }
            if (!clear) continue;
            const airDir: 'LEFT' | 'RIGHT' =
              dx !== 0 ? (dx > 0 ? 'RIGHT' : 'LEFT') : bx >= rw / 2 ? 'LEFT' : 'RIGHT';
            relaxEdge(idx, tx, ny, 1 + Math.abs(dx) + Math.abs(dy), airDir, true, false, false, false);
          }
        }
      }

      // 1) Caminhada horizontal, rampas, escadas diagonais e degraus de 1 bloco
      for (const dx of [-1, 1] as const) {
        const dir: 'LEFT' | 'RIGHT' = dx > 0 ? 'RIGHT' : 'LEFT';
        const nx = bx + dx;
        if (nx < 0 || nx >= rw) continue;

        for (const dy of [0, -1, 1]) {
          const ny = by + dy;
          if (ny < 1 || ny >= rh - 1) continue;
          const tileT = tAt(nx, ny);
          const isBombTile = tileT === 0xf;
          const isShotGate = tileT === 0xc;
          const isGate = isShotGate || isBombTile;
          if (isStandable(nx, ny, true)) {
            if (dy === -1 && !isCellAir(bx, by - 1, true)) continue;
            if (dy === 1 && !isCellAir(nx, by, true)) continue;
            const needJump = dy === -1 && tAt(nx, ny + 1) !== 0x1 && !isHazardCeiling(nx, ny);
            const hazardPen = dy < 0 && isHazardCeiling(nx, ny) ? 4 : 0;
            const cost = (needJump ? 2 : 1) + (isGate ? 3 : 0) + hazardPen;
            relaxEdge(idx, nx, ny, cost, dir, needJump, false, isGate, isGate, isBombTile);
          }
        }

        // 2) Queda livre de plataformas/bordas com curvatura lateral no ar (Imagens 1 e 7)
        if (isBodyFree(nx, by, true) && !isFloorTile(nx, by + 1)) {
          for (let fall = 1; fall <= rh - 2 - by; fall++) {
            const fy = by + fall;
            if (!isBodyFree(nx, fy, true)) break;
            if (isStandable(nx, fy, true)) {
              relaxEdge(idx, nx, fy, 1 + Math.floor(fall / 2), dir, false, true, false, false);
              break;
            }
            const driftList = fall >= 3 ? [dx, -dx, -2 * dx] : [dx, -dx];
            for (const drift of driftList) {
              const fx = nx + drift;
              if (fx < 0 || fx >= rw) continue;
              const sgn = drift > 0 ? 1 : -1;
              let driftClear = true;
              for (let sx = sgn; Math.abs(sx) <= Math.abs(drift); sx += sgn) {
                if (!isBodyFree(nx + sx, Math.max(1, fy - 1), true)) {
                  driftClear = false;
                  break;
                }
              }
              if (driftClear && isStandable(fx, fy, true)) {
                relaxEdge(
                  idx,
                  fx,
                  fy,
                  2 + Math.abs(drift) + Math.floor(fall / 2),
                  dir,
                  false,
                  true,
                  false,
                  false,
                  false,
                  nx,
                  fy,
                );
              }
            }
          }
        }
      }

      // 2b) Quebra/queda através do piso abaixo (0xB crumble, 0xC tiro p/ baixo, 0xF bomba p/ baixo - Imagem 7)
      if (!isStartAirborne && by + 2 < rh - 1) {
        const floorT = tAt(bx, by + 1);
        const canBreakFloor =
          floorT === 0xb ||
          ((floorT === 0xc || (floorT === 0xf && hasBombBreak)) &&
            !this.unbreakableGates.has(`${wram.roomId}:${bx},${by + 1}`));
        if (canBreakFloor && isCellAir(bx, by + 2, true)) {
          for (let fall = 2; fall <= rh - 2 - by; fall++) {
            const fy = by + fall;
            if (!isBodyFree(bx, fy, true)) break;
            const dropDir: 'LEFT' | 'RIGHT' = bx >= rw / 2 ? 'LEFT' : 'RIGHT';
            if (isStandable(bx, fy, true)) {
              relaxEdge(
                idx,
                bx,
                fy,
                (floorT === 0xb ? 1 : 3) + Math.floor(fall / 2),
                dropDir,
                false,
                true,
                floorT === 0xc,
                floorT === 0xc || floorT === 0xf,
                floorT === 0xf,
                bx,
                by + 1,
              );
              break;
            }
            for (const drift of [-1, 1]) {
              const fx = bx + drift;
              if (isBodyFree(fx, fy, true) && isStandable(fx, fy, true)) {
                relaxEdge(
                  idx,
                  fx,
                  fy,
                  (floorT === 0xb ? 2 : 4) + Math.floor(fall / 2),
                  drift > 0 ? 'RIGHT' : 'LEFT',
                  false,
                  true,
                  floorT === 0xc,
                  floorT === 0xc || floorT === 0xf,
                  floorT === 0xf,
                  bx,
                  by + 1,
                );
              }
            }
          }
        }
      }

      // 3) Saltos em arco (respeita teto/saliências e contorna pilares antes de subir - Imagens 4, 5 e 6)
      for (let dy = -1; dy >= -maxJumpH; dy--) {
        const ny = by + dy;
        if (ny < 1) break;
        const straightHeadClear = hasVertClear(bx, by - 1, ny, false);

        for (let dx = -4; dx <= 4; dx++) {
          if (dx === 0) continue;
          const tx = bx + dx;
          if (tx < 0 || tx >= rw) continue;
          if (!isStandable(tx, ny, true)) continue;
          if (isHazardCeiling(tx, ny) && tAt(tx, ny - 1) === 0xa) continue;

          const tGate = tAt(tx, ny) === 0xc || tAt(tx, ny) === 0xf;
          const isBombTile = tAt(tx, ny) === 0xf;
          const hazardPen = isHazardCeiling(tx, ny) ? 4 : 0;
          const stepSign = dx > 0 ? 1 : -1;
          const adjacentWallBlocksJump = dy <= -3 && !isCellAir(bx + stepSign, by - 1, false);

          if (straightHeadClear && !adjacentWallBlocksJump) {
            let pathClear = true;
            for (let sx = stepSign; Math.abs(sx) <= Math.abs(dx); sx += stepSign) {
              if (!isBodyFree(bx + sx, ny, true)) {
                pathClear = false;
                break;
              }
            }
            if (!pathClear) continue;
            const dir: 'LEFT' | 'RIGHT' = dx > 0 ? 'RIGHT' : 'LEFT';
            const jumpCost = 2 + Math.abs(dx) + Math.abs(dy) + (tGate ? 3 : 0) + hazardPen;
            relaxEdge(idx, tx, ny, jumpCost, dir, true, false, tGate, tGate, isBombTile);
          } else {
            // Saliência/pilar bloqueia subida direta: primeiro recua 1-2 blocos para espaço aberto, depois sobe em arco
            for (const stepOut of [-1, 1, -2, 2]) {
              const ox = bx + stepOut;
              if (ox < 0 || ox >= rw) continue;
              const sgnOut = stepOut > 0 ? 1 : -1;
              let stepClear = true;
              for (let sx = sgnOut; Math.abs(sx) <= Math.abs(stepOut); sx += sgnOut) {
                if (!isBodyFree(bx + sx, by, false)) {
                  stepClear = false;
                  break;
                }
              }
              if (!stepClear) continue;
              if (!hasVertClear(ox, by - 1, ny, false)) continue;

              const sgnToTx = tx >= ox ? 1 : -1;
              let topClear = true;
              for (let cx = ox; cx !== tx + sgnToTx; cx += sgnToTx) {
                if (!isBodyFree(cx, ny, true)) {
                  topClear = false;
                  break;
                }
              }
              if (!topClear) continue;

              const outDir: 'LEFT' | 'RIGHT' = stepOut > 0 ? 'RIGHT' : 'LEFT';
              const stepIsFloor = isStandable(ox, by, false);
              const arcCost = 4 + Math.abs(stepOut) + Math.abs(tx - ox) + Math.abs(dy) + (tGate ? 3 : 0) + hazardPen;
              relaxEdge(idx, tx, ny, arcCost, outDir, !stepIsFloor, false, tGate, tGate, isBombTile, ox, by);
              break;
            }
          }
        }
      }

      // 4) Voo contínuo com Space Jump (contorna passarelas e alcança portas suspensas em poços altos)
      if (hasSpaceJump) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = bx + dx;
            const ny = by + dy;
            if (!isBodyFree(nx, ny, true)) continue;
            const tt = tAt(nx, ny);
            const isBombTile = tt === 0xf;
            const isGate = tt === 0xc || isBombTile;
            const moveDir: 'LEFT' | 'RIGHT' =
              dx !== 0 ? (dx > 0 ? 'RIGHT' : 'LEFT') : bx >= rw / 2 ? 'LEFT' : 'RIGHT';
            const needJump = (dy < 0 || !isFloorTile(nx, ny + 1)) && !isHazardCeiling(nx, ny);
            const needDrop = dy > 0 && !isFloorTile(nx, ny + 1);
            const hazardPen = isHazardCeiling(nx, ny) ? 4 : 0;
            const flyCost = (dy <= 0 ? 2 : 1) + (dx === 0 ? 1 : 0) + (isGate ? 3 : 0) + hazardPen;
            relaxEdge(idx, nx, ny, flyCost, moveDir, needJump, needDrop, isGate, isGate, isBombTile);
          }
        }
      }
    }

    // Seleciona o alvo alcançável com melhor prioridade e menor custo real (com linha desobstruída até o alvo)
    let bestTarget: { key: string; idx: number; score: number } | null = null;
    for (const target of targets) {
      let bestNodeForTarget = -1;
      let bestNodeCost = Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cx = Math.max(0, Math.min(rw - 1, target.bx + dx));
          const cy = Math.max(1, Math.min(rh - 2, target.by + dy));
          const cIdx = cy * rw + cx;
          if (dist[cIdx] < 0x3f3f3f3f && hasDirectTargetSight(cx, cy, target.bx, target.by)) {
            const c = dist[cIdx] + Math.abs(dx) + Math.abs(dy);
            if (c < bestNodeCost) {
              bestNodeCost = c;
              bestNodeForTarget = cIdx;
            }
          }
        }
      }
      if (bestNodeForTarget >= 0) {
        const score = target.priority * 10000 + bestNodeCost;
        if (!bestTarget || score < bestTarget.score) {
          bestTarget = { key: target.key, idx: bestNodeForTarget, score };
        }
      }
    }

    if (!bestTarget) return null;

    // Reconstrói o primeiro passo real desde Samus até o objetivo
    let curr = bestTarget.idx;
    if (curr === startIdx) {
      const t = targets.find((x) => x.key === bestTarget!.key)!;
      const dx = t.bx - startBx;
      return {
        dir: dx < 0 ? 'LEFT' : 'RIGHT',
        jump: t.by < startBy - 1,
        drop: t.by > startBy + 1,
        shoot: true,
        bomb: false,
        wpBx: t.bx,
        wpBy: t.by,
        goalKey: t.key,
        goalDist: Math.abs(t.bx - startBx) + Math.abs(t.by - startBy),
        viaBreakable: false,
      };
    }

    let firstChild = curr;
    while (parent[curr] !== -1 && parent[curr] !== startIdx) {
      curr = parent[curr];
      firstChild = curr;
    }

    const meta = stepMeta[firstChild];
    if (!meta) return null;
    const goalBx = bestTarget.idx % rw;
    const goalBy = Math.floor(bestTarget.idx / rw);
    return {
      dir: meta.dir,
      jump: meta.jump,
      drop: meta.drop,
      shoot: meta.shoot,
      bomb: meta.bomb,
      wpBx: meta.wpBx,
      wpBy: meta.wpBy,
      goalKey: bestTarget.key,
      goalDist: Math.abs(goalBx - startBx) + Math.abs(goalBy - startBy),
      viaBreakable: meta.viaBreakable,
    };
  }

  private sampleEnemyVisuals(wram: MetroidWramSnapshot, enemy: EnemyInfo): SpriteColorProfile | null {
    const frame = this.lastCapturedFrame;
    if (!frame || !frame.rgba || frame.width < 32 || frame.height < 32) return null;

    const cx = Math.round(((enemy.x - wram.cameraX) / 256) * frame.width);
    const cy = Math.round(((enemy.y - wram.cameraY) / 224) * frame.height);
    if (cx < -8 || cx > frame.width + 8 || cy < 16 || cy > frame.height + 8) return null;

    const rx = Math.max(10, Math.min(34, Math.round(enemy.xRadius * 0.95)));
    const ry = Math.max(10, Math.min(32, Math.round(enemy.yRadius * 0.8)));

    const x0 = Math.max(0, cx - rx);
    const x1 = Math.min(frame.width - 1, cx + rx);
    const y0 = Math.max(24, cy - ry); // pula a faixa superior do HUD
    const y1 = Math.min(frame.height - 1, cy + ry);
    if (x1 <= x0 || y1 <= y0) return null;

    const { rgba, width } = frame;
    let total = 0;
    let red = 0;
    let yellowGreen = 0;
    let silverCyan = 0;
    let gold = 0;
    let purple = 0;
    let orange = 0;
    let neonGreen = 0;

    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        total++;

        if (r > 135 && r > g * 1.7 && r > b * 1.7) red++;
        if (g > 105 && r > 80 && b < 90 && g >= r * 0.88) yellowGreen++;
        if (g > 120 && b > 125 && Math.abs(r - g) < 75 && b >= r * 0.88) silverCyan++;
        if (r > 165 && g > 120 && b < 110) gold++;
        if (r > 95 && b > 115 && g < r * 0.78 && g < b * 0.78) purple++;
        if (r > 145 && g >= 60 && g <= 155 && b < 80) orange++;
        if (g > 135 && g > r * 1.25 && g > b * 1.55) neonGreen++;
      }
    }

    if (total === 0) return null;
    return {
      redRatio: red / total,
      yellowGreenRatio: yellowGreen / total,
      silverCyanRatio: silverCyan / total,
      goldRatio: gold / total,
      purpleRatio: purple / total,
      orangeRatio: orange / total,
      neonGreenRatio: neonGreen / total,
    };
  }

  private classifySpecialEntities(
    wram: MetroidWramSnapshot,
    activeEnemies: EnemyInfo[],
  ): {
    omegaIntro: (EnemyInfo & { dist: number }) | null;
    bigMetroid: (EnemyInfo & { dist: number }) | null;
    coreXTarget: (EnemyInfo & { dist: number; stage: CoreXStage }) | null;
    saxPursuer: (EnemyInfo & { dist: number; saxKind: 'SAX_VARIA' | 'SAX_GRAVITY' | 'SAX_MONSTER' }) | null;
    metroidLarva: (EnemyInfo & { dist: number }) | null;
  } {
    let omegaIntro: (EnemyInfo & { dist: number }) | null = null;
    let bigMetroid: (EnemyInfo & { dist: number }) | null = null;
    let coreXTarget: (EnemyInfo & { dist: number; stage: CoreXStage }) | null = null;
    let saxPursuer: (EnemyInfo & { dist: number; saxKind: 'SAX_VARIA' | 'SAX_GRAVITY' | 'SAX_MONSTER' }) | null = null;
    let metroidLarva: (EnemyInfo & { dist: number }) | null = null;

    this.activeSpecialEntity = 'NONE';
    this.activeSpecialLabel = '';
    this.activeCoreXStage = null;
    if (!wram.countdownActive) {
      this.omegaVanishedDuringTimer = false;
    }

    const hasOpenExit = wram.doors.some((d) => !d.blockedByWall);

    for (const e of activeEnemies) {
      const dist = Math.hypot(e.x - wram.samusX, e.y - wram.samusY);
      const track = this.enemyTracks.get(e.slot);
      const colors = this.sampleEnemyVisuals(wram, e);
      const isLarge = (e.xRadius >= 18 && e.yRadius >= 18) || e.xRadius >= 22 || e.yRadius >= 26;

      // 1) Omega Metroid inicial + temporizador (Imagem 1)
      const isEarlyGame = wram.maxHealth <= 199 && (wram.itemsMask & 0x0021) === 0;
      const looksOmega =
        (wram.countdownActive && isEarlyGame && (isLarge || e.hp >= 200)) ||
        (isEarlyGame &&
          isLarge &&
          Boolean(colors && colors.purpleRatio > 0.05 && (colors.goldRatio > 0.025 || colors.orangeRatio > 0.03)));

      if (looksOmega) {
        if (!omegaIntro || dist < omegaIntro.dist) {
          omegaIntro = { ...e, dist };
        }
        if (track) track.specialType = 'OMEGA_INTRO';
        continue;
      }

      // 2) Metroid Grande (Imagem 9 / 10: drena e depois cura Samus)
      const looksBigMetroid =
        isLarge && Boolean(colors && colors.neonGreenRatio > 0.13 && colors.redRatio > 0.06);
      if (looksBigMetroid) {
        if (!bigMetroid || dist < bigMetroid.dist) {
          bigMetroid = { ...e, dist };
        }
        if (track) track.specialType = 'BIG_METROID';
        continue;
      }

      // 3) Core-X em 4 fases visuais: Normal (prata) -> Amarelado -> Vermelho -> Poder Exposto (Imagens 4-7 + Imagem 2 coleta)
      const sawRedCoreXInRoom =
        this.lastCoreXWasRedTick > 0 &&
        this.stepIndex - this.lastCoreXWasRedTick <= 260 &&
        this.lastCoreXWasRedRoomId === wram.roomId;
      const sawAnyCoreXInRoom =
        this.lastCoreXSeenTick > 0 &&
        this.stepIndex - this.lastCoreXSeenTick <= 260 &&
        this.lastCoreXRoomId === wram.roomId;
      const looksGlowingNakedOrb = Boolean(
        colors && colors.silverCyanRatio >= 0.11 && colors.goldRatio >= 0.03 && colors.redRatio < 0.08,
      );

      let detectedCoreStage: CoreXStage | null = null;
      if (
        colors &&
        e.hp > 0 &&
        e.hp < 450 &&
        (e.xRadius >= 12 || track?.isCoreX || (e.xRadius >= 6 && (sawAnyCoreXInRoom || looksGlowingNakedOrb)))
      ) {
        const hasCoreGold = colors.goldRatio >= 0.025;
        if (colors.redRatio >= 0.11 && hasCoreGold) {
          detectedCoreStage = 'VERMELHO';
        } else if (
          colors.yellowGreenRatio >= 0.11 &&
          hasCoreGold &&
          colors.redRatio < 0.09 &&
          colors.silverCyanRatio < 0.09 &&
          !sawRedCoreXInRoom
        ) {
          detectedCoreStage = 'AMARELO';
        } else if (
          (colors.silverCyanRatio >= 0.07 &&
            hasCoreGold &&
            colors.redRatio < 0.08 &&
            (track?.seenRedStage || sawRedCoreXInRoom || e.hp <= 45)) ||
          (colors.silverCyanRatio >= 0.13 && colors.goldRatio >= 0.04 && colors.redRatio < 0.07)
        ) {
          detectedCoreStage = 'PODER_EXPOSTO';
        } else if (
          (colors.silverCyanRatio >= 0.10 && hasCoreGold && colors.redRatio < 0.09) ||
          (track?.isCoreX && !track.seenRedStage && !sawRedCoreXInRoom)
        ) {
          detectedCoreStage = 'NORMAL';
        }
      } else if (track?.isCoreX && (track.seenRedStage || sawRedCoreXInRoom)) {
        detectedCoreStage = 'PODER_EXPOSTO';
      }

      if (detectedCoreStage) {
        if (track) {
          track.isCoreX = true;
          track.coreXStage = detectedCoreStage;
          if (detectedCoreStage === 'VERMELHO') {
            track.seenRedStage = true;
            this.lastCoreXWasRedTick = this.stepIndex;
            this.lastCoreXWasRedRoomId = wram.roomId;
          }
          track.specialType =
            detectedCoreStage === 'PODER_EXPOSTO'
              ? 'CORE_X_NAKED'
              : detectedCoreStage === 'VERMELHO'
                ? 'CORE_X_RED'
                : detectedCoreStage === 'AMARELO'
                  ? 'CORE_X_YELLOW'
                  : 'CORE_X_SILVER';
        }
        if (detectedCoreStage === 'VERMELHO') {
          this.lastCoreXWasRedTick = this.stepIndex;
          this.lastCoreXWasRedRoomId = wram.roomId;
        }
        if (!coreXTarget || detectedCoreStage === 'PODER_EXPOSTO' || dist < coreXTarget.dist) {
          coreXTarget = { ...e, dist, stage: detectedCoreStage };
        }
        continue;
      }

      // 4) SA-X (Varia / Gravity / Monstro Final) — somente quando VISÍVEL na tela e com cores/silhueta reais da SA-X
      const movingOrConfirmed = Boolean(
        track?.hostileConfirmed || (track?.totalMoved ?? 0) >= 2 || (track?.seenTicks ?? 0) < 8 || e.hp >= 900,
      );
      const isHumanSaxShape =
        e.xRadius >= 6 && e.xRadius <= 18 && e.yRadius >= 15 && e.yRadius <= 26 && e.yRadius >= e.xRadius;
      const looksSaxVariaPixels = Boolean(
        colors &&
          colors.orangeRatio + colors.goldRatio >= 0.14 &&
          colors.redRatio >= 0.05 &&
          colors.neonGreenRatio < 0.10,
      );
      const looksSaxGravityPixels = Boolean(
        colors &&
          colors.purpleRatio >= 0.09 &&
          colors.purpleRatio > colors.orangeRatio * 1.15 &&
          colors.redRatio >= 0.03,
      );
      const postRescue = this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 600;
      const looksSaxMonster =
        isLarge &&
        e.hp >= 1200 &&
        dist < 440 &&
        ((colors !== null && colors.purpleRatio + colors.redRatio + colors.orangeRatio >= 0.18) ||
          (postRescue && !hasOpenExit && this.stepIndex - this.bigMetroidHealedTick > 200));

      const isConfirmedHumanSax =
        Boolean(colors) &&
        isHumanSaxShape &&
        e.hp >= 900 &&
        dist < 320 &&
        movingOrConfirmed &&
        (looksSaxVariaPixels || looksSaxGravityPixels);

      if (looksSaxMonster || isConfirmedHumanSax) {
        let saxKind: 'SAX_VARIA' | 'SAX_GRAVITY' | 'SAX_MONSTER' = 'SAX_VARIA';
        if (looksSaxMonster) {
          saxKind = 'SAX_MONSTER';
        } else if (looksSaxGravityPixels) {
          saxKind = 'SAX_GRAVITY';
        }
        if (track) track.specialType = saxKind;
        if (!saxPursuer || dist < saxPursuer.dist) {
          saxPursuer = { ...e, dist, saxKind };
        }
        continue;
      }

      // 5) Metroid Larva / Infantil (Imagem 8)
      const looksMetroidLarva =
        e.hp > 0 &&
        e.hp < 450 &&
        e.xRadius >= 11 &&
        e.xRadius <= 22 &&
        Boolean(colors && colors.redRatio > 0.10 && colors.neonGreenRatio > 0.05);
      if (looksMetroidLarva) {
        if (track) track.specialType = 'METROID_LARVA';
        if (!metroidLarva || dist < metroidLarva.dist) {
          metroidLarva = { ...e, dist };
        }
      }
    }

    if (omegaIntro) {
      this.omegaIntroSeenTicks++;
      this.omegaVanishedDuringTimer = false;
      this.activeSpecialEntity = 'OMEGA_INTRO';
      this.activeSpecialLabel = wram.countdownActive
        ? `Omega Metroid · Timer ${Math.floor(wram.countdownSeconds / 60)}:${String(wram.countdownSeconds % 60).padStart(2, '0')}`
        : 'Omega Metroid (Prólogo)';
    } else if (this.omegaIntroSeenTicks > 0 && wram.countdownActive) {
      this.omegaVanishedDuringTimer = true;
      this.activeSpecialEntity = 'OMEGA_INTRO';
      this.activeSpecialLabel = `Fuga pós-Omega · ${Math.floor(wram.countdownSeconds / 60)}:${String(wram.countdownSeconds % 60).padStart(2, '0')}`;
    } else if (bigMetroid) {
      this.activeSpecialEntity = 'BIG_METROID';
      this.activeSpecialLabel =
        this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 220
          ? 'Metroid Grande (Aliado — Curando!)'
          : 'Metroid Grande (Deixar drenar para ser salvo)';
    } else if (coreXTarget) {
      this.activeCoreXStage = coreXTarget.stage;
      this.lastCoreXSeenTick = this.stepIndex;
      this.lastCoreXRoomId = wram.roomId;
      this.activeSpecialEntity =
        coreXTarget.stage === 'PODER_EXPOSTO'
          ? 'CORE_X_NAKED'
          : coreXTarget.stage === 'VERMELHO'
            ? 'CORE_X_RED'
            : coreXTarget.stage === 'AMARELO'
              ? 'CORE_X_YELLOW'
              : 'CORE_X_SILVER';
      this.activeSpecialLabel =
        coreXTarget.stage === 'PODER_EXPOSTO'
          ? 'Core-X · Poder Exposto (Perseguir e coletar!)'
          : `Core-X (${coreXTarget.stage} · Usar Míssil)`;
    } else if (saxPursuer) {
      this.activeSpecialEntity = saxPursuer.saxKind;
      this.activeSpecialLabel =
        saxPursuer.saxKind === 'SAX_MONSTER'
          ? 'SA-X Monstro (Confronto Final)'
          : saxPursuer.saxKind === 'SAX_GRAVITY'
            ? 'SA-X (Gravity Suit)'
            : 'SA-X (Varia Suit)';
    } else if (metroidLarva) {
      this.activeSpecialEntity = 'METROID_LARVA';
      this.activeSpecialLabel = 'Metroid (Congelar + Míssil)';
    }

    return { omegaIntro, bigMetroid, coreXTarget, saxPursuer, metroidLarva };
  }

  // Detecta objetos interativos na sala (terminais, computadores, painéis de energia, estações de save)
  private detectInteractiveObjects(wram: MetroidWramSnapshot): void {
    this.interactiveObjects = [];

    for (const plm of wram.plms) {
      const id = plm.id;
      let type: InteractiveObject['type'] | null = null;
      let priority = 0;

      // PLMs de energia auxiliar / painéis de energia (faixa típica de controle de energia)
      if (id >= 0xf200 && id <= 0xf2ff) {
        type = 'POWER_PANEL';
        priority = 5;
      } else if (id >= 0xf100 && id <= 0xf1ff) {
        type = 'ENERGY_AUX';
        priority = 6; // alta prioridade - precisa ativar energia
      } else if (id >= 0xf000 && id <= 0xf0ff) {
        type = 'TERMINAL';
        priority = 4;
      } else if (id >= 0xef00 && id <= 0xefff) {
        type = 'COMPUTER';
        priority = 4;
      } else if (id >= 0xee00 && id <= 0xeedf) {
        type = 'DOOR_CONTROL';
        priority = 3;
      } else if (id >= 0xec00 && id <= 0xecff) {
        type = 'SAVE_STATION';
        priority = 2;
      }

      if (type) {
        const alreadyExists = this.interactiveObjects.some(
          (o) => o.bx === plm.bx && o.by === plm.by && o.type === type,
        );
        if (!alreadyExists) {
          const dist = Math.hypot(plm.x - wram.samusX, plm.y - wram.samusY);
          this.interactiveObjects.push({
            bx: plm.bx,
            by: plm.by,
            x: plm.x,
            y: plm.y,
            type,
            interacted: false,
            priority,
          });
        }
      }
    }

    // Ordena por prioridade (mais alto primeiro) e depois por distância
    this.interactiveObjects.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const da = Math.hypot(a.x - wram.samusX, a.y - wram.samusY);
      const db = Math.hypot(b.x - wram.samusX, b.y - wram.samusY);
      return da - db;
    });
  }

  // Verifica se Samus está perto o suficiente para interagir com um objeto
  private canInteractWithObject(wram: MetroidWramSnapshot, obj: InteractiveObject): boolean {
    const dist = Math.hypot(obj.x - wram.samusX, obj.y - wram.samusY);
    return dist < 64; // alcance de interação
  }

  // Executa interação com objeto (pressione A)
  private executeInteraction(
    wram: MetroidWramSnapshot,
    obj: InteractiveObject,
    keys: AIKey[],
    sceneLabel: string,
    reason: string,
  ): AIAction {
    this.currentInteractionTarget = {
      bx: obj.bx,
      by: obj.by,
      x: obj.x,
      y: obj.y,
      type: obj.type,
    };
    this.interactionCooldown = 20;
    this.lastInteractionTick = this.stepIndex;

    // Marca como interagido se for um objeto de uso único
    const existing = this.interactiveObjects.find(
      (o) => o.bx === obj.bx && o.by === obj.by && o.type === obj.type,
    );
    if (existing) existing.interacted = true;

    if (obj.type === 'ENERGY_AUX') {
      this.powerAuxActivated = true;
      this.roomsWithPowerIssue.delete(wram.roomId);
    }

    return this.makeMetroidAction(
      'COLLECT',
      [...keys, 'A'],
      150,
      'run',
      0,
      sceneLabel,
      reason,
      wram,
    );
  }

  private decideMetroidReal(
    m: GridMetrics,
    motionPct: number,
    targetDifficulty: string,
    wram: MetroidWramSnapshot,
  ): AIAction {
    // 1) Estados de Menu / Pausa / Transição de Porta / Cutscene
    if ((wram.gameState <= 4 && wram.roomId === 0) || wram.gameState === 0x0c) {
      this.resetUSearch();
      return this.executeMenuState(m, motionPct, targetDifficulty, wram);
    }

    if (wram.gameState === 0x0b) {
      this.resetUSearch();
      this.jumpHoldRemaining = 0;
      return this.makeMetroidAction(
        'EXPLORE',
        [this.moveDir],
        120,
        'run',
        motionPct,
        'Exploração · Atravessando porta',
        'Entrando na próxima sala',
        wram,
      );
    }

    if (wram.gameState !== 8) {
      this.resetUSearch();
      return this.executeCutsceneState(motionPct, wram);
    }
    this.cutsceneHoldTicks = 0;

    // 0) Fluxo de menu: ABRIR → verificar habilidades/atributos → FECHAR → jogar
    const menuAction = this.openMapAndAnalyze(wram, [], motionPct);
    if (menuAction) return menuAction;

    // Se o menu ainda não fechou (fase DONE não alcançada), aguarda antes de jogar
    if (!this.mapAnalyzed) {
      return this.makeMetroidAction(
        'MENU',
        [],
        100,
        'run',
        motionPct,
        'Menu · Aguardando conclusão',
        'Menu ainda aberto · finalizando análise antes de iniciar a jogatina',
        wram,
      );
    }

    // Após o menu fechar, analisa o loadout (se não foi feito no fluxo) e define direção
    if (!this.initialLoadoutAnalyzed) {
      this.analyzeInitialLoadout(wram);
    }

    // Atualiza grafo de salas, progresso real e detecção de bloqueio
    const { unlockedLabel, hitKnownBlocked } = this.syncRoomAndProgress(wram);

    // Identifica alvos REAIS no ambiente (ignorando elementos estáticos/visuais do cenário)
    const activeEnemies = wram.enemies.filter((e) => !this.enemyTracks.get(e.slot)?.ignoredAsStatic);

    const { omegaIntro, bigMetroid, coreXTarget, saxPursuer, metroidLarva } =
      this.classifySpecialEntities(wram, activeEnemies);

    const activeItem = wram.roomItems
      .map((it) => ({ ...it, dist: Math.hypot(it.x - wram.samusX, it.y - wram.samusY) }))
      .sort((a, b) => a.dist - b.dist)[0];

    // Detecta objetos interativos (terminais, computadores, painéis de energia, estações de save)
    this.detectInteractiveObjects(wram);

    // Sistema de interação: se há um objeto interativo perto e não está em cooldown, vai até ele e interage
    const nearestInteractive = this.interactiveObjects.find(
      (o) => !o.interacted && this.canInteractWithObject(wram, o),
    );
    if (
      nearestInteractive &&
      this.interactionCooldown <= 0 &&
      this.stepIndex - this.lastInteractionTick > 10
    ) {
      // Se ainda não chegou no objeto, move em direção a ele
      const distToObj = Math.hypot(
        nearestInteractive.x - wram.samusX,
        nearestInteractive.y - wram.samusY,
      );
      if (distToObj > 40) {
        // Move em direção ao objeto interativo
        const dirToObj: AIKey =
          nearestInteractive.x >= wram.samusX ? 'RIGHT' : 'LEFT';
        const keys: AIKey[] = [dirToObj, 'B']; // B = run
        if (nearestInteractive.y < wram.samusY - 8) keys.push('UP');
        if (nearestInteractive.y > wram.samusY + 8) keys.push('DOWN');
        if (this.nextJump(true, 3)) keys.push(wram.controls.jump);
        return this.makeMetroidAction(
          'COLLECT',
          keys,
          130,
          'run',
          motionPct,
          `Interação · Indo até ${nearestInteractive.type}`,
          `Aproximando-se do ${nearestInteractive.type} para interagir`,
          wram,
        );
      }
      // Está perto o suficiente: interage (pressiona A)
      return this.executeInteraction(
        wram,
        nearestInteractive,
        [this.moveDir],
        `Interação · ${nearestInteractive.type}`,
        `Interagindo com ${nearestInteractive.type} na sala 0x${wram.roomId.toString(16).toUpperCase()}`,
      );
    }

    // Atualiza salas com problema de energia (detecta se a sala tem painel de energia não ativado)
    const hasUnactivatedPower = this.interactiveObjects.some(
      (o) =>
        (o.type === 'ENERGY_AUX' || o.type === 'POWER_PANEL') && !o.interacted,
    );
    if (hasUnactivatedPower && !this.roomsWithPowerIssue.has(wram.roomId)) {
      this.roomsWithPowerIssue.add(wram.roomId);
    }

    const nearbyEnemy = activeEnemies
      .map((e) => ({ ...e, dist: Math.hypot(e.x - wram.samusX, e.y - wram.samusY) }))
      .filter((e) => {
        if (e.hp <= 0) return false;
        const isRegularBoss = e.hp >= 450;
        if (isRegularBoss) {
          return e.dist < 300;
        }
        if (e.dist >= 136) return false;
        const track = this.enemyTracks.get(e.slot);
        if (track && !track.hostileConfirmed && track.totalMoved <= 1 && track.seenTicks >= 4) {
          return e.dist < 64 && Math.abs(e.y - wram.samusY) < 36;
        }
        return true;
      })
      .sort((a, b) => a.dist - b.dist)[0];

    // Se um item não foi alcançado após 42 ticks, registra para backtracking futuro
    if (activeItem && this.itemChaseTicks >= 42) {
      this.addPendingTarget({
        roomId: wram.roomId,
        x: activeItem.x,
        y: activeItem.y,
        dir: activeItem.x >= wram.samusX ? 'RIGHT' : 'LEFT',
        note: 'Item fora de alcance · aguardando habilidade especial',
      });
      this.itemChaseTicks = 0;
      this.moveDir = activeItem.x >= wram.samusX ? 'LEFT' : 'RIGHT';
      this.anchorX = wram.samusX;
      this.anchorY = wram.samusY;
      this.progressStallTicks = 0;
    }

    // Limpa pendência alcançada na sala atual
    this.pendingTargets = this.pendingTargets.filter(
      (t) => !(t.roomId === wram.roomId && t.unlockedToRetry && Math.abs(t.x - wram.samusX) < 64),
    );

    const backtrackDir = this.findBfsStepTowardPending(wram.roomId);

    // 2) Máquina de Estados de Comportamento (com prioridades especiais X-Fusion)
    if (bigMetroid && this.bigMetroidHealedTick < 0) {
      // Imagem 9: deixar o Metroid Grande drenar vida/habilidades sem fugir da sala (mesmo com SA-X presente)
      this.bigMetroidDrainSeen = true;
      this.resetUSearch();
      const approachDir: AIKey = bigMetroid.x >= wram.samusX ? 'RIGHT' : 'LEFT';
      const keys: AIKey[] = bigMetroid.dist > 44 ? [approachDir] : ['NONE'];
      return this.makeMetroidAction(
        'COLLECT',
        keys,
        140,
        'run',
        motionPct,
        'Metroid Grande · Evento de Dreno',
        'Permitindo o dreno do Metroid Grande para ativar o resgate contra SA-X',
        wram,
      );
    }

    if (coreXTarget && coreXTarget.stage === 'PODER_EXPOSTO') {
      // Imagem 7 + Imagem 2: núcleo Core-X exposto — perseguir diretamente sem desviar para a parede!
      this.resetUSearch();
      const { jump: jumpKey, run: dashKey, cancel: cancelKey } = wram.controls;
      const chaseDir: 'LEFT' | 'RIGHT' = coreXTarget.x >= wram.samusX ? 'RIGHT' : 'LEFT';
      this.moveDir = chaseDir;
      const keys: AIKey[] = [chaseDir, dashKey];
      if (wram.selectedHudItem !== 0) keys.push(cancelKey);
      const jumpForOrb =
        coreXTarget.y < wram.samusY - 8 ||
        (Math.abs(coreXTarget.x - wram.samusX) < 40 && coreXTarget.y < wram.samusY + 4);
      if (this.nextJump(jumpForOrb, 3)) {
        keys.push(jumpKey);
      }
      return this.makeMetroidAction(
        'COLLECT',
        keys,
        115,
        'run',
        motionPct,
        'Core-X · Coletando Poder!',
        `Perseguindo núcleo de poder Core-X (${Math.round(coreXTarget.dist)} px) para absorver habilidade`,
        wram,
      );
    }

    if (omegaIntro) {
      // Imagem 1: acompanhar o ritmo do Omega Metroid inicial até o timer disparar e ele sumir
      this.resetUSearch();
      const { shoot: shootKey, jump: jumpKey, run: dashKey } = wram.controls;
      const aimDir: 'LEFT' | 'RIGHT' = omegaIntro.x >= wram.samusX ? 'RIGHT' : 'LEFT';
      const paceDir: 'LEFT' | 'RIGHT' =
        omegaIntro.dist < 68 ? (aimDir === 'RIGHT' ? 'LEFT' : 'RIGHT') : aimDir;
      this.moveDir = paceDir;
      const keys: AIKey[] = [paceDir, dashKey];
      if (this.nextShoot(true)) keys.push(shootKey);
      if (this.nextJump(omegaIntro.dist < 85 || this.stepIndex % 7 === 0, 3)) keys.push(jumpKey);
      return this.makeMetroidAction(
        'COMBAT',
        keys,
        125,
        'run',
        motionPct,
        wram.countdownActive ? 'Omega Metroid · Temporizador!' : 'Omega Metroid · Prólogo',
        wram.countdownActive
          ? 'Acompanhando Omega Metroid com temporizador ativo para avançar na fuga'
          : 'Enfrentando Omega Metroid inicial e mantendo distância segura',
        wram,
      );
    }

    const isEscapeCountdown = wram.countdownActive && !omegaIntro;
    // Atualiza sistema de priorização de objetivos
    const hasSaveStation = this.interactiveObjects.some(
      (o) => o.type === 'SAVE_STATION' && !o.interacted,
    );
    const hasEnergyAux = this.interactiveObjects.some(
      (o) => (o.type === 'ENERGY_AUX' || o.type === 'POWER_PANEL') && !o.interacted,
    );

    this.updateObjective(
      wram,
      activeItem ?? null,
      nearbyEnemy ?? null,
      saxPursuer ?? null,
      hasSaveStation,
      hasEnergyAux,
    );

    // Detecção de loop com escape forçado
    const forcedEscape = this.checkForcedEscape(wram);
    if (forcedEscape && this.loopDetected && this.forcedEscapeDir) {
      const { jump: jumpKey, run: dashKey, shoot: shootKey } = wram.controls;
      const escapeDir: AIKey = this.forcedEscapeDir;
      const keys: AIKey[] = [escapeDir, dashKey];
      if (this.nextJump(true, 3)) keys.push(jumpKey);
      if (this.nextShoot(true)) keys.push(shootKey);
      this.stuckInRoomTicks++;
      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        160,
        'run',
        motionPct,
        'Escape Forçado · Loop Detectado',
        `Forçando saída da sala (stuck=${this.stuckInRoomTicks} ticks, dir=${this.forcedEscapeDir})`,
        wram,
      );
    }

    let resolvedMode: AgentBehaviorMode = 'EXPLORE';
    if (saxPursuer && !this.omegaVanishedDuringTimer && !isEscapeCountdown) {
      const saxDisabledByMetroid =
        this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 320;
      const mustFight =
        saxPursuer.saxKind === 'SAX_MONSTER' || saxDisabledByMetroid || this.isReadyToFightSAX(wram);
      resolvedMode = mustFight ? 'COMBAT' : 'EVADE_SAX';
    } else if (coreXTarget) {
      resolvedMode = 'COMBAT';
    } else if ((activeItem && this.itemChaseTicks < 42) || unlockedLabel) {
      resolvedMode = 'COLLECT';
    } else if (backtrackDir && this.progressStallTicks < 16 && !this.omegaVanishedDuringTimer && !isEscapeCountdown) {
      resolvedMode = 'BACKTRACK';
    } else if (
      (metroidLarva || nearbyEnemy) &&
      !this.uSearch.active &&
      this.progressStallTicks < 12 &&
      !this.omegaVanishedDuringTimer &&
      (!isEscapeCountdown || Boolean(nearbyEnemy && nearbyEnemy.hp >= 450))
    ) {
      resolvedMode = 'COMBAT';
    } else {
      resolvedMode = 'EXPLORE';
    }

    // Coleta portas para usar na evasão inteligente da SA-X
    const doorsForSax: Array<{ key: string; x: number; y: number; blockedByWall: boolean }> =
      (wram as any).doors?.map((d: any) => ({
        key: d.key || '',
        x: d.x ?? 0,
        y: d.y ?? 0,
        blockedByWall: d.blockedByWall ?? false,
      })) || [];

    switch (resolvedMode) {
      case 'EVADE_SAX':
        this.resetUSearch();
        // Usa evasão inteligente que considera bloqueio de rota da SA-X
        const saxEvade = this.improvedEvadeSax(motionPct, wram, saxPursuer!, doorsForSax);
        if (saxEvade) {
          const keys: AIKey[] = saxEvade.keys;
          return this.makeMetroidAction(
            'EVADE_SAX',
            keys,
            170,
            'run',
            motionPct,
            'Evasão SA-X · ' + saxEvade.reason,
            saxEvade.reason,
            wram,
          );
        }
        return this.executeEvadeSaxState(motionPct, wram, saxPursuer!);
      case 'COMBAT':
        this.resetUSearch();
        return this.executeCombatState(
          motionPct,
          wram,
          saxPursuer ?? null,
          coreXTarget ?? metroidLarva ?? nearbyEnemy ?? null,
          coreXTarget?.stage ?? null,
          Boolean(metroidLarva && !coreXTarget && !saxPursuer),
        );
      case 'COLLECT':
        this.resetUSearch();
        return this.executeCollectState(motionPct, wram, activeItem ?? null, unlockedLabel);
      case 'BACKTRACK':
        return this.executeBacktrackState(motionPct, wram, backtrackDir!);
      case 'EXPLORE':
      default:
        return this.executeExploreState(motionPct, wram, hitKnownBlocked);
    }
  }

  private executeMenuState(
    m: GridMetrics,
    motionPct: number,
    targetDifficulty: string,
    wram: MetroidWramSnapshot,
  ): AIAction {
    if (wram.gameState === 0x0c) {
      return this.makeMetroidAction('MENU', ['START'], 140, 'run', motionPct, 'Menu · Jogo pausado', 'Retomando partida', wram);
    }

    // Pulso alternado para cada toque ser lido de forma precisa sem pular opções
    this.menuPulse = !this.menuPulse;
    const pulseKey = (k: AIKey): AIKey => (this.menuPulse ? k : 'NONE');

    if (wram.gameState <= 2) {
      const k = pulseKey('START');
      return this.makeMetroidAction('MENU', [k], 120, 'menu', motionPct, 'Menu · Título', 'Entrando na seleção de arquivo', wram);
    }

    // Submenus reais do Super Metroid X-Fusion ($7E00D1 e cursor $7E0745)
    if (wram.menuScreen === 1) {
      // SAMUS DATA (0 = X, 1 = Y, 2 = Z)
      const k = wram.menuCursor > 0 ? pulseKey('UP') : pulseKey('A');
      return this.makeMetroidAction('MENU', [k], 125, 'menu', motionPct, 'Menu · Arquivo', 'Selecionando arquivo X', wram);
    }

    if (wram.menuScreen === 5) {
      // LANGUAGE SETTING: 0=English .. 6=Português
      const targetLang = 6;
      if (wram.menuCursor < targetLang) {
        return this.makeMetroidAction(
          'MENU',
          [pulseKey('DOWN')],
          120,
          'menu',
          motionPct,
          'Menu · Idioma',
          `Movendo para Português (${wram.menuCursor}/${targetLang})`,
          wram,
        );
      }
      if (wram.menuCursor > targetLang) {
        return this.makeMetroidAction(
          'MENU',
          [pulseKey('UP')],
          120,
          'menu',
          motionPct,
          'Menu · Idioma',
          `Ajustando cursor para Português (${wram.menuCursor}/${targetLang})`,
          wram,
        );
      }
      return this.makeMetroidAction(
        'MENU',
        [pulseKey('A')],
        130,
        'menu',
        motionPct,
        'Menu · Português confirmado',
        'Confirmando versão em Português',
        wram,
      );
    }

    if (wram.menuScreen === 16) {
      // OPTION MODE (0 = Game Start)
      const k = wram.menuCursor > 0 ? pulseKey('UP') : pulseKey('A');
      return this.makeMetroidAction('MENU', [k], 125, 'menu', motionPct, 'Menu · Opções', 'Iniciando jogo em Português', wram);
    }

    if (wram.menuScreen === 2 || wram.menuScreen === 3) {
      // GAME MODE: 0=Super, 1=Easy, 2=Normal, 3=Hard, 4=Omega
      const diffLower = targetDifficulty.toLowerCase();
      let targetIdx = 2;
      if (diffLower.includes('super')) targetIdx = 0;
      else if (diffLower.includes('easy') || diffLower.includes('fácil')) targetIdx = 1;
      else if (diffLower.includes('omega')) targetIdx = 4;
      else if (diffLower.includes('hard') || diffLower.includes('difícil')) targetIdx = 3;

      if (wram.menuCursor < targetIdx) {
        return this.makeMetroidAction('MENU', [pulseKey('DOWN')], 120, 'menu', motionPct, 'Menu · Dificuldade', `Ajustando dificuldade para ${targetDifficulty}`, wram);
      }
      if (wram.menuCursor > targetIdx) {
        return this.makeMetroidAction('MENU', [pulseKey('UP')], 120, 'menu', motionPct, 'Menu · Dificuldade', `Ajustando dificuldade para ${targetDifficulty}`, wram);
      }
      return this.makeMetroidAction('MENU', [pulseKey('A')], 130, 'menu', motionPct, 'Menu · Iniciando missão', `Confirmando ${targetDifficulty} em Português`, wram);
    }

    const fallbackSeq: AIKey[] = ['A', 'NONE', 'START', 'NONE'];
    const k = fallbackSeq[this.menuCycleIdx++ % fallbackSeq.length];
    return this.makeMetroidAction('MENU', [k], 125, 'menu', motionPct, 'Menu · Navegando', `Avançando menu (${k})`, wram);
  }

  private executeCutsceneState(motionPct: number, wram: MetroidWramSnapshot): AIAction {
    this.cutsceneHoldTicks++;
    const k: AIKey = this.cutsceneHoldTicks % 5 === 0 ? 'A' : 'NONE';
    return this.makeMetroidAction('CUTSCENE', [k], 125, 'run', motionPct, 'Cena / Briefing (PT)', 'Avançando diálogo inicial da missão', wram);
  }

  private executeEvadeSaxState(
    motionPct: number,
    wram: MetroidWramSnapshot,
    pursuer: EnemyInfo & { dist: number; saxKind?: 'SAX_VARIA' | 'SAX_GRAVITY' | 'SAX_MONSTER' },
  ): AIAction {
    const { shoot: shootKey, jump: jumpKey, run: dashKey } = wram.controls;
    const escapeDoors = wram.doors
      .filter((d) => !d.blockedByWall)
      .map((d, idx) => {
        const distFromSax = Math.hypot(d.x - pursuer.x, d.y - pursuer.y);
        return { key: d.key, bx: d.bx, by: d.by, priority: distFromSax > 140 ? 0 : idx + 1 };
      });
    const escapeStep = this.planPathInRoom(wram, escapeDoors);
    const fleeDir: AIKey = escapeStep ? escapeStep.dir : pursuer.x >= wram.samusX ? 'LEFT' : 'RIGHT';
    this.moveDir = fleeDir;
    const keys: AIKey[] = [fleeDir, dashKey];
    const wantsJump = escapeStep
      ? escapeStep.jump || Math.abs(pursuer.y - wram.samusY) < 28
      : this.stepIndex % 4 === 0 || Math.abs(pursuer.y - wram.samusY) < 28;
    if (this.nextJump(!escapeStep?.drop && wantsJump, 3)) {
      keys.push(jumpKey);
    }
    if (this.nextShoot(Boolean(escapeStep?.shoot || this.progressStallTicks >= 2 || this.stepIndex % 3 === 0))) {
      keys.push(shootKey);
    }
    const suitTag = pursuer.saxKind === 'SAX_GRAVITY' ? 'SA-X Gravity' : 'SA-X Varia';
    return this.makeMetroidAction(
      'EVADE_SAX',
      keys,
      125,
      'run',
      motionPct,
      `ALERTA ${suitTag} · FUGA!`,
      `Fugindo da ${suitTag} para ${fleeDir === 'RIGHT' ? 'direita' : 'esquerda'} até ficar equipada`,
      wram,
      true,
      false,
    );
  }

  private executeCombatState(
    motionPct: number,
    wram: MetroidWramSnapshot,
    saxPursuer: (EnemyInfo & { dist: number; saxKind?: 'SAX_VARIA' | 'SAX_GRAVITY' | 'SAX_MONSTER' }) | null,
    nearbyEnemy: (EnemyInfo & { dist: number }) | null,
    coreXStage: CoreXStage | null = null,
    isMetroidLarva = false,
  ): AIAction {
    const { shoot: shootKey, jump: jumpKey, select: selectKey, cancel: cancelKey } = wram.controls;

    if (saxPursuer) {
      const aimDir: AIKey = saxPursuer.x >= wram.samusX ? 'RIGHT' : 'LEFT';
      const safeDist = saxPursuer.saxKind === 'SAX_MONSTER' ? 88 : 64;
      const tooClose = saxPursuer.dist < safeDist;
      const moveKey: AIKey = tooClose ? (aimDir === 'RIGHT' ? 'LEFT' : 'RIGHT') : aimDir;
      const hasHeavyAmmo = wram.supers > 0 || wram.missiles > 0;
      const needSelectAmmo = hasHeavyAmmo && wram.selectedHudItem === 0;
      const keys: AIKey[] = [moveKey];

      // SA-X é entidade especial: sempre usa míssil quando disponível
      const shouldFireMissile = this.shouldUseMissile(
        wram,
        saxPursuer,
        false,
        false,
        true, // entidade especial (SA-X)
      );

      if (shouldFireMissile && needSelectAmmo) {
        keys.push(selectKey);
        this.registerMissileUse();
      } else if (shouldFireMissile && this.nextShoot(true)) {
        keys.push(shootKey);
        this.registerMissileUse();
      } else if (this.nextShoot(true)) {
        keys.push(shootKey);
      }
      if (this.nextJump(saxPursuer.y < wram.samusY - 24 || this.stepIndex % 6 === 0, 3)) {
        keys.push(jumpKey);
      }
      const isMonster = saxPursuer.saxKind === 'SAX_MONSTER';
      const isStunned = this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 320;
      return this.makeMetroidAction(
        'COMBAT',
        keys,
        125,
        'run',
        motionPct,
        isMonster
          ? 'Combate · SA-X Monstro'
          : isStunned
            ? 'Combate · SA-X Desativada!'
            : 'Combate · Confronto Final SA-X',
        isMonster
          ? 'Enfrentando forma monstro da SA-X com armamento pesado'
          : isStunned
            ? 'Metroid Grande nos curou! Atacando SA-X desativada para finalizar'
            : 'Equipamentos completos! Atacando SA-X para valer',
        wram,
        true,
        true,
      );
    }

    const target = nearbyEnemy!;
    const track = this.enemyTracks.get(target.slot);
    if (track && !coreXStage && !isMetroidLarva) {
      track.combatTicks++;
      if (!track.hostileConfirmed && track.combatTicks >= 5 && target.hp >= track.initHp && track.totalMoved <= 3) {
        track.ignoredAsStatic = true;
        return this.executeExploreState(motionPct, wram, false);
      }
    }

    const faceDir: 'LEFT' | 'RIGHT' = target.x >= wram.samusX ? 'RIGHT' : 'LEFT';

    if (coreXStage) {
      const hasMissiles = wram.missiles > 0 || wram.supers > 0;
      const moveKey: AIKey = target.dist < 54 ? (faceDir === 'RIGHT' ? 'LEFT' : 'RIGHT') : faceDir;
      const keys: AIKey[] = [moveKey];
      if (target.y < wram.samusY - 18) keys.push('UP');

      // Core-X é entidade especial: sempre usa míssil quando disponível
      const shouldFireMissile = this.shouldUseMissile(
        wram,
        target,
        false,
        false,
        true, // entidade especial (Core-X)
      );

      if (shouldFireMissile && wram.selectedHudItem === 0) {
        keys.push(selectKey);
        this.registerMissileUse();
      } else if (shouldFireMissile && this.nextShoot(true)) {
        keys.push(shootKey);
        this.registerMissileUse();
      } else if (this.nextShoot(true)) {
        keys.push(shootKey);
      }
      if (this.nextJump(target.y < wram.samusY - 24 || target.dist < 48, 3)) {
        keys.push(jumpKey);
      }
      const stageDesc =
        coreXStage === 'VERMELHO'
          ? 'Fase Vermelha (crítico) — finalizando com mísseis!'
          : coreXStage === 'AMARELO'
            ? 'Fase Amarelada — continuando ataques com mísseis'
            : 'Fase Normal — abrindo casca do Core-X com mísseis';
      return this.makeMetroidAction(
        'COMBAT',
        keys,
        120,
        'run',
        motionPct,
        `Combate · Core-X (${coreXStage})`,
        stageDesc,
        wram,
      );
    }

    if (isMetroidLarva) {
      const hasIce = (wram.beamsEquipped & 0x0002) !== 0;
      const hasMissiles = wram.missiles > 0 || wram.supers > 0;
      const keys: AIKey[] = [faceDir];
      if (target.y < wram.samusY - 16) keys.push('UP');

      // Metroid é entidade especial: usa míssil para estilhaçar após congelar
      const shouldFireMissile = this.shouldUseMissile(
        wram,
        target,
        false,
        false,
        true, // entidade especial (Metroid)
      );

      // Alterna feixe de gelo para congelar e míssil para estilhaçar
      const freezePhase = hasIce && this.stepIndex % 4 < 2;
      if (freezePhase) {
        if (wram.selectedHudItem !== 0) keys.push(cancelKey);
        else if (this.nextShoot(true)) keys.push(shootKey);
      } else if (shouldFireMissile && wram.selectedHudItem === 0) {
        keys.push(selectKey);
        this.registerMissileUse();
      } else if (shouldFireMissile && this.nextShoot(true)) {
        keys.push(shootKey);
        this.registerMissileUse();
      } else if (this.nextShoot(true)) {
        keys.push(shootKey);
      }
      if (this.nextJump(target.dist < 48 || this.stepIndex % 5 === 0, 2)) keys.push(jumpKey);
      return this.makeMetroidAction(
        'COMBAT',
        keys,
        120,
        'run',
        motionPct,
        'Combate · Metroid',
        hasIce
          ? 'Congelando Metroid com Ice Beam e finalizando com mísseis'
          : 'Eliminando Metroid com disparos diretos',
        wram,
      );
    }

    const isBossEnemy = target.hp >= 450;
    const lowHealth = wram.maxHealth > 0 && wram.health < wram.maxHealth * 0.30;

    // Com vida baixa, prioriza afastar-se do inimigo em vez de se aproximar
    let approachDir: AIKey;
    if (lowHealth) {
      approachDir = faceDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
    } else if (isBossEnemy && target.dist < 56) {
      approachDir = faceDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
    } else {
      approachDir = faceDir;
    }
    const keys: AIKey[] = [approachDir];
    if (target.y < wram.samusY - 18) keys.push('UP');

    // Sistema inteligente de míssil: só usa míssil se for boss, porta bloqueada ou entidade especial
    const useHeavyForBoss = isBossEnemy && (wram.supers > 0 || wram.missiles > 0);
    const hasHeavyAmmo = wram.supers > 0 || wram.missiles > 0;
    const needSelectAmmo = hasHeavyAmmo && wram.selectedHudItem === 0;

    const shouldFireMissile = this.shouldUseMissile(
      wram,
      target,
      isBossEnemy,
      false, // não é porta no combate
      false, // não é entidade especial no combate geral
    );

    if (shouldFireMissile && needSelectAmmo) {
      keys.push(selectKey);
      this.registerMissileUse();
    } else if (shouldFireMissile && this.nextShoot(true)) {
      keys.push(shootKey);
      this.registerMissileUse();
    } else if (this.nextShoot(true)) {
      keys.push(shootKey);
    }

    // Pulo: chefe próximo ou inimigo muito perto -> salta para não ficar no alcance de contato
    const wantsJump =
      target.dist < 52 ||
      (isBossEnemy && (target.y < wram.samusY - 24 || this.stepIndex % 7 === 0)) ||
      (target.dist < 36 && this.stepIndex % 5 === 0);
    if (this.nextJump(wantsJump, isBossEnemy ? 3 : 2)) {
      keys.push(jumpKey);
    }

    return this.makeMetroidAction(
      'COMBAT',
      keys,
      125,
      'run',
      motionPct,
      isBossEnemy ? 'Combate · Enfrentando Chefe' : 'Combate · Eliminando inimigo',
      lowHealth
        ? `Vida baixa! Recuando do ${isBossEnemy ? 'chefe' : 'inimigo'} (${Math.round(target.dist)} px · HP ${target.hp})`
        : isBossEnemy
          ? `Atacando chefe da sala (${Math.round(target.dist)} px · HP ${target.hp})`
          : `Atacando inimigo confirmado (${Math.round(target.dist)} px · HP ${target.hp})`,
      wram,
    );
  }

  private executeCollectState(
    motionPct: number,
    wram: MetroidWramSnapshot,
    activeItem: (RoomItemTarget & { dist: number }) | null,
    unlockedLabel: string | null,
  ): AIAction {
    const { shoot: shootKey, jump: jumpKey, run: dashKey } = wram.controls;

    if (unlockedLabel) {
      const pendingReady = this.pendingTargets.some((t) => t.unlockedToRetry);
      return this.makeMetroidAction(
        'COLLECT',
        [this.moveDir, dashKey],
        125,
        'run',
        motionPct,
        `Coleta · ${unlockedLabel}`,
        pendingReady ? 'Habilidade desbloqueada! Preparando retorno às rotas pendentes' : 'Item coletado · seguindo exploração',
        wram,
      );
    }

    const itemBx = Math.max(0, Math.min(wram.roomWidthBlocks - 1, Math.floor(activeItem!.x / 16)));
    const itemBy = Math.max(1, Math.min(wram.roomHeightBlocks - 2, Math.floor(activeItem!.y / 16)));
    const itemPath = this.planPathInRoom(wram, [{ key: 'ITEM', bx: itemBx, by: itemBy, priority: 0 }]);

    if (!itemPath && wram.blockTypes) {
      this.addPendingTarget({
        roomId: wram.roomId,
        x: activeItem!.x,
        y: activeItem!.y,
        dir: activeItem!.x >= wram.samusX ? 'RIGHT' : 'LEFT',
        note: 'Item requer nova habilidade para alcançar',
      });
      this.itemChaseTicks = 42;
      return this.executeExploreState(motionPct, wram, false);
    }

    this.itemChaseTicks++;
    const dirToItem: 'LEFT' | 'RIGHT' = itemPath
      ? itemPath.dir
      : activeItem!.x >= wram.samusX
        ? 'RIGHT'
        : 'LEFT';
    this.moveDir = dirToItem;
    const keys: AIKey[] = [dirToItem, dashKey];
    const isGrounded = this.isSamusGrounded(wram);
    const wantsJump = itemPath
      ? !itemPath.drop && (itemPath.jump || itemPath.wpBy * 16 + 8 < wram.samusY - 12)
      : activeItem!.y < wram.samusY - 12 || this.progressStallTicks >= 4;
    if (this.nextJump(wantsJump && isGrounded, 3)) {
      keys.push(jumpKey);
    }
    if (this.nextShoot(Boolean(itemPath?.shoot || itemPath?.viaBreakable || this.progressStallTicks >= 5))) {
      keys.push(shootKey);
    }
    if (activeItem!.y > wram.samusY + 22 && (wram.itemsMask & 0x0004)) {
      keys.push('DOWN');
    }
    return this.makeMetroidAction(
      'COLLECT',
      keys,
      125,
      'run',
      motionPct,
      'Coleta · Buscando item',
      `Coletando item em (${Math.round(activeItem!.x)},${Math.round(activeItem!.y)}) · ${Math.round(activeItem!.dist)} px`,
      wram,
    );
  }

  private executeBacktrackState(
    motionPct: number,
    wram: MetroidWramSnapshot,
    backtrackDir: 'LEFT' | 'RIGHT',
  ): AIAction {
    const { shoot: shootKey, jump: jumpKey, run: dashKey, cancel: cancelKey, select: selectKey } = wram.controls;
    const loadout = this.getAgentLoadout(wram);
    this.moveDir = backtrackDir;
    const keys: AIKey[] = [backtrackDir, dashKey];

    // Durante backtracking, cancela arma secundária se não for necessária
    if (wram.selectedHudItem !== 0 && !loadout.hasSupers && !loadout.hasMissiles) {
      keys.push(cancelKey);
    }

    // Se tem bomba e está em passagem baixa, usa morph ball
    if (loadout.hasMorphBall && loadout.hasBombs && this.progressStallTicks >= 3) {
      keys.push('DOWN');
      if (this.nextShoot(true)) {
        keys.push(shootKey);
        this.registerMissileUse();
      }
      return this.makeMetroidAction(
        'BACKTRACK',
        keys,
        140,
        'run',
        motionPct,
        'Backtracking · Morph Ball',
        `Retornando com Morph Ball (${backtrackDir === 'RIGHT' ? 'direita' : 'esquerda'})`,
        wram,
      );
    }

    if (this.nextJump(this.progressStallTicks >= 4 || this.stepIndex % 9 === 0, 3)) {
      keys.push(jumpKey);
    }

    // Usa míssil só se for porta bloqueada durante backtracking
    const shouldFireMissile = this.shouldUseMissile(
      wram,
      null,
      false,
      this.progressStallTicks >= 24, // porta bloqueada após stall
      false,
    );
    if (shouldFireMissile && wram.selectedHudItem === 0) {
      keys.push(selectKey);
      this.registerMissileUse();
    } else if (shouldFireMissile && this.nextShoot(this.progressStallTicks >= 3)) {
      keys.push(shootKey);
      this.registerMissileUse();
    } else if (this.nextShoot(this.progressStallTicks >= 3)) {
      keys.push(shootKey);
    }

    return this.makeMetroidAction(
      'BACKTRACK',
      keys,
      135,
      'run',
      motionPct,
      'Backtracking · Nova rota',
      `Retornando pela rota (${backtrackDir === 'RIGHT' ? 'direita' : 'esquerda'}) · Habilidades: ${loadout.totalAbilities}/16`,
      wram,
    );
  }

  private executeUSearchPattern(motionPct: number, wram: MetroidWramSnapshot): AIAction {
    const { shoot: shootKey, jump: jumpKey, run: dashKey, cancel: cancelKey } = wram.controls;
    const oppDir: 'LEFT' | 'RIGHT' = this.uSearch.blockedDir === 'RIGHT' ? 'LEFT' : 'RIGHT';

    if (wram.selectedHudItem !== 0) {
      return this.makeMetroidAction(
        'EXPLORE',
        [this.moveDir, cancelKey],
        120,
        'run',
        motionPct,
        'Exploração · Busca em U (feixe)',
        'Restaurando feixe principal durante manobra em U',
        wram,
        false,
        false,
        this.uSearch.phase,
      );
    }

    // Verifica se o padrão em 'U' já encontrou passagem além do bloqueio ou plataforma superior firme
    const clearedHoriz =
      this.uSearch.blockedDir === 'RIGHT'
        ? wram.samusX >= this.uSearch.originX + 24
        : wram.samusX <= this.uSearch.originX - 24;
    const climbedNewLedge =
      Math.abs(wram.samusY - this.uSearch.originY) >= 52 &&
      this.sameYStreak >= 5 &&
      (this.uSearch.blockedDir === 'RIGHT'
        ? wram.samusX >= this.uSearch.originX - 24
        : wram.samusX <= this.uSearch.originX + 24);

    if (clearedHoriz || climbedNewLedge) {
      const targetDir = this.uSearch.blockedDir;
      this.moveDir = targetDir;
      this.anchorX = wram.samusX;
      this.anchorY = wram.samusY;
      this.progressStallTicks = 0;
      this.missileProbeCount = 0;
      this.resetUSearch(6);
      return this.makeMetroidAction(
        'EXPLORE',
        [targetDir, dashKey],
        135,
        'run',
        motionPct,
        'Exploração · Caminho encontrado',
        'Padrão em U superou o bloqueio! Continuando exploração',
        wram,
      );
    }

    this.uSearch.ticksInPhase++;

    // Perna 1 do 'U': BACKSTEP (recua do bloqueio para ganhar impulso e ângulo)
    if (this.uSearch.phase === 'BACKSTEP') {
      this.moveDir = oppDir;
      const keys: AIKey[] = [oppDir, dashKey];
      if (this.nextShoot(this.uSearch.ticksInPhase % 2 === 0)) keys.push(shootKey);

      if (this.uSearch.ticksInPhase >= 6) {
        this.uSearch.phase = 'ASCEND';
        this.uSearch.ticksInPhase = 0;
      }

      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        130,
        'run',
        motionPct,
        'Exploração · Busca em U (1/3 Recuo)',
        'Recuando do bloqueio para iniciar contorno em U',
        wram,
        false,
        false,
        'BACKSTEP',
      );
    }

    // Perna 2 do 'U': ASCEND (avança com salto completo em direção ao bloqueio buscando passagem alta)
    if (this.uSearch.phase === 'ASCEND') {
      this.moveDir = this.uSearch.blockedDir;
      const keys: AIKey[] = [this.uSearch.blockedDir, dashKey];
      if (this.nextJump(true, 4)) keys.push(jumpKey);
      if (this.nextShoot(true)) keys.push(shootKey);

      if (this.uSearch.ticksInPhase >= 10) {
        this.uSearch.phase = 'DESCEND';
        this.uSearch.ticksInPhase = 0;
        this.jumpHoldRemaining = 0;
      }

      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        135,
        'run',
        motionPct,
        'Exploração · Busca em U (2/3 Subida)',
        'Contornando obstáculo por cima em busca de passagem',
        wram,
        false,
        false,
        'ASCEND',
      );
    }

    // Perna 3 do 'U': DESCEND (varre passagem inferior/Morph e saída oposta antes de desistir)
    if (this.uSearch.ticksInPhase <= 8) {
      const checkLowMorph = this.uSearch.ticksInPhase <= 3 && (wram.itemsMask & 0x0004) !== 0;
      const sweepDir: 'LEFT' | 'RIGHT' = this.uSearch.ticksInPhase <= 4 ? this.uSearch.blockedDir : oppDir;
      this.moveDir = sweepDir;
      const keys: AIKey[] = [sweepDir, dashKey];
      if (checkLowMorph) keys.push('DOWN');
      if (this.nextShoot(true)) keys.push(shootKey);

      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        135,
        'run',
        motionPct,
        'Exploração · Busca em U (3/3 Varredura)',
        'Verificando nível inferior e saída alternativa antes de desistir',
        wram,
        false,
        false,
        'DESCEND',
      );
    }

    // Busca em 'U' concluída sem passagem aberta: memoriza bloqueio e segue na direção oposta
    this.addPendingTarget({
      roomId: wram.roomId,
      x: this.uSearch.originX,
      y: this.uSearch.originY,
      dir: this.uSearch.blockedDir,
      note: 'Porta trancada ou obstáculo · verificado com busca em U',
    });
    this.recentBlockedSpots.push({
      x: this.uSearch.originX,
      y: this.uSearch.originY,
      dir: this.uSearch.blockedDir,
    });
    const node = this.getOrCreateRoom(wram.roomId);
    if (this.uSearch.blockedDir === 'RIGHT') node.triedRight = true;
    else node.triedLeft = true;

    this.moveDir = oppDir;
    this.anchorX = wram.samusX;
    this.anchorY = wram.samusY;
    this.progressStallTicks = 0;
    this.jumpHoldRemaining = 0;
    this.resetUSearch(10);

    const keys: AIKey[] = [oppDir, dashKey];
    if (wram.selectedHudItem !== 0) keys.push(cancelKey);
    return this.makeMetroidAction(
      'EXPLORE',
      keys,
      190,
      'run',
      motionPct,
      'Exploração · Bloqueio confirmado',
      'Busca em U concluída · seguindo pela direção oposta',
      wram,
    );
  }

  private executeExploreState(
    motionPct: number,
    wram: MetroidWramSnapshot,
    hitKnownBlocked: boolean,
  ): AIAction {
    const { shoot: shootKey, jump: jumpKey, run: dashKey, cancel: cancelKey, select: selectKey } = wram.controls;

    // Aguarda animação inicial de entrada ou avança texto de sala de Navegação/Recarga sem travar contagem
    if (!this.roomMovedOnce && this.roomTicks >= 8 && this.roomTicks <= 95 && this.samusVx === 0 && this.samusVy === 0) {
      const k: AIKey = this.roomTicks % 4 === 0 ? 'A' : this.moveDir;
      return this.makeMetroidAction(
        'EXPLORE',
        [k],
        120,
        'run',
        motionPct,
        'Exploração · Sincronizando sala',
        `Sala 0x${wram.roomId.toString(16).toUpperCase()} · aguardando controle ou diálogo`,
        wram,
      );
    }

    // Mantém busca em 'U' ativa até encontrar caminho ou concluir as 3 pernas
    if (this.uSearch.active) {
      return this.executeUSearchPattern(motionPct, wram);
    }

    // Cancela arma secundária fora da janela de até 2 disparos de teste
    if (
      wram.selectedHudItem !== 0 &&
      (this.progressStallTicks < 14 || this.progressStallTicks > 20 || this.missileProbeCount >= 2)
    ) {
      return this.makeMetroidAction('EXPLORE', [this.moveDir, cancelKey], 120, 'run', motionPct, 'Exploração · Feixe principal', 'Retornando ao feixe principal', wram);
    }

    // Se encostou novamente em ponto já verificado pela busca em 'U' nesta visita, marca porta e vira
    if (hitKnownBlocked) {
      const oppDir: 'LEFT' | 'RIGHT' = this.moveDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
      if (this.activeDoorKey) {
        const rd = this.getOrCreateRoom(wram.roomId).doors.get(this.activeDoorKey);
        if (rd) rd.locked = true;
      }
      this.moveDir = oppDir;
      this.anchorX = wram.samusX;
      this.anchorY = wram.samusY;
      this.progressStallTicks = 0;
      this.jumpHoldRemaining = 0;
      return this.makeMetroidAction(
        'EXPLORE',
        [oppDir, dashKey],
        180,
        'run',
        motionPct,
        'Exploração · Rota já verificada',
        'Ponto bloqueado já memorizado · seguindo rota alternativa',
        wram,
      );
    }

    // Planejamento real sobre o mapa de blocos $7F:0002 da sala atual
    const currNode = this.getOrCreateRoom(wram.roomId);
    const nextRoomTowardUnexplored = this.findRoomWithUnexploredDoor(wram.roomId);
    const isTimedEscape = wram.countdownActive;
    const doorTargets: Array<{ key: string; bx: number; by: number; priority: number }> = [];

    for (const d of wram.doors) {
      if (d.blockedByWall && !isTimedEscape) continue;
      const rec = currNode.doors.get(d.key);
      if (rec?.locked && !isTimedEscape) continue;

      let priority = 3;
      if (!rec || rec.targetRoomId === undefined) {
        priority = d.key === this.entryDoorKey ? 2 : 0;
      } else if (nextRoomTowardUnexplored && rec.targetRoomId === nextRoomTowardUnexplored) {
        priority = 1;
      }
      doorTargets.push({ key: d.key, bx: d.bx, by: d.by, priority });
    }
    if (doorTargets.length === 0 && wram.doors.length > 0) {
      for (const d of wram.doors) {
        doorTargets.push({ key: d.key, bx: d.bx, by: d.by, priority: d.key === this.entryDoorKey ? 2 : 0 });
      }
    }

    const pathStep = this.planPathInRoom(wram, doorTargets);
    if (pathStep) {
      this.activeDoorKey = pathStep.goalKey;
    }

    const hasSpaceJump = (wram.itemsMask & 0x0200) !== 0;
    const isGrounded = this.isSamusGrounded(wram);
    const samusBx = Math.max(0, Math.min(wram.roomWidthBlocks - 1, Math.floor(wram.samusX / 16)));
    const samusBy = Math.max(1, Math.min(wram.roomHeightBlocks - 2, Math.floor(wram.samusY / 16)));
    const tileAbove1 = this.resolveBlockType(wram, samusBx, samusBy - 1);
    const tileAbove2 = this.resolveBlockType(wram, samusBx, samusBy - 2);
    const isSolidHead = (t: number) => t === 0x8 || t === 0xa || t === 0xe || t === 0xf;
    const spikeNearHead =
      tileAbove1 === 0xa ||
      tileAbove2 === 0xa ||
      this.resolveBlockType(wram, samusBx - 1, samusBy - 2) === 0xa ||
      this.resolveBlockType(wram, samusBx + 1, samusBy - 2) === 0xa;
    const ceilingLow = isSolidHead(tileAbove1) || isSolidHead(tileAbove2) || spikeNearHead;

    // Bloqueio detectado em Exploração: testa míssil de forma inteligente (apenas se vale a pena)
    if (this.progressStallTicks >= 5) {
      if (
        this.progressStallTicks >= 14 &&
        this.progressStallTicks <= 20 &&
        this.missileProbeCount < 2
      ) {
        // Determina se a porta está bloqueada e precisa de míssil
        const targetDoor = pathStep ? wram.doors.find((d) => d.key === pathStep.goalKey) : null;
        const isBlockedDoor = targetDoor ? targetDoor.blockedByWall : false;
        const useMissile = this.shouldUseMissile(
          wram,
          null,
          false, // não é boss na exploração
          isBlockedDoor,
          false, // não é entidade especial na exploração
        );

        if (useMissile) {
          if (wram.selectedHudItem === 0) {
            return this.makeMetroidAction('EXPLORE', [this.moveDir, selectKey], 130, 'run', motionPct, 'Exploração · Testando Míssil', 'Selecionando míssil para porta bloqueada', wram);
          }
          const keys: AIKey[] = [this.moveDir];
          if (this.nextShoot(true)) {
            keys.push(shootKey);
            this.registerMissileUse();
          }
          return this.makeMetroidAction('EXPLORE', keys, 130, 'run', motionPct, 'Exploração · Disparando Míssil', 'Abrindo porta bloqueada com míssil', wram);
        } else {
          // Não usa míssil - marca porta como trancada e segue para busca em U ou inverte
          if (this.activeDoorKey) {
            const rd = currNode.doors.get(this.activeDoorKey);
            if (rd) rd.locked = true;
          }
        }
      }

      if (this.progressStallTicks >= 21 && this.progressStallTicks <= 23 && (wram.itemsMask & 0x0004) && isGrounded && !hasSpaceJump) {
        const keys: AIKey[] = ['DOWN', this.moveDir];
        if ((wram.itemsMask & 0x1000) && this.nextShoot(true)) keys.push(shootKey);
        return this.makeMetroidAction('EXPLORE', keys, 145, 'run', motionPct, 'Exploração · Morph Ball', 'Verificando passagem baixa', wram);
      }

      if (this.progressStallTicks >= 24) {
        if (!isTimedEscape && this.activeDoorKey) {
          const activeDoor = wram.doors.find((d) => d.key === this.activeDoorKey);
          if (activeDoor && Math.hypot(activeDoor.x - wram.samusX, activeDoor.y - wram.samusY) <= 112) {
            const rd = currNode.doors.get(this.activeDoorKey);
            if (rd) rd.locked = true;
          }
        }
        if (this.uSearch.cooldown === 0 && (!isTimedEscape || isGrounded)) {
          this.startUSearch(wram);
          return this.executeUSearchPattern(motionPct, wram);
        }
        const oppDir: 'LEFT' | 'RIGHT' = this.moveDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
        this.moveDir = oppDir;
        this.anchorX = wram.samusX;
        this.anchorY = wram.samusY;
        this.progressStallTicks = 0;
        const keys: AIKey[] = [oppDir, dashKey];
        if (hasSpaceJump && !ceilingLow && this.stepIndex % 2 === 0) keys.push(jumpKey);
        return this.makeMetroidAction('EXPLORE', keys, 150, 'run', motionPct, isTimedEscape ? 'Fuga · Contornando obstáculo' : 'Exploração · Invertendo rota', 'Desviando de obstáculo na rota de fuga', wram);
      }

      const targetDoor = pathStep ? wram.doors.find((d) => d.key === pathStep.goalKey) : null;
      const nearDoor = targetDoor && Math.hypot(targetDoor.x - wram.samusX, targetDoor.y - wram.samusY) <= 44;
      const keys: AIKey[] = [pathStep ? pathStep.dir : this.moveDir, dashKey];
      if (!nearDoor && !ceilingLow) {
        if (hasSpaceJump) {
          if (isGrounded ? this.nextJump(true, 3) : (this.stepIndex % 2 === 0 || this.samusVy >= 0)) {
            keys.push(jumpKey);
          }
        } else if (this.nextJump(true, 3)) {
          keys.push(jumpKey);
        }
      } else if (ceilingLow && (wram.itemsMask & 0x0004) && isGrounded) {
        keys.push('DOWN');
      }
      if (this.nextShoot(true)) keys.push(shootKey);
      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        125,
        'run',
        motionPct,
        nearDoor ? 'Exploração · Abrindo porta' : isTimedEscape ? 'Fuga · Contornando teto' : 'Exploração · Testando passagem',
        nearDoor ? 'Disparando na porta para avançar de sala' : 'Contornando obstáculo com segurança',
        wram,
      );
    }

    // Execução fluida guiada pelo caminho real no mapa de blocos da sala
    if (pathStep) {
      this.moveDir = pathStep.dir;
      const targetDoor = wram.doors.find((d) => d.key === pathStep.goalKey);
      const wpX = pathStep.wpBx * 16 + 8;
      const wpY = pathStep.wpBy * 16 + 8;
      const nearDoor = targetDoor && Math.hypot(targetDoor.x - wram.samusX, targetDoor.y - wram.samusY) <= 56;
      const floorBelowT = this.resolveBlockType(wram, samusBx, samusBy + 1);
      const bombFloorUnderFoot =
        (pathStep.bomb || (pathStep.drop && floorBelowT === 0xf)) &&
        Math.abs(wram.samusX - wpX) <= 14 &&
        (isGrounded || (this.sameYStreak >= 1 && Math.abs(this.samusVy) <= 1)) &&
        (wram.itemsMask & 0x1004) === 0x1004;

      if (bombFloorUnderFoot) {
        const bKeys: AIKey[] = ['DOWN'];
        if (this.nextShoot(true)) bKeys.push(shootKey);
        return this.makeMetroidAction(
          'EXPLORE',
          bKeys,
          120,
          'run',
          motionPct,
          'Exploração · Bomba no piso',
          `Sala 0x${wram.roomId.toString(16).toUpperCase()} (${wram.samusX},${wram.samusY}) · plantando bomba para descer`,
          wram,
        );
      }

      const nearCenter = Math.abs(wram.samusX - wpX) < 10 && pathStep.drop;
      const moveKey: AIKey = pathStep.dir;
      const keys: AIKey[] = nearCenter ? [moveKey] : [moveKey, dashKey];

      // PULO CONTÍNUO: pula a cada poucos ticks durante exploração livre para avançar sem preocupação com obstáculos
      const continuousJump = !nearDoor && !ceilingLow && !bombFloorUnderFoot && !pathStep.drop;
      if (continuousJump) {
        if (hasSpaceJump) {
          // Space Jump: pula continuamente no ar e no chão
          if (isGrounded ? this.nextJump(true, 2) : (this.stepIndex % 2 === 0 || this.samusVy >= 0)) {
            keys.push(jumpKey);
          }
        } else if (isGrounded && this.nextJump(true, 3)) {
          // Sem Space Jump: pula apenas quando está no chão
          keys.push(jumpKey);
        }
      }

      const hitSmallStep = isGrounded && Math.abs(this.samusVx) === 0 && this.roomMovedOnce && !pathStep.drop && !ceilingLow;
      const needsAscend =
        !pathStep.drop &&
        !(ceilingLow && !pathStep.jump) &&
        (pathStep.jump || (!ceilingLow && wpY < wram.samusY - 12) || hitSmallStep);

      // Só executa lógica de pulo existente se continuousJump não estiver ativo (evita duplicar jumpKey)
      if (!continuousJump) {
        if (hasSpaceJump && needsAscend && (!nearDoor || (targetDoor && targetDoor.y < wram.samusY - 14))) {
          if (isGrounded) {
            if (this.nextJump(true, 3)) keys.push(jumpKey);
          } else if (this.stepIndex % 2 === 0 || this.samusVy >= 0) {
            this.jumpHoldRemaining = 0;
            keys.push(jumpKey);
          }
        } else if (this.nextJump(needsAscend && !nearDoor && isGrounded, pathStep.jump ? 4 : 3)) {
          keys.push(jumpKey);
        }
      }

      if (this.nextShoot(Boolean(nearDoor || pathStep.shoot || pathStep.viaBreakable || isTimedEscape || this.stepIndex % 5 === 0))) {
        keys.push(shootKey);
      }

      const dirLabel = moveKey === 'RIGHT' ? 'direita' : 'esquerda';
      const actionDesc = pathStep.drop
        ? `Descendo poço para ${dirLabel}`
        : pathStep.jump
          ? (hasSpaceJump ? `Space Jump rumo à ${dirLabel}` : `Contornando/subindo para ${dirLabel}`)
          : nearDoor
            ? `Abrindo porta (${targetDoor!.side})`
            : ceilingLow
              ? `Passando sob teto para ${dirLabel}`
              : `Indo para ${dirLabel}`;

      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        115,
        'run',
        motionPct,
        isTimedEscape ? 'Fuga c/ Temporizador!' : `Exploração · ${pathStep.drop ? 'Descendo' : pathStep.jump ? 'Escalando' : 'Rumo à saída'}`,
        `Sala 0x${wram.roomId.toString(16).toUpperCase()} (${wram.samusX},${wram.samusY}) · ${actionDesc}`,
        wram,
      );
    }

    // Fallback sem portas mapeadas na sala (ex.: elevador central ou área vertical)
    const isVerticalShaft = wram.roomHeightPx > wram.roomWidthPx && wram.roomWidthPx <= 512;
    const hitSmallStep = isGrounded && Math.abs(this.samusVx) === 0 && (this.roomMovedOnce || this.roomTicks > 48) && !ceilingLow;
    const jumpInterval = isVerticalShaft ? 5 : 11;
    const shouldJump = !ceilingLow && (hitSmallStep || (isGrounded && this.stepIndex % jumpInterval === 0));

    const keys: AIKey[] = [this.moveDir, dashKey];
    if (isGrounded && this.stepIndex % 24 === 0 && !hasSpaceJump && !isTimedEscape) {
      keys.push('DOWN');
    }
    if (hasSpaceJump && !ceilingLow && (isTimedEscape || isVerticalShaft)) {
      if (isGrounded ? this.nextJump(true, 3) : (this.stepIndex % 2 === 0 || this.samusVy >= 0)) {
        keys.push(jumpKey);
      }
    } else if (this.nextJump(shouldJump, isVerticalShaft ? 4 : 3)) {
      keys.push(jumpKey);
    }
    if (this.nextShoot(isTimedEscape || this.stepIndex % 4 === 0)) {
      keys.push(shootKey);
    }
    const dirLabel = this.moveDir === 'RIGHT' ? 'direita' : 'esquerda';
    const posture = isGrounded ? 'no solo' : this.samusVy < 0 ? 'subindo' : 'descendo';
    return this.makeMetroidAction(
      'EXPLORE',
      keys,
      115,
      'run',
      motionPct,
      isTimedEscape ? 'Fuga c/ Temporizador!' : 'Exploração ativa',
      `Sala 0x${wram.roomId.toString(16).toUpperCase()} (${wram.samusX},${wram.samusY}) · ${posture}, indo p/ ${dirLabel}`,
      wram,
    );
  }

  private decideUniversalVision(
    m: GridMetrics,
    motionPct: number,
    profile: AIProfile,
    targetDifficulty: string,
  ): AIAction {
    const buildVisualSnapshot = (
      mode: AgentBehaviorMode,
      keys: AIKey[],
      sceneLabel: string,
      reason: string,
      uSearchPhase: USearchPhase = 'NONE',
    ): AIStatusSnapshot => this.buildSnapshot(mode, keys, sceneLabel, reason, null, false, false, uSearchPhase);

    if (m.avgLum < 7) {
      this.darkTickCount++;
      const k: AIKey = this.darkTickCount % 6 === 0 ? 'START' : 'NONE';
      this.currentMode = 'MENU';
      return {
        key: k,
        keys: [k],
        time: 160,
        phase: 'menu',
        motionPct,
        sceneLabel: 'Transição escura',
        reason: 'Aguardando tela',
        snapshot: buildVisualSnapshot('MENU', [k], 'Transição escura', 'Aguardando tela'),
      };
    }
    this.darkTickCount = 0;

    if (m.totalMotion < 0.012) this.stagnantCount++;
    else this.stagnantCount = 0;

    if (profile === 'rpg') {
      const hasDialogBox = m.bottomBandContrast > 60 && m.topMotion < 0.015;
      const inCombatFlash = m.totalMotion > 0.11 && m.bottomBandContrast > 52;

      if (inCombatFlash) {
        this.currentMode = 'COMBAT';
        this.visualUSearch.active = false;
        const keys: AIKey[] = [this.stepIndex % 3 === 0 ? 'RIGHT' : 'A'];
        return {
          key: keys[0],
          keys,
          time: 140,
          phase: 'run',
          motionPct,
          sceneLabel: 'Combate RPG',
          reason: 'Executando ação de batalha',
          snapshot: buildVisualSnapshot('COMBAT', keys, 'Combate RPG', 'Executando ação de batalha'),
        };
      }

      if (hasDialogBox || this.stagnantCount >= 4) {
        this.currentMode = 'MENU';
        const k: AIKey = this.stagnantCount % 5 === 4 ? 'DOWN' : 'A';
        return {
          key: k,
          keys: [k],
          time: 140,
          phase: this.stagnantCount >= 3 ? 'menu' : 'run',
          motionPct,
          sceneLabel: hasDialogBox ? 'Diálogo / Coleta RPG' : 'Menu RPG',
          reason: k === 'A' ? 'Avançando diálogo ou interação' : 'Navegando opção',
          snapshot: buildVisualSnapshot('MENU', [k], hasDialogBox ? 'Diálogo RPG' : 'Menu RPG', 'Navegando diálogo'),
        };
      }

      const dirs: Array<'RIGHT' | 'UP' | 'LEFT' | 'DOWN'> = ['RIGHT', 'UP', 'LEFT', 'DOWN'];
      const currDir = dirs[this.rpgDirIdx];

      // Padrão em 'U' ortogonal no RPG quando bloqueado
      if (this.visualUSearch.active) {
        this.visualUSearch.ticksInPhase++;
        const b = this.visualUSearch.blockedDir;
        const perp1: AIKey = b === 'RIGHT' || b === 'LEFT' ? 'UP' : 'RIGHT';
        const perp2: AIKey = b === 'RIGHT' || b === 'LEFT' ? 'DOWN' : 'LEFT';
        const legs: Array<{ key: AIKey; len: number; phase: USearchPhase }> = [
          { key: perp1, len: 3, phase: 'BACKSTEP' },
          { key: b, len: 3, phase: 'ASCEND' },
          { key: perp2, len: 6, phase: 'DESCEND' },
          { key: b, len: 3, phase: 'ASCEND' },
        ];
        const leg = legs[this.visualUSearch.legIndex];
        if (!leg) {
          this.visualUSearch.active = false;
          this.visualUSearch.phase = 'NONE';
          this.rpgDirIdx = (this.rpgDirIdx + 2) % 4;
        } else {
          if (m.totalMotion >= 0.025 && this.visualUSearch.legIndex % 2 === 1) {
            this.visualUSearch.active = false;
            this.visualUSearch.phase = 'NONE';
          } else if (this.visualUSearch.ticksInPhase >= leg.len) {
            this.visualUSearch.legIndex++;
            this.visualUSearch.ticksInPhase = 0;
          }
          const k = leg.key;
          return {
            key: k,
            keys: [k],
            time: 190,
            phase: 'run',
            motionPct,
            sceneLabel: 'Exploração · Busca em U (RPG)',
            reason: `Contornando obstáculo em U (${k})`,
            snapshot: buildVisualSnapshot('EXPLORE', [k], 'Exploração · Busca em U', `Contornando em U (${k})`, leg.phase),
          };
        }
      }

      if (m.totalMotion < 0.016) {
        this.visualUSearch = {
          active: true,
          phase: 'BACKSTEP',
          blockedDir: currDir,
          ticksInPhase: 0,
          legIndex: 0,
        };
      }

      const chosen = this.stepIndex % 7 === 0 ? 'A' : currDir;
      this.currentMode = chosen === 'A' ? 'COLLECT' : 'EXPLORE';
      return {
        key: chosen,
        keys: [chosen],
        time: 210,
        phase: 'run',
        motionPct,
        sceneLabel: chosen === 'A' ? 'Coleta / Interação' : 'Exploração RPG',
        reason: chosen === 'A' ? 'Verificando item ou interação' : `Explorando (${chosen})`,
        snapshot: buildVisualSnapshot(this.currentMode, [chosen], 'Exploração RPG', `Explorando (${chosen})`),
      };
    }

    // Perfil Action visual (sem WRAM)
    if (this.stagnantCount >= 5) {
      this.currentMode = 'MENU';
      const wantsUp =
        targetDifficulty.toLowerCase().includes('super') || targetDifficulty.toLowerCase().includes('easy');
      const seq: AIKey[] = wantsUp ? ['START', 'A', 'UP', 'A', 'A'] : ['START', 'A', 'DOWN', 'A', 'A'];
      const k = seq[this.menuCycleIdx++ % seq.length];
      return {
        key: k,
        keys: [k],
        time: 140,
        phase: 'menu',
        motionPct,
        sceneLabel: 'Menu / Título',
        reason: `Navegando menu (${k})`,
        snapshot: buildVisualSnapshot('MENU', [k], 'Menu / Título', `Navegando menu (${k})`),
      };
    }

    if (m.totalMotion < 0.015) this.blockedTicks++;
    else this.blockedTicks = 0;

    if (this.visualUSearch.active) {
      this.visualUSearch.ticksInPhase++;
      const bDir: 'LEFT' | 'RIGHT' = this.visualUSearch.blockedDir === 'LEFT' ? 'LEFT' : 'RIGHT';
      const opp: 'LEFT' | 'RIGHT' = bDir === 'RIGHT' ? 'LEFT' : 'RIGHT';

      if (this.visualUSearch.phase === 'BACKSTEP') {
        const keys: AIKey[] = [opp, 'B'];
        if (this.visualUSearch.ticksInPhase >= 5) {
          this.visualUSearch.phase = 'ASCEND';
          this.visualUSearch.ticksInPhase = 0;
        }
        return {
          key: keys[0],
          keys,
          time: 135,
          phase: 'run',
          motionPct,
          sceneLabel: 'Exploração · Busca em U (1/3)',
          reason: 'Recuando do bloqueio para salto em U',
          snapshot: buildVisualSnapshot('EXPLORE', keys, 'Busca em U (1/3)', 'Recuando do bloqueio', 'BACKSTEP'),
        };
      }

      if (this.visualUSearch.phase === 'ASCEND') {
        const keys: AIKey[] = [bDir, 'B'];
        if (this.nextJump(true, 4)) keys.push('A');
        if (this.nextShoot(true)) keys.push('X');
        if (m.totalMotion >= 0.025 && this.visualUSearch.ticksInPhase >= 4) {
          this.visualUSearch.active = false;
          this.visualUSearch.phase = 'NONE';
          this.blockedTicks = 0;
          this.moveDir = bDir;
        } else if (this.visualUSearch.ticksInPhase >= 9) {
          this.visualUSearch.phase = 'DESCEND';
          this.visualUSearch.ticksInPhase = 0;
        }
        return {
          key: keys[0],
          keys,
          time: 135,
          phase: 'run',
          motionPct,
          sceneLabel: 'Exploração · Busca em U (2/3)',
          reason: 'Tentando passagem superior em U',
          snapshot: buildVisualSnapshot('EXPLORE', keys, 'Busca em U (2/3)', 'Tentando passagem superior', 'ASCEND'),
        };
      }

      if (this.visualUSearch.ticksInPhase <= 6) {
        const keys: AIKey[] = [opp, 'B'];
        if (this.nextShoot(true)) keys.push('X');
        return {
          key: keys[0],
          keys,
          time: 135,
          phase: 'run',
          motionPct,
          sceneLabel: 'Exploração · Busca em U (3/3)',
          reason: 'Varrendo saída alternativa antes de desistir',
          snapshot: buildVisualSnapshot('EXPLORE', keys, 'Busca em U (3/3)', 'Varrendo saída oposta', 'DESCEND'),
        };
      }

      this.visualUSearch.active = false;
      this.visualUSearch.phase = 'NONE';
      this.moveDir = opp;
      this.blockedTicks = 0;
    }

    if (this.blockedTicks >= 6) {
      this.visualUSearch = {
        active: true,
        phase: 'BACKSTEP',
        blockedDir: this.moveDir,
        ticksInPhase: 0,
        legIndex: 0,
      };
    }

    // Ataque rápido apenas quando há pico localizado no corredor central (filtrando parallax/cenário de fundo)
    if (this.visualCombatCooldown > 0) {
      this.visualCombatCooldown--;
    }
    const midFrontMotion = this.moveDir === 'RIGHT' ? m.midRightMotion : m.midLeftMotion;
    const backMotion = this.moveDir === 'RIGHT' ? m.midLeftMotion : m.midRightMotion;
    const bgBaseline = Math.max(m.topMotion, backMotion);
    const localizedFrontSpike = Math.max(0, midFrontMotion - bgBaseline * 1.15);

    if (
      this.visualCombatCooldown === 0 &&
      localizedFrontSpike > 0.045 &&
      midFrontMotion > 0.07 &&
      this.blockedTicks < 4
    ) {
      this.visualCombatStreak++;
      if (this.visualCombatStreak >= 6) {
        this.visualCombatStreak = 0;
        this.visualCombatCooldown = 8;
      } else {
        const keys: AIKey[] = [this.moveDir];
        if (this.nextShoot(true)) keys.push('X');
        this.currentMode = 'COMBAT';
        return {
          key: keys[0],
          keys,
          time: 125,
          phase: 'run',
          motionPct,
          sceneLabel: 'Combate · Alvo à frente',
          reason: 'Atacando movimento localizado à frente (cenário filtrado)',
          snapshot: buildVisualSnapshot('COMBAT', keys, 'Combate', 'Atacando movimento localizado'),
        };
      }
    } else {
      this.visualCombatStreak = 0;
    }

    this.currentMode = 'EXPLORE';
    const keys: AIKey[] = [this.moveDir, 'B'];
    if (this.nextJump(this.stepIndex % 9 === 0, 3)) keys.push('A');
    if (this.nextShoot(this.stepIndex % 4 === 0)) keys.push('X');
    return {
      key: keys[0],
      keys,
      time: 140,
      phase: 'run',
      motionPct,
      sceneLabel: 'Exploração contínua',
      reason: `Avançando para ${this.moveDir === 'RIGHT' ? 'direita' : 'esquerda'}`,
      snapshot: buildVisualSnapshot('EXPLORE', keys, 'Exploração ativa', `Avançando para ${this.moveDir === 'RIGHT' ? 'direita' : 'esquerda'}`),
    };
  }
}
