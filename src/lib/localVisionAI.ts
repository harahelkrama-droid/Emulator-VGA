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
import {
  buildChecklist,
  checkGate,
  classifyDoorColor,
  detectLost,
  directionForDoor,
  gateForDoor,
  missionComplete,
  planNextTarget,
  readMapScreen,
  reopenBacklog,
  describeChecklistForUi,
  describeNavForUi,
  lakeTopBlock,
  senseMoltenLake,
  deriveMoltenCalib,
  moltenCellMean,
  MOLTEN_CELL,
  MOLTEN_COLS,
  MOLTEN_ROWS,
  type MoltenLake,
  type ChecklistItem,
  type LostVerdict,
  type MapHintDir,
  type MapReading,
  type NavBacklogEntry,
  type NavDoor,
  type NavGraph,
  type NavRoom,
  type NavTarget,
  type DoorColor, type CompletionTotals, XFUSION_TOTALS, COMPLETION_TOTALS,} from './mapStrategy';
import {
  decideEscort,
  ESCORT_MEMORY_TICKS,
  metroidKillReady,
  type EscortDoor,
  type EscortEntity,
} from './metroidEscort';
import { ActionGuardian, cellKey, targetKey } from './actionGuardian';
import type { EscapePlan } from './actionGuardian';
import {
  SelfCorrectionLedger,
  type CorrectionEffect,
  type FaultKind,
} from './selfCorrection';
import {
  planBossFight,
  describeDirectiveForUi,
  type BossDirective,
  type BossObservation,
  type BossFightMemory,
  type LoadoutView,
} from './bossCodex';
import { detectDangerColor } from './visionDanger';
import { getMissionSystem, type SectorId, type MissionSystem } from './missionSystem';

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
  /** caminhos secretos detectados via X-Ray (blocos falsos nas bordas) */
  secretPaths: Map<string, { bx: number; by: number; x: number; y: number; blockType: number; bts: number; tested: boolean; reason: string }>;
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
  /** prioridade relativa para ordenação de pendentes (maior = mais urgente) */
  priority?: number;
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
  /** letra do terminal no mapa (A, N, D, S) para sequência de ativação */
  letter?: string;
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
  /**
   * Memória de idas e vindas entre salas (A→B→A). Um único round trip é normal — ela entrou,
   * viu, volta. Dois round trips seguidos pela MESMA porta significam que o "próximo alvo"
   * do planejador é a sala que ela acabou de deixar: o alvo de lá manda ela voltar, e o ciclo
   * não tem fim. Foi exatamente o que substituiu a caçada ao bloco falso no playtest de
   * 25 min: 8.226 ticks (66 % da sessão) e 240 travessias entre 0x8B7D e 0x8BBB, com a Samus
   * quase nunca andando dentro da sala nova.
   */
  /**
   * "acabei de entrar por esta porta": veto curto (14 ticks) contra o batente de chegada.
   * O jogo entrega a Samus DENTRO da porta com a tecla anterior ainda segurada pelo laço de
   * decisão; sem o veto, o primeiro passo do plano na sala nova é o caminho de volta e a
   * travessia re-dispara. Custa 2,4 s e economiza a sessão inteira (ver `bounceTally`).
   */
  private entryCalm: { roomId: number; forbid: 'LEFT' | 'RIGHT'; until: number; x: number; y: number } | null = null;
  /**
   * Orçamento da TENTATIVA DE PORTA. Ficar na soleira atirando/girando slot sem a sala trocar não
   * é progresso — é o estado em que a sessão de 25 min terminou: 9.160 ticks (79 % do tempo) em
   * 0x8CB3 x=216 com `Abrindo porta (RIGHT)`, e o sentinela mudo porque o chão daquela soleira é
   * lido como "no ar". Um humano atira, gira o slot, espera o scroll e, se nada acontece, trata a
   * porta como trancada e procura outra. É o que este orçamento faz.
   */
  private doorAttempt = { key: '', ticks: 0 };
  private roomChain: number[] = [];
  private bounceTally = new Map<string, { n: number; tick: number }>();
  /** aresta proibida como destino de alvo: `${from}->${to}` → até quando */
  private bounceBan = new Map<string, number>();
  /** ticks consecutivos dentro do estado de transição de porta (0x0b) */

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
  // ─── camada de verificação (src/lib/actionGuardian.ts) ──────────────────────────────
  // Nada aqui troca a heurística do agente: é o freio dela. Cada jogada repetitiva vira uma
  // hipótese com orçamento (e é confrontada com o efeito real no tick seguinte) e o
  // travamento passa a ser medido por ganho HORIZONTAL — pular no mesmo tijolo deixa de contar
  // como progresso. O playtest de 25 min (playtest/RELATORIO-IA-25min.md) mostrou que a falta
  // dessa peça custou 22 minutos de sessão numa sala atravessável em 3 s.
  private readonly guardian = new ActionGuardian();
  /** teclas do último AIAction — o sentinela precisa saber para onde ela estava EMPURRANDO */
  private lastActionKeys: AIKey[] = [];
  /** ms do último AIAction (vão de pulo curto redefine a cadência do próximo tick) */
  private lastActionMs = 125;
  private guardianRoomId = -1;
  /** true no tick em que a sala acabou de trocar (lido pela escada de escape) */
  private roomChangedThisTick = false;
  /** degrau MAP_READ pede leitura de mapa já, sem esperar o refratário */
  private forceMapReadTicks = 0;
  /** aposta de bloco falso a ser conferida no tick seguinte (abriu ou não abriu?) */
  private pendingSecretShot: { key: string; roomId: number; bx: number; by: number } | null = null;
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
    /** letra do terminal no mapa (A, N, D, S ...) para sequência de ativação */
    letter?: string;
  }> = [];
  private currentInteractionTarget: { bx: number; by: number; x: number; y: number; type: string } | null = null;
  private interactionCooldown = 0;
  private lastInteractionTick = -100;
  private roomsWithPowerIssue = new Set<number>(); // salas que precisam de energia auxiliar
  private powerAuxActivated = false; // se a energia auxiliar foi ativada
  /** Salas/setores onde o terminal A (Auxiliary Power) já foi ativado.
   *  O A é o gate do setor: sem ele, não dá para ativar N, D ou S naquele setor.
   */
  private sectorPowerAuxActivated = new Set<number>();
  /** Salas/setores onde já foram detectados terminais pendentes */
  private sectorTerminalsPending = new Map<number, Set<string>>(); // roomId → Set de letras pendentes
  /** Sistema de missão completa — rastreia progresso por setor, terminais, itens, energia */
  private missionSystem: MissionSystem | null = null;
  private stuckInRoomTicks = 0;
  private lastRoomEntryTick = 0;

  // Preferência de direção da exploração (o mapa lido pode sobrescrevê-la)
  private preferredDirection: 'LEFT' | 'RIGHT' | null = null;
  // Consulta de mapa: no Super Metroid é START (o SELECT só cicla item especial — manual,
  // seções 1 e 6). O ciclo antigo segurava SELECT por "3 minutos de análise", o que na
  // prática só trocava de arma repetidamente. Agora a leitura é curta e tem gatilho.
  private readonly MAP_CONSULT_INTERVAL_TICKS = 1800;     // reavalia o mapa a cada ~3 min
  private readonly MAP_CONSULT_MAX_TICKS = 14;            // no ar, no máximo ~1,5 s
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

  // ---------------------------------------------------------------------
  // Codex de Chefes (guia estratégico consultável)
  // ---------------------------------------------------------------------
  /** Memória de luta por alvo (`slot|enemyId`), devolvida pura pelo codex. */
  private bossFightMemory = new Map<string, BossFightMemory>();
  /** Estratégia que resolveu uma sala antes: ao voltar, ela é aplicada direto. */
  private bossRoomBindings = new Map<number, string>();
  private bossMemoryRoomId = -1;
  /** Diretiva do tick atual (lida pelo snapshot e pelo combate). */
  private bossDirective: BossDirective | null = null;
  private bossSelectTicks = 0;
  private bossSlotGaveUp = false;
  private bossChargeHold = 0;
  /** true no tick em que há chefe na sala (trava o modo combate e preserva a munição). */
  private bossEngagedThisTick = false;
  /** Sala onde uma luta de chefe está em andamento (HP do chefe cai e o limiar fixo sumiria). */
  private bossEngagedRoomId = -1;
  private samusDamagedThisTick = false;
  private lastCutsceneTick = -1000;
  private cutsceneRoomId = -1;
  /** Aproximação das torres de energia do Draygon (pré-requisito do grapple). */
  private stationSpots = new Map<number, { ticks: number; goneTicks: number; destroyed: boolean }>();
  private stationRoomId = -1;

  // ----------------------------------------------------------- navegação/mapa
  /** cor classificada por porta: `${roomId}:${doorKey}` → cor do batente no frame */
  private navDoorColors = new Map<string, DoorColor>();
  /** itens pendentes / painéis / perigo por sala (o grafo do agente só guarda portas) */
  private navExtras = new Map<number, { itemsPending: number; itemsSeen: number; terminalsPending: number; seen: boolean; danger: number; areaIndex: number; bossName?: string }>();
  private roomTrail: number[] = [];
  private navStartRoomId = -1;
  private navPrevItemCount = 0;
  /** lago de lava reconhecido no frame (o mapa de blocos vê ar onde há lava) */
  /**
   * Ledger do "erro → diagnóstico → correção". Único lugar onde a IA muda os próprios
   * parâmetros em tempo de execução (threshold de lava, custo de perigo, cor de porta,
   * célula inquebrável). É memória de sessão, com teto de correções ativas.
   */
  private selfFix = new SelfCorrectionLedger();
  /** tiros dados em cada porta sem a porta mudar de estado (3 = minha premissa estava errada) */
  private doorShotTally = new Map<string, number>();
  /**
   * Testemunha de chão: célula a célula, quantos ticks ela ficou marcada como lava enquanto a
   * Samus estava em cima SEM tomar dano. Chega a 10 → aquilo não é lava (a paleta vermelha do
   * cenário do hack engana o detector, e foi isso que a travou na sala do print). Prova negativa
   * vale tanto quanto a positiva: um detector que só sabe dizer "sim" vira superstição.
   */
  private lavaWitness = new Map<string, number>();
  /** vida no último tick, para a testemunha ver o dano que AINDA VAI SER ROTULADO neste tick */
  private lavaWitnessHealth = -1;
  private lavaProvenSafe = new Set<string>();
  /** ticks seguidos percorrendo a região marcada sem dano (a prova de travessia) */
  private lavaCrossTicks = 0;
  /** salas onde o veto de chão hostil foi desligado por falso-positivo provado */
  private lavaVetoOff = new Set<number>();
  // memória da escolta de Metroid (o bicho é o roteiro: seguir, não atirar)
  private metroidSeenTick = -9999;
  private metroidSeenRoomId = -1;
  private metroidPrevX = 0;
  private metroidExitDir: 'LEFT' | 'RIGHT' | null = null;
  private escortIgnoreMobsUntil = -1;
  private lastFaultTick = new Map<string, number>();
  private lavaLake: MoltenLake | null = null;
  private lavaLakeRoomId = -1;
  private lavaLakeTick = -99;
  private lavaCamX = -1;
  private lavaCamY = -1;
  /** sala em que a rota da beira de lava foi "commitada" (o guard não solta o comando) */
  private lavaEdgeCommitRoom = -1;
  private lavaTopRow = -1;
  private lastNewRoomTick = 0;
  private lastNavProgressTick = 0;
  /**
   * Sonda deliberada do "lago". O veto por cor é a proteção certa contra lava de verdade, mas
   * tem um ângulo cego: se o vermelho for cenário, NADA a faz pisar ali para descobrir, e ela
   * passa o countdown dançando na beira (foi o que o print mostrou). Depois de um tempo preso
   * sem progresso, o medo é suspenso por alguns ticks de PROPÓSITO: atravessar e medir. Errar
   * custa alguns pontos de vida; não arriscar custa a run.
   */
  private lavaProbeUntil = -1;
  private lavaProbeLockUntil = -1;
  private lavaProbeFails = 0;
  private navLost: LostVerdict = { lost: false, cause: null, severity: 0, note: 'navegação ainda não avaliada' };
  private navBacklog: NavBacklogEntry[] = [];
  private navTarget: NavTarget | null = null;
  private navPlanTick = -9999;
  private navChecklist: ChecklistItem[] = [];
  private mapReading: MapReading | null = null;
  private mapHint: { dir: MapHintDir; score: number } | null = null;
  private mapHintTick = -9999;
  private mapConsultPhase: 'IDLE' | 'OPEN' | 'PAN' | 'CLOSE' = 'IDLE';
  /**
   * "depois de 3 minutos assim que carregar o jogo": o menu/mapa só pode abrir depois que o
   * agente tiver esse tempo de sessão (contado em decisões, ~120 ms cada). Carregar um
   * save-state reinicia a contagem e DÁ PERMISSÃO IMEDIATA (noteSaveStateLoaded) — o
   * pedido explícito do usuário: menu depois de 3 min do load, ou logo após carregar um save.
   */
  menuArmAfterTicks = 1500;
  private menuClockOriginTick = -1;
  private menuGrantedAfterSave = false;
  private offPlayfieldTicks = 0;
  private mapPageScanStep = 0;
  /** Gravity Suit (0x0020): com ela a lava deixa de ser obstáculo (travessia livre) */
  private lavaSafe = false;
  /**
   * Perfil da ROM. 'xfusion' troca os totais do checklist (47 mísseis, 7 Reserve-X — vistos
   * no 100% zerado do GebirgeBR) e liga o modo "espinho é quase morte" que o vídeo descreve.
   * O EmulatorPlayer detecta pelo header da ROM e chama setCompletionProfile().
   */
  private completionProfile: 'vanilla' | 'xfusion' = 'vanilla';

  setCompletionProfile(profile: 'vanilla' | 'xfusion'): void {
    if (profile === this.completionProfile) return;
    this.completionProfile = profile;
    this.navChecklist = []; // recalcula no próximo tick com os totais novos
  }

  get currentCompletionProfile(): 'vanilla' | 'xfusion' {
    return this.completionProfile;
  }
  private mapConsultTick = 0;
  private mapClosePresses = 0;
  private mapReadRoomCount = -1;
  private mapReadBackoff = 120;
  private lastMapReadTick = 0;
  private mapReadFailedTick = -9999;
  /** linha de base do início da sessão, para contar expansões coletadas pela IA */
  private baseMaxHealth = 0;
  private baseMaxMissiles = 0;
  private baseMaxSupers = 0;
  private baseMaxBombs = 0;
  private stationsDestroyedCount = 0;

  reset(): void {
    this.menuClockOriginTick = -1;
    this.menuGrantedAfterSave = false;
    this.offPlayfieldTicks = 0;
    this.mapPageScanStep = 0;
    this.lavaSafe = false;
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
    this.guardian.reset();
    this.lastActionKeys = [];
    this.lastActionMs = 125;
    this.guardianRoomId = -1;
    this.roomChangedThisTick = false;
    this.forceMapReadTicks = 0;
    this.pendingSecretShot = null;
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
    this.selfFix = new SelfCorrectionLedger();
    this.doorShotTally.clear();
    this.lastFaultTick.clear();
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
    this.bossFightMemory.clear();
    this.bossRoomBindings.clear();
    this.bossMemoryRoomId = -1;
    this.bossDirective = null;
    this.bossSelectTicks = 0;
    this.bossSlotGaveUp = false;
    this.bossChargeHold = 0;
    this.bossEngagedThisTick = false;
    this.bossEngagedRoomId = -1;
    this.samusDamagedThisTick = false;
    this.lastCutsceneTick = -1000;
    this.cutsceneRoomId = -1;
    this.stationSpots.clear();
    this.stationRoomId = -1;
    this.navDoorColors.clear();
    this.navExtras.clear();
    this.roomTrail = [];
    this.navStartRoomId = -1;
    this.navPrevItemCount = 0;
    this.lavaLake = null;
    this.lavaEdgeCommitRoom = -1;
    this.lavaLakeRoomId = -1;
    this.lavaLakeTick = -99;
    this.lavaCamX = -1;
    this.lavaCamY = -1;
    this.lavaTopRow = -1;
    this.lastNewRoomTick = 0;
    this.lastNavProgressTick = 0;
    this.navLost = { lost: false, cause: null, severity: 0, note: 'reset' };
    this.navBacklog = [];
    this.navTarget = null;
    this.navPlanTick = -9999;
    this.navChecklist = [];
    this.mapReading = null;
    this.mapHint = null;
    this.mapHintTick = -9999;
    this.mapConsultPhase = 'IDLE';
    this.mapClosePresses = 0;
    this.mapReadRoomCount = -1;
    this.mapReadBackoff = 120;
    this.lastMapReadTick = 0;
    this.mapReadFailedTick = -9999;
    this.stationsDestroyedCount = 0;
    this.interactiveObjects = [];
    this.currentInteractionTarget = null;
    this.interactionCooldown = 0;
    this.lastInteractionTick = -100;
    this.stuckInRoomTicks = 0;
    this.lastRoomEntryTick = this.stepIndex;
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
        secretPaths: new Map(),
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
        // morrer é o erro mais caro da sessão: entra no caderno como falha com causa, e a
        // correção (sala marcada como cara, penalidade de perigo acima) vale para a próxima
        // tentativa em vez de eu simplesmente repetir a rota que me matou
        if (this.faultCooldownOk('RESPAWN', `sala ${wram.roomId}`, this.stepIndex)) {
          this.applyCorrection(
            this.selfFix.observe({
              kind: 'RESPAWN',
              tick: this.stepIndex,
              roomId: wram.roomId,
              bx: Math.floor(wram.samusX / 16),
              by: Math.floor(wram.samusY / 16),
            }),
          );
        }
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
      this.forgiveStall();
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


  // ===================================================== NAVEGAÇÃO COM O MAPA DO JOGO

  /**
   * Reconhece lago de lava no frame da sala atual. Precisamos disso porque a lava não é
   * bloco sólido no Super Metroid: o mapa de blocos diz "ar" e o planejador manda a Samus
   * caminhar para dentro do lago.
   */
  private senseLavaFloor(wram: MetroidWramSnapshot): void {
    // uma autocorreção da calibração pede releitura imediata (senão o threshold novo só
    // valeria no próximo tick de amostragem, isto é, depois de mais um passo dentro do lago)
    if (this.selfFix.needsRescan) {
      this.selfFix.clearRescanFlag();
      this.lavaLakeRoomId = -1;
      this.lavaLakeTick = -99;
    }
    // Gravity Suit muda a SEMÂNTICA da lava (ela vira "água quente" atravessável), e o
    // jogador pode achá-la a qualquer momento — por isso isso é lido todo tick, não no
    // throttle da amostragem de frame.
    // Gravity Suit declarada por um inventário NÃO-confiável é o pior tipo de engano: ela não
    // cria um alvo, ela retira um veto (a lava vira "atravessável"). Conservador por padrão.
    const safe = wram.inventoryTrusted && (wram.itemsMask & 0x0020) !== 0;
    if (safe !== this.lavaSafe) {
      this.lavaSafe = safe;
      if (safe) {
        this.lavaLake = null;
        this.lavaTopRow = -1;
        this.lavaEdgeCommitRoom = -1;
      } else {
        this.lavaLakeRoomId = -1; // acabou a suit (swap?): remedia o frame na hora
      }
    }
    if (safe) return;
    const roomChanged = this.lavaLakeRoomId !== wram.roomId;
    const camMoved =
      Math.abs(wram.cameraX - this.lavaCamX) >= MOLTEN_CELL || Math.abs(wram.cameraY - this.lavaCamY) >= MOLTEN_CELL;
    if (!roomChanged && !camMoved && this.stepIndex - this.lavaLakeTick <= 8) return;
    const frame = this.lastCapturedFrame;
    const rgba = frame?.rgba as unknown as Uint8ClampedArray | undefined;
    if (!rgba || !frame || frame.width < 64) {
      if (roomChanged) {
        // sala nova sem frame amostrado ainda: não marca o tick, tenta de novo no próximo
        this.lavaLakeRoomId = -1;
        this.lavaLake = null;
        this.lavaTopRow = -1;
      }
      return;
    }
    this.lavaLakeRoomId = wram.roomId;
    this.lavaLakeTick = this.stepIndex;
    this.lavaCamX = wram.cameraX;
    this.lavaCamY = wram.cameraY;
    if (roomChanged) {
      this.lavaEdgeCommitRoom = -1;
      this.lavaProbeUntil = -1; // sala nova: a sonda da anterior não contamina
    }
    let lake = senseMoltenLake(rgba, frame.width, frame.height, this.selfFix.lavaCalib);
    if (lake && this.lavaVetoOff.has(wram.roomId)) {
      // falso-positivo já provado nesta sala: segue sem veto (o ledger decidiu com prova, não por gosto)
      lake = null;
    } else if (lake) {
      lake = this.pruneProvenSafeCells(wram, lake);
    }
    this.lavaLake = lake;
    this.lavaTopRow = lake ? lakeTopBlock(lake, wram.cameraY) : -1;
    if (lake && roomChanged) {
      // a sala tem chão hostil: registra como perigosa para o plano não voltar por acaso
      const extra = this.navExtras.get(wram.roomId);
      if (extra) extra.danger = Math.min(4, extra.danger + 1);
    }
  }

  /**
   * Guard de beira de lava.
   *
   * Olha para BAIXO, não só para o pé: no ar acima de um lago a Samus ainda não está na
   * lava, e é exatamente aí que o passeio cego a empurrava para dentro (o guard antigo só
   * via o perigo na linha do chão, e entre um pulo e outro outro ramo assumia o controle).
   *
   * Ordem de decisão: porta para cima da sala → coluna segura mais próxima (air control) →
   * parar na beirada. Nunca "inverte o lado" às cegas, porque do outro lado também há lago.
   */
  private lavaEdgeInfo(
    wram: MetroidWramSnapshot,
    bx: number,
    by: number,
    intended: 'LEFT' | 'RIGHT',
  ): { keys: AIKey[]; reason: string } | null {
    // Com Gravity Suit o lago deixou de ser obstáculo: o planejador anda pelo fundo como se
    // fosse chão normal (é o que a suit faz no jogo real), e os pulos em cadência (Space
    // Jump) já existem na caminhada. O que a suit NÃO resolve sozinha é a comporta fechada
    // lá em cima — então neste modo o guard só serve para isso.
    if (this.lavaSafe) {
      const upClosed = wram.doors.find(
        (d) => d.side === 'UP' && d.blockedByWall && this.navDoorAffordable(wram, d.key),
      );
      if (!upClosed) return null;
      return this.upDoorShootApproach(wram, upClosed, bx);
    }
    if (!this.lavaLake) return null;
    const rw = wram.roomWidthBlocks;
    const rh = wram.roomHeightBlocks;
    const lavaAt = (cx: number, cy: number): boolean =>
      cx >= 0 && cy >= 0 && cx < rw && cy < rh && this.isLavaCell(wram, cx, cy);
    /** linha em que uma queda nessa coluna terminaria em lava (-1 = seguro) */
    const dropInto = (cx: number): number => {
      for (let cy = Math.max(0, by); cy <= Math.min(rh - 1, by + 6); cy++) {
        if (lavaAt(cx, cy)) return cy;
      }
      return -1;
    };

    const aheadBx = intended === 'RIGHT' ? bx + 1 : bx - 1;
    const aheadLavaRow = dropInto(aheadBx);
    const hereLavaRow = dropInto(bx);
    const threatened = aheadLavaRow >= 0 || hereLavaRow >= 0;
    // Rota commitada: numa sala com lago, o passeio cego NÃO pode retomar o controle no
    // meio do caminho (era assim que a cada 2 ticks outro ramo a puxava de volta para o
    // lado errado). O guard assume a sala até sair dela; sem ameaça imediata ele só guia.
    const committed = this.lavaEdgeCommitRoom === wram.roomId;
    if (!threatened && !committed) return null;

    // memória de perigo: a célula do lago fica marcada para as próximas visitas
    if (aheadLavaRow >= 0) this.dangerCells.add(`${wram.roomId}:${aheadBx},${aheadLavaRow}`);
    if (threatened) this.lavaEdgeCommitRoom = wram.roomId;

    const { jump: jumpKey, run: dashKey } = wram.controls;
    const isGrounded = this.isSamusGrounded(wram);
    const safeColumn = (cx: number): boolean =>
      cx >= 0 && cx < rw && dropInto(cx) < 0 && !lavaAt(cx, by) && this.resolveBlockType(wram, cx, by) !== 0x8;

    // 1) saída vertical da sala: caminhe até ela pelo que estiver livre e suba.
    // Se a comporta do teto estiver FECHADA, a resposta é a do pedido do usuário: atirar
    // para cima e pular — nada de ficar empurrando UP numa parede vermelha.
    const upOpenDoor = wram.doors.find((d) => d.side === 'UP' && !d.blockedByWall);
    const upClosedDoor = wram.doors.find(
      (d) => d.side === 'UP' && d.blockedByWall && this.navDoorAffordable(wram, d.key),
    );
    if (!upOpenDoor && upClosedDoor) {
      return this.upDoorShootApproach(wram, upClosedDoor, bx);
    }
    const upDoor = upOpenDoor ?? null;
    if (upDoor) {
      const doorBx = Math.floor(upDoor.x / 16);
      const dir: 'LEFT' | 'RIGHT' = doorBx >= bx ? 'RIGHT' : 'LEFT';
      const step = dir === 'RIGHT' ? 1 : -1;
      let clear = true;
      for (let cx = bx + step; cx !== doorBx + step; cx += step) {
        if (Math.abs(cx - bx) > 14) break;
        if (dropInto(cx) >= 0 || this.resolveBlockType(wram, cx, by) === 0x8) {
          clear = false;
          break;
        }
      }
      const near = Math.abs(upDoor.x - wram.samusX) < 40;
      const keys: AIKey[] = clear ? [dir, ...(near ? [] : [dashKey])] : [dir];
      if (near) keys.push('UP');
      if (near && isGrounded) keys.push(jumpKey);
      if (near && !isGrounded) keys.push('UP');
      return {
        keys,
        reason: clear
          ? near
            ? 'lava no chão · subindo pela porta superior'
            : 'lava no chão da sala · andando pela borda até a porta superior'
          : 'lava bloqueando o chão · pulando a beirada em direção à porta superior',
      };
    }

    // 2) sem porta para cima: procure a coluna segura mais próxima (inclusive voltando)
    for (const dir of [intended === 'RIGHT' ? 'LEFT' : 'RIGHT', intended] as const) {
      const step = dir === 'RIGHT' ? 1 : -1;
      for (let d = 1; d <= 8; d++) {
        const cx = bx + step * d;
        if (cx < 0 || cx >= rw) break;
        if (dropInto(cx) >= 0) continue;
        // plataforma acima naquele lado? serve tanto quanto chão seguro
        const ledgeUp = [1, 2, 3].some(
          (lift) => safeColumn(cx) && this.isCellStandableProbe(wram, cx, by - lift) && !this.isHazardAt(wram, cx, by - lift - 1),
        );
        if (safeColumn(cx) || ledgeUp) {
          const keys: AIKey[] = [dir, dashKey];
          if (isGrounded && (this.stepIndex % 3 === 0 || !safeColumn(bx))) keys.push(jumpKey);
          return { keys, reason: `lava à frente · voltando para a borda segura a ${dir === 'RIGHT' ? 'direita' : 'esquerda'}` };
        }
      }
    }

    // 3) cercada: não anda para dentro de jeito nenhum. Segura o lugar (e o plano decide se
    // falta altura de pulo) em vez de inverter o lado e cair no lago do outro lado.
    return {
      keys: isGrounded ? [jumpKey] : [],
      reason: hereLavaRow >= 0
        ? 'sobre o lago de lava · tentando não afundar'
        : 'lava dos dois lados · precisando de altura de pulo (Hi-Jump/Space Jump)',
    };
  }

  /**
   * "Atirar na porta de cima e pular, só isso." Caminha até embaixo da comporta, segura UP
   * para mirar para cima e dispara — selecionando o item certo primeiro (o SELECT do HUD é
   * o que troca míssil/super/bomba). Quando a porta cede, quem entra é o ramo de escalada.
   */
  private upDoorShootApproach(
    wram: MetroidWramSnapshot,
    door: DoorInfo,
    bx: number,
  ): { keys: AIKey[]; reason: string } {
    const doorBx = Math.floor(door.x / 16);
    const dir: 'LEFT' | 'RIGHT' = doorBx >= bx ? 'RIGHT' : 'LEFT';
    const near = Math.abs(door.x - wram.samusX) < 28;
    const { run: dashKey, shoot: shootKey, select: selectKey, jump: jumpKey } = wram.controls;
    const keys: AIKey[] = near ? ['UP'] : [dir, dashKey];
    if (near) {
      // 1) deixa o míssil selecionado ANTES de atirar; 2) só então dispara e pula. O driver de
      // slot devolve um tick por toque, então o HUD é lido entre toques em vez de "torcer".
      const slot = this.slotPlanFor(wram, 'MISSILES');
      if (slot.tap) {
        keys.push(selectKey);
      } else if (slot.restore) {
        keys.push(wram.controls.cancel);
      } else {
        if (this.nextShoot(true)) {
          keys.push(shootKey);
          this.registerMissileUse();
          this.noteDoorShot(wram, door);
        }
        // pulo curto encostando no batente: em comporta alta é o que encosta o projétil/mira
        const shape = this.guardian.jumpHold(wram.samusY - 40, wram.samusY, this.isSamusGrounded(wram));
        if (this.isSamusGrounded(wram) && this.nextJump(true, shape.holdTicks)) keys.push(jumpKey);
      }
    }
    return {
      keys,
      reason: near
        ? 'comporta do teto · atirando para cima'
        : 'lava no chão · indo até a porta superior para atirar nela',
    };
  }

  /**
   * Contabiliza tiro em porta e, no terceiro sem efeito, conclui que a PREMISSA estava errada
   * (a cor amostrada não batia com o que a porta é) — o ledger marca a célula como não
   * quebrável, e o planificador para de gastar munição nela. Um humano faria o mesmo e xingaria.
   */
  private noteDoorShot(wram: MetroidWramSnapshot, door: DoorInfo): void {
    const key = `${wram.roomId}:${door.key}`;
    const shots = (this.doorShotTally.get(key) ?? 0) + 1;
    this.doorShotTally.set(key, shots);
    if (shots >= 3 && door.blockedByWall) {
      this.doorShotTally.delete(key);
      if (this.faultCooldownOk('AMMO_WASTED', `sala ${wram.roomId}`, this.stepIndex)) {
        this.applyCorrection(
          this.selfFix.observe({
            kind: 'AMMO_WASTED',
            tick: this.stepIndex,
            roomId: wram.roomId,
            bx: door.bx,
            by: door.by,
            doorKey: key,
            attempts: shots,
          }),
        );
      }
    }
  }

  /**
   * Registra o contraste entre "o detector chamou de lava" e "estou dentro disso e estou
   * inteira". Dano zera a testemunha da célula (ela É lava); 10 ticks seguidos sem dano dentro
   * da região marcada provam o contrário. Não precisa estar no chão: numa lava de verdade o
   * dano vem em qualquer tick de sobreposição, e em cima do lago (ar livre) a célula nem está
   * marcada, então "no ar sobre o lago" não gera prova falsa.
   */
  private noteLavaWitness(wram: MetroidWramSnapshot, lake: MoltenLake): void {
    // O dano é rotulado MAIS ABAIXO no mesmo tick (this.samusDamagedThisTick ainda está false
    // aqui). Sem ler a vida eu apagaria um lago VERDADEIRO: a prova "não doeu" só vale se o
    // HP é o mesmo do tick anterior.
    const hurt = this.lavaWitnessHealth >= 0 && wram.health < this.lavaWitnessHealth;
    this.lavaWitnessHealth = wram.health;
    if (hurt) this.lavaCrossTicks = 0;
    const cx = Math.floor((wram.samusX - wram.cameraX) / MOLTEN_CELL);
    const cy = Math.floor((wram.samusY + 6 - wram.cameraY) / MOLTEN_CELL);
    let touched = 0;
    for (let dc = -1; dc <= 1; dc++) {
      const cc = cx + dc;
      if (cc < 0 || cc >= MOLTEN_COLS || cy < 0 || cy >= MOLTEN_ROWS) continue;
      const cellKey = `${wram.roomId}:${cy}:${cc}`;
      if (lake.mask[cy * MOLTEN_COLS + cc] !== 1) continue;
      if (this.lavaProvenSafe.has(cellKey)) continue;
      if (hurt) {
        // doeu exatamente onde o detector marcou: o detector estava CERTO. Zero a testemunha e
        // deixo o veto (e a penalidade, que quem calibra é o selfCorrection).
        this.lavaWitness.delete(cellKey);
        this.lavaProvenSafe.delete(cellKey);
        continue;
      }
      const n = (this.lavaWitness.get(cellKey) ?? 0) + 1;
      this.lavaWitness.set(cellKey, n);
      if (n >= 10) {
        this.lavaProvenSafe.add(cellKey);
        this.lavaWitness.delete(cellKey);
      }
      touched++;
    }
    // Prova de TRAVESSIA: 10 ticks na MESMA célula de 8 px só acontecem se ela parar em cima do
    // "lago" — ou seja, o desmentido dependia da IA estar travada (era o bug, não a cura). Quem
    // anda 5 px por tick cruza a célula em 2 ticks e nunca prova nada. Então acumula também o
    // tempo percorrido dentro da região marcada sem dano: 14 ticks assim = "pisei e não doeu" →
    // todas as células sob observação viram "firme" de uma vez, e o limiar de 4 derruba o lago.
    if (touched > 0) {
      this.lavaCrossTicks++;
      if (this.lavaCrossTicks >= 14 && this.lavaWitness.size > 0) {
        for (const k of this.lavaWitness.keys()) this.lavaProvenSafe.add(k);
        this.lavaWitness.clear();
        this.lavaCrossTicks = 0;
      }
    } else {
      this.lavaCrossTicks = 0;
    }
  }

  /** Tira do lago o que já foi provado firme; se sobrar pouco, não é lago nenhum. */
  private pruneProvenSafeCells(wram: MetroidWramSnapshot, lake: MoltenLake): MoltenLake | null {
    if (this.lavaProvenSafe.size === 0) return lake;
    // Quatro células firmes do mesmo tom numa sala já respondem a pergunta inteira: o vermelho
    // dali é cenário. Sem este limiar a testemunha só esvaziaria o chão ATRÁS dela e a IA
    // seguiria travada na próxima célula marcada — o que é exatamente a sala do print.
    const prefix = `${wram.roomId}:`;
    let proven = 0;
    for (const k of this.lavaProvenSafe) if (k.startsWith(prefix)) proven++;
    if (proven >= 4) {
      this.recordFalsePositive(wram, lake, proven);
      return null;
    }
    let kept = 0;
    const mask = new Uint8Array(lake.mask.length);
    for (let r = 0; r < MOLTEN_ROWS; r++) {
      for (let c = 0; c < MOLTEN_COLS; c++) {
        const on = lake.mask[r * MOLTEN_COLS + c] === 1 && !this.lavaProvenSafe.has(`${wram.roomId}:${r}:${c}`);
        mask[r * MOLTEN_COLS + c] = on ? 1 : 0;
        if (on) kept++;
      }
    }
    if (kept >= Math.max(6, Math.floor(lake.cells * 0.55))) return { ...lake, mask, cells: kept };
    this.recordFalsePositive(wram, lake, lake.cells - kept);
    return null;
  }

  /** O "lago" era o cenário: erro MEU, registrado no caderno com a correção que o resolve. */
  private recordFalsePositive(wram: MetroidWramSnapshot, lake: MoltenLake, provenCells: number): void {
    if (!this.faultCooldownOk('HAZARD_FALSE_POSITIVE', `sala ${wram.roomId}`, this.stepIndex)) return;
    this.applyCorrection(
      this.selfFix.observe({
        kind: 'HAZARD_FALSE_POSITIVE',
        tick: this.stepIndex,
        roomId: wram.roomId,
        attempts: provenCells,
      }),
    );
  }

  /** Versão barata de "dá para ficar de pé aqui" para o guard de lava. */
  private isCellStandableProbe(wram: MetroidWramSnapshot, bx: number, by: number): boolean {
    const t = this.resolveBlockType(wram, bx, by);
    if (t === 0x8 || t === 0xe) return false;
    const below = this.resolveBlockType(wram, bx, by + 1);
    return below === 0x8 || below === 0xa || below === 0x1 || below === 0xb || below === 0xe || below === 0xf;
  }

  /** Célula hostil (espinho) acima de uma posição? */
  private isHazardAt(wram: MetroidWramSnapshot, bx: number, by: number): boolean {
    return this.resolveBlockType(wram, bx, by) === 0xa;
  }

  /**
   * No X-Fusion espinho não é "arranhão": o próprio zerado 100% descreve "dano desgraçado,
   * não tome dano de espinho não". Com o perfil ligado, pousos em espinho custam o dobro no
   * pathfinding — a rota alternativa quase sempre existe e o planificador passa a preferi-la.
   */
  private get spikeDangerMul(): number {
    return this.completionProfile === 'xfusion' ? 2 : 1;
  }

  /**
   * Custo de pousar/encostar em perigo: o fator do perfil MAIS o que a autocorreção somou
   * depois de apanhar num lugar que eu jurava seguro. É assim que um erro vira comportamento
   * sem esperar por um humano: no tick seguinte o pathfinding já foge daquela classe de célula.
   */
  private get hazardPenalty(): number {
    return 4 * this.spikeDangerMul + this.selfFix.hazardPenAdd;
  }

  /** Uma falha por tipo/escopo a cada ~10 s, senão o ledger vira ruído. */
  private faultCooldownOk(kind: FaultKind, scope: string, tick: number): boolean {
    const key = `${kind}:${scope}`;
    const last = this.lastFaultTick.get(key) ?? -9999;
    if (tick - last < 600) return false;
    this.lastFaultTick.set(key, tick);
    return true;
  }

  /** A escolta está no comando? Enquanto for, mob no caminho não é combate: é atraso. */
  private get escortActive(): boolean {
    return this.stepIndex < this.escortIgnoreMobsUntil;
  }

  /** Única ponte entre o diagnóstico e o controle: aplica no agente o que o ledger decidiu. */
  private applyCorrection(eff: CorrectionEffect | null | undefined): void {
    if (!eff) return;
    if (eff.unbreakable) this.unbreakableGates.add(eff.unbreakable);
    if (eff.dangerCells) for (const c of eff.dangerCells) this.dangerCells.add(c);
    if (eff.doorOverride) this.navDoorColors.set(eff.doorOverride.doorKey, eff.doorOverride.color);
    if (typeof eff.vetoRoomOff === 'number') {
      // o veto sai da sala inteira e as testemunhas são zeradas (o detector pode voltar a valer
      // se um dia o chão ali MACHUCAR de verdade — a prova positiva tem precedência)
      this.lavaVetoOff.add(eff.vetoRoomOff);
      for (const k of [...this.lavaWitness.keys()]) if (k.startsWith(`${eff.vetoRoomOff}:`)) this.lavaWitness.delete(k);
    }
    if (eff.rescanNow) {
      // a calibração nova só vale se o frame for relido AGORA: esperar o throttle de
      // amostragem custaria mais um passo dentro da lava
      this.lavaLakeRoomId = -1;
      this.lavaLakeTick = -99;
    }
  }

  /**
   * Fecha o ciclo no tick do dano. Quem rotula o pixel é o WRAM ("aqui doeu" / "aqui era
   * plataforma"), não uma constante: o frame é amostrado nas células do pé e nas laterais,
   * e SE (e somente se) as duas classes separarem, o detector de lava adota o corte medido.
   * Sem separação, o ledger cai no recuo conservador (marcar a célula) — errado seria
   * chutar um threshold a partir de ruído e passar a ver lava em tudo.
   */
  private selfCorrectFromDamage(wram: MetroidWramSnapshot, hpLost: number): void {
    const frame = this.lastCapturedFrame;
    const rgba = frame?.rgba as unknown as Uint8ClampedArray | undefined;
    if (!rgba || !frame || frame.width < 64) return;
    // combate não é erro de mapa: inimigo colado explica o dano melhor do que "meu detector errou"
    for (const e of wram.enemies) {
      if (Math.abs(e.x - wram.samusX) < 40 && Math.abs(e.y - wram.samusY) < 40) return;
    }
    const bx = Math.floor(wram.samusX / 16);
    const by = Math.floor((wram.samusY + 6) / 16);
    const cell = (wx: number, wy: number) => ({
      r: Math.floor((wy - wram.cameraY) / MOLTEN_CELL),
      c: Math.floor((wx - wram.cameraX) / MOLTEN_CELL),
    });

    // Eu VIA o perigo e pisei mesmo assim: o que está errado é o CUSTO, não a cor — o fix é
    // a penalidade do pathfinding, que sobe em degraus limitados pelo ledger.
    if (this.lavaLake) {
      if (this.faultCooldownOk('HAZARD_BLIND', `sala ${wram.roomId}`, this.stepIndex)) {
        this.applyCorrection(
          this.selfFix.observe({
            kind: 'HAZARD_BLIND',
            tick: this.stepIndex,
            roomId: wram.roomId,
            bx,
            by,
            hpLost,
          }),
        );
      }
      return;
    }

    // Nada marcado na sala = hipótese de paleta desconhecida (foi exatamente o caso do print).
    // Amostro o que doeu e o que estava ao lado, e quem responde é o frame — se as classes
    // não separarem, o ledger recusa a tese e marca a célula (recuo, não chute).
    if (!this.faultCooldownOk('LAVA_UNSIGHTED', 'sessão', this.stepIndex)) return;
    const grounded = this.isSamusGrounded(wram);
    // A janela da amostra é a região do dano: o tile em que estou e os dois abaixo/ao lado.
    // O que doeu não é "a célula exata" (o hitbox do perigo sobrepõe o meu corpo), então
    // rankweamos os candidatos por brilho e ficamos com os 3 QUENTES da janela — é o corpo da
    // lava que sobra quando o sprite da Samus é removido da conta.
    const feetY = grounded ? wram.samusY + 10 : wram.samusY + 14;
    const colC = Math.floor((wram.samusX - wram.cameraX) / MOLTEN_CELL);
    const rowC = Math.floor((feetY - wram.cameraY) / MOLTEN_CELL);
    const candidates: Array<{ r: number; c: number; mean: [number, number, number] }> = [];
    const mine = (cr: number, cc: number): boolean => {
      // células cobertas pelo sprite (x±7, y-15..y+3): meu próprio vermelho não pode virar prova
      const x0 = wram.samusX - wram.cameraX - 7;
      const x1 = wram.samusX - wram.cameraX + 7;
      const y0 = wram.samusY - wram.cameraY - 15;
      const y1 = wram.samusY - wram.cameraY + 3;
      return cc * MOLTEN_CELL < x1 && (cc + 1) * MOLTEN_CELL > x0 && cr * MOLTEN_CELL < y1 && (cr + 1) * MOLTEN_CELL > y0;
    };
    for (let dr = -1; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = rowC + dr;
        const cc = colC + dc;
        if (rr < 0 || cc < 0 || rr >= MOLTEN_ROWS || cc >= MOLTEN_COLS) continue;
        if (mine(rr, cc)) continue;
        const mean = moltenCellMean(rgba, frame.width, frame.height, rr, cc);
        if (mean) candidates.push({ r: rr, c: cc, mean });
      }
    }
    if (candidates.length < 4) return;
    const hurt = candidates
      .slice()
      .sort((a, b) => b.mean[0] - a.mean[0])
      .slice(0, 3)
      .map((c) => ({ r: c.r, c: c.c }));
    // classe negativa: o chão firme do mesmo nível, uns 40px para cada lado (de onde viemos)
    const safe = [
      cell(wram.samusX + 40, feetY),
      cell(wram.samusX - 40, feetY),
      cell(wram.samusX - 40, wram.samusY + 2),
      cell(this.prevSamusX, this.prevSamusY + 10),
    ].filter(
      (c) =>
        c.r >= 0 &&
        c.c >= 0 &&
        c.r < MOLTEN_ROWS &&
        c.c < MOLTEN_COLS &&
        // o chão "firme" também não pode estar contaminado pelo meu próprio sprite: senão a
        // classe negativa herda o vermelho da Samus e o corte sai mais folgado do que precisa
        !mine(c.r, c.c) &&
        !hurt.some((h) => h.r === c.r && h.c === c.c),
    );
    if (safe.length === 0) return;
    const report = deriveMoltenCalib(rgba, frame.width, frame.height, { hurt, safe });
    this.applyCorrection(
      this.selfFix.observe({
        kind: 'LAVA_UNSIGHTED',
        tick: this.stepIndex,
        roomId: wram.roomId,
        bx,
        by,
        hpLost,
        calib: report?.calib ?? null,
        hurtHex: report?.hurtHex,
        safeHex: report?.safeHex,
        gap: report?.gap,
      }),
    );
  }

  /** Estado serializável do caderno de autocorreções (para persistir junto do progresso). */
  exportSelfCorrections(): ReturnType<SelfCorrectionLedger['serialize']> {
    return this.selfFix.serialize();
  }

  /**
   * Devolve as correções de uma sessão anterior. A calibração de lava que já foi provada é
   * a coisa mais valiosa que existe: reler o print do usuário de novo seria o mesmo erro
   * de sempre — aprender uma vez e esquecer.
   */
  importSelfCorrections(rows: unknown): void {
    if (!Array.isArray(rows) || rows.length === 0) return;
    this.selfFix.restore(rows);
    if (this.selfFix.needsRescan) {
      this.selfFix.clearRescanFlag();
      this.lavaLakeRoomId = -1;
      this.lavaLakeTick = -99;
    }
  }

  /** Esta célula da sala é lava? (amostra o centro e as bordas da célula de 16px) */
  private isLavaCell(wram: MetroidWramSnapshot, bx: number, by: number): boolean {
    // durante a sonda a célula marcada vira chão normal para o pathfinding (o detector continua
    // lendo o frame, então a prova negativa pode ser coletada em cima dela)
    if (this.stepIndex < this.lavaProbeUntil) return false;
    const lake = this.lavaLake;
    if (!lake) return false;
    if (bx < 0 || by < 0 || bx >= wram.roomWidthBlocks || by >= wram.roomHeightBlocks) return false;
    const camBx = wram.cameraX;
    const camBy = wram.cameraY;
    for (const ox of [8, 0, 15]) {
      for (const oy of [8, 0, 15]) {
        const sx = bx * 16 + ox - camBx;
        const sy = by * 16 + oy - camBy;
        if (sx < 0 || sy < 0) continue;
        const cc = Math.floor(sx / MOLTEN_CELL);
        const cr = Math.floor(sy / MOLTEN_CELL);
        if (cc < 0 || cc >= MOLTEN_COLS || cr < 0 || cr >= lake.mask.length / MOLTEN_COLS) continue;
        if (lake.mask[cr * MOLTEN_COLS + cc] === 1) return true;
      }
    }
    return false;
  }

  /** Registros por sala que o grafo do agente não guarda (itens, painéis, perigo, chefe). */
  private navRoomExtra(roomId: number, areaIndex: number) {
    let rec = this.navExtras.get(roomId);
    if (!rec) {
      rec = { itemsPending: 0, itemsSeen: 0, terminalsPending: 0, seen: false, danger: 0, areaIndex };
      this.navExtras.set(roomId, rec);
    }
    return rec;
  }

  private navLoadoutView(wram: MetroidWramSnapshot) {
    const lo = this.getAgentLoadout(wram);
    return {
      hasMissileLauncher: lo.hasMissiles,
      hasSuperMissiles: lo.hasSupers,
      hasPowerBombs: lo.hasPowerBombs,
      hasBombs: lo.hasBombs,
      hasMorphBall: lo.hasMorphBall,
      missiles: lo.missileCount,
      supers: lo.superCount,
      powerBombs: lo.powerBombCount,
    };
  }

  /** Monta o grafo nav a partir das estruturas que o agente já mantém (sem duplicar estado). */
  private buildNavGraph(wram: MetroidWramSnapshot): NavGraph {
    const rooms = new Map<number, NavRoom>();
    const ensure = (id: number): NavRoom => {
      let r = rooms.get(id);
      if (!r) {
        const extra = this.navExtras.get(id);
        const node = this.roomGraph.get(id);
        const doors: NavDoor[] = [];
        if (node) {
          for (const [key, rec] of node.doors) {
            const color = this.navDoorColors.get(`${id}:${key}`) ?? 'UNKNOWN';
            const linked = rec.targetRoomId ?? node.doorLinks.get(key) ?? node.exits[key as 'LEFT' | 'RIGHT'];
            doors.push({
              key,
              color,
              blockedByWall: rec.locked,
              targetRoomId: linked,
              unknownColor: color === 'UNKNOWN',
            });
          }
          // portas descobertas só pelos exits (LEFT/RIGHT)
          for (const dir of ['LEFT', 'RIGHT'] as const) {
            const via = node.exits[dir];
            if (via === undefined) continue;
            if (!doors.some((d) => d.key === dir)) doors.push({ key: dir, color: 'PINK', blockedByWall: false, targetRoomId: via });
          }
        }
        r = {
          id,
          areaIndex: extra?.areaIndex ?? 0,
          visited: this.roomsExplored.has(id),
          itemsPending: extra?.itemsPending ?? 0,
          bossName: extra?.bossName,
          bossDefeated: this.bossRoomBindings.has(id),
          terminalsPending: extra?.terminalsPending ?? 0,
          doors,
          danger: extra?.danger ?? 0,
        };
        rooms.set(id, r);
      }
      return r;
    };
    ensure(wram.roomId);
    for (const id of this.roomGraph.keys()) ensure(id);
    for (const t of this.pendingTargets) ensure(t.roomId);
    return { current: wram.roomId, rooms };
  }

  /**
   * Percepção de navegação: cores de porta amostradas do frame, itens/painéis pendentes,
   * trilha de salas, medidor de "perdido" e o plano do próximo alvo.
   */
  private navPerceive(wram: MetroidWramSnapshot, bossEngaged: boolean): void {
    if (wram.gameState !== 8 || wram.roomId <= 0) return;
    const extra = this.navRoomExtra(wram.roomId, wram.areaIndex);
    const firstSight = !extra.seen;
    if (this.navStartRoomId < 0) this.navStartRoomId = wram.roomId;
    if (firstSight) {
      extra.seen = true;
      this.lastNewRoomTick = this.stepIndex;
      this.lastNavProgressTick = this.stepIndex;
    }
    if (this.roomTrail[this.roomTrail.length - 1] !== wram.roomId) {
      this.roomTrail.push(wram.roomId);
      if (this.roomTrail.length > 40) this.roomTrail.shift();
    }

    // (a) cor do batente de cada porta da sala, direto do frame
    const frame = this.lastCapturedFrame;
    const rgba = frame?.rgba as unknown as Uint8ClampedArray | undefined;
    if (rgba && frame && frame.width > 0 && wram.doors.length > 0) {
      const sampleRadius = this.selfFix.doorSampleRadius;
      for (const d of wram.doors) {
        const key = `${wram.roomId}:${d.key}`;
        const override = this.selfFix.doorOverrideFor(key);
        if (override) {
          this.navDoorColors.set(key, override); // a correção manda mais que a amostra
          continue;
        }
        if (!d.blockedByWall) this.doorShotTally.delete(key); // abriu: contagem zera
        if (this.navDoorColors.get(key) === 'PINK' || this.navDoorColors.get(key) === 'CORRODED') continue; // já resolvidas
        const sx = d.x - wram.cameraX;
        const sy = d.y - wram.cameraY;
        if (sx < 6 || sy < 6 || sx > frame.width - 6 || sy > frame.height - 6) continue;
        const c = classifyDoorColor(rgba, frame.width, frame.height, sx, sy, sampleRadius);
        if (c) {
          this.navDoorColors.set(key, c);
          // VERDADE DE CAMPO: o WRAM sabe se a porta está aberta. Amostra dizendo "fechada"
          // (vermelha/verde/amarela/azul) com o batente livre = EU li errado o pixel, e a
          // correção é dupla: a cor guardada e o raio da amostra (menos pulga/lava dentro).
          if (!d.blockedByWall && c !== 'PINK' && c !== 'CORRODED') {
            if (this.faultCooldownOk('DOOR_COLOR_WRONG', `sala ${wram.roomId}`, this.stepIndex)) {
              this.applyCorrection(
                this.selfFix.observe({
                  kind: 'DOOR_COLOR_WRONG',
                  tick: this.stepIndex,
                  roomId: wram.roomId,
                  bx: d.bx,
                  by: d.by,
                  doorKey: key,
                  colorSampled: c,
                  doorOpen: true,
                }),
              );
            }
          }
        }
      }
    }

    // (a2) lava no chão: o que decide "não andar para frente" e "subir em vez de atravessar"
    this.senseLavaFloor(wram);
    // e a testemunha roda TODO tick (não no throttle do frame): é o contraditório do detector —
    // célula marcada como lava em que ela está em cima sem tomar dano
    if (this.lavaLake) this.noteLavaWitness(wram, this.lavaLake);
    // (a3) presa pelo veto sem progresso = hora de testar o chão, não de esperar mais
    if (
      this.lavaLake &&
      !this.lavaSafe &&
      this.stepIndex - this.lastNavProgressTick > 90 &&
      this.stepIndex >= this.lavaProbeUntil &&
      this.stepIndex >= this.lavaProbeLockUntil &&
      this.lavaProbeFails < 2
    ) {
      this.lavaProbeUntil = this.stepIndex + 150;
    }

    // (b) itens: conta atual vale até sair da sala; o máximo já visto evita "sumir item" falso
    const itemsNow = wram.roomItems.length;
    extra.itemsSeen = Math.max(extra.itemsSeen, itemsNow);
    extra.itemsPending = itemsNow;

    // (c) painéis/terminais não acionados nesta sala
    const panels = this.interactiveObjects.filter(
      (o) => !o.interacted && (o.type === 'POWER_PANEL' || o.type === 'ENERGY_AUX' || o.type === 'TERMINAL'),
    ).length;
    extra.terminalsPending = panels;

    // (d) perigo: dano pesado sofrido aqui (o agente já mantém dangerCells por sala)
    if (this.samusDamagedThisTick) extra.danger = Math.min(4, extra.danger + 1);

    // (e) chefe da sala (nome vem do codex quando ele reconheceu o alvo)
    if (bossEngaged && !extra.bossName) {
      extra.bossName = this.bossDirective?.bossName ?? 'não catalogado';
    }

    // (f) progresso = coletou item, ganhou habilidade/capacidade, acionou painel, feriu chefe.
    // Os prev* ainda são os do tick anterior (são atualizados depois, em syncRoomAndProgress),
    // então a comparação é exatamente "mudou desde o último tick".
    const gained =
      wram.itemsMask !== this.prevItemsMask
      || wram.beamsMask !== this.prevBeamsMask
      || wram.maxHealth !== this.prevMaxHealth
      || wram.maxMissiles !== this.prevMaxMissiles
      || wram.maxSupers !== this.prevMaxSupers
      || wram.maxPowerBombs !== this.prevMaxPbs;
    const collected = this.navPrevItemCount > itemsNow;
    const fought = (this.bossDirective?.damageDealt ?? 0) > 0;
    if (gained || collected || fought || this.lastInteractionTick > this.lastNavProgressTick) {
      this.lastNavProgressTick = this.stepIndex;
      // aconteceu coisa nova: uma próxima leitura de mapa volta a valer a pena
      if (this.roomsExplored.size !== this.mapReadRoomCount) this.mapReadBackoff = 120;
    }
    this.navPrevItemCount = itemsNow;

    // (g) linha de base da sessão (para o checklist contar o que a IA coletou)
    if (this.baseMaxHealth === 0) {
      this.baseMaxHealth = wram.maxHealth;
      this.baseMaxMissiles = wram.maxMissiles;
      this.baseMaxSupers = wram.maxSupers;
      this.baseMaxBombs = wram.maxPowerBombs;
    }

    // (h) estou perdido?
    this.navLost = detectLost({
      ticksSinceNewRoom: this.stepIndex - this.lastNewRoomTick,
      ticksSinceProgress: this.stepIndex - this.lastNavProgressTick,
      roomTrail: this.roomTrail,
      positionStallTicks: this.progressStallTicks,
      bossEngaged,
      inCombat: this.currentMode === 'COMBAT',
      busy: this.mapConsultPhase !== 'IDLE',
    });

    // (h2) autocorreção do roteiro: os vereditos de "perdido" têm causa, e a causa diz o
    // que mudar — círculo pede reancoragem, parede pede desistir do ponto
    if (this.navLost?.lost && this.navLost.cause) {
      const cause = this.navLost.cause;
      const kind: FaultKind | null =
        cause === 'OSCILLATION' || cause === 'REENTERED_DOOR'
          ? 'OSCILLATION'
          : cause === 'STALL' || cause === 'NO_PROGRESS'
            ? 'POSITION_STALL'
            : null;
      if (kind && this.faultCooldownOk(kind, `sala ${wram.roomId}`, this.stepIndex)) {
        this.applyCorrection(
          this.selfFix.observe({
            kind,
            tick: this.stepIndex,
            roomId: wram.roomId,
            bx: Math.floor(wram.samusX / 16),
            by: Math.floor(wram.samusY / 16),
          }),
        );
      }
    }
    this.applyCorrection(this.selfFix.review(this.stepIndex, true));

    // (i) checklist
    this.navChecklist = buildChecklist(
      this.navProgressInput(wram),
      this.completionProfile === 'xfusion' ? XFUSION_TOTALS : COMPLETION_TOTALS,
    );

    // (j) replaneja quando muda de sala, quando algo muda no estado ou a cada ~40 ticks
    if (this.stepIndex - this.navPlanTick > 40 || firstSight || this.navTarget === null) {
      this.refreshLockedDoors(wram);
      this.replan(wram);
    }
  }

  private navProgressInput(wram: MetroidWramSnapshot) {
    const lo = this.getAgentLoadout(wram);
    let unvisited = 0;
    const seenTargets = new Set<number>();
    for (const node of this.roomGraph.values()) {
      for (const [, link] of node.doorLinks) {
        if (!this.roomsExplored.has(link) && !seenTargets.has(link)) {
          seenTargets.add(link);
          unvisited += 1;
        }
      }
    }
    let terminalsDone = 0;
    let terminalsKnown = 0;
    for (const o of this.interactiveObjects) {
      if (o.type === 'POWER_PANEL' || o.type === 'ENERGY_AUX' || o.type === 'TERMINAL') {
        terminalsKnown += 1;
        if (o.interacted) terminalsDone += 1;
      }
    }
    let bossesKnown = 0;
    for (const rec of this.navExtras.values()) if (rec.bossName) bossesKnown += 1;
    return {
      maxHealth: wram.maxHealth,
      maxReserve: wram.reserveMax,
      maxMissiles: wram.maxMissiles,
      maxSupers: wram.maxSupers,
      maxPowerBombs: wram.maxPowerBombs,
      abilities: {
        MORPH_BALL: lo.hasMorphBall,
        BOMBS: lo.hasBombs,
        HI_JUMP: lo.hasHiJump,
        SPACE_JUMP: lo.hasSpaceJump,
        SPRING_BALL: lo.hasSpringBall,
        VARIA: lo.hasVaria,
        GRAVITY: lo.hasGravity,
        SCREW: lo.hasScrewAttack,
        GRAPPLE: lo.hasGrapple,
        XRAY: lo.hasXRay,
        CHARGE: lo.hasChargeBeam,
        ICE: lo.hasIceBeam,
        WAVE: lo.hasWaveBeam,
        SPAZER: lo.hasSpazer,
      },
      bossesDefeated: this.bossRoomBindings.size,
      bossesKnown: Math.max(bossesKnown, this.bossRoomBindings.size),
      terminalsDone,
      terminalsKnown,
      roomsUnvisited: unvisited,
    };
  }

  /**
   * "Volta quando tiver o item": o grafo não pode guardar um "não" para sempre. Uma porta
   * marcada como trancada volta a ser candidata quando a cor dela diz que é só uma comporta
   * fechada (vermelha/verde/amarela/azul) e nós temos a munição agora.
   */
  private refreshLockedDoors(wram: MetroidWramSnapshot): void {
    const loadout = this.navLoadoutView(wram);
    for (const [roomId, node] of this.roomGraph) {
      for (const [key, rec] of node.doors) {
        if (!rec.locked) continue;
        const color = this.navDoorColors.get(`${roomId}:${key}`) ?? 'UNKNOWN';
        if (color === 'UNKNOWN' || color === 'PINK' || color === 'CORRODED') continue;
        const chk = checkGate(gateForDoor(color, false), loadout);
        if (chk.openableNow) {
          rec.locked = false;
          rec.missileProbes = 0;
        }
      }
    }
  }

  private replan(wram: MetroidWramSnapshot): void {
    this.navPlanTick = this.stepIndex;
    const graph = this.buildNavGraph(wram);
    const plan = planNextTarget({
      graph,
      loadout: this.navLoadoutView(wram),
      hint: this.stepIndex - this.mapHintTick > 900 ? null : this.mapHint,
      bossRooms: new Map<number, { name: string; defeated: boolean }>(
        [...this.bossRoomBindings.entries()].map(([roomId, strategyId]) => [roomId, { name: strategyId, defeated: true }]),
      ),
      everythingDone: missionComplete(this.navChecklist),
      backlogKeys: new Set(this.navBacklog.map((b) => `${b.roomId}`)),
      startRoomId: this.navStartRoomId,
    });
    this.navTarget = this.applyBounceBan(plan.target, wram);
    // mescla: mantém entradas antigas que o plano de agora não conseguiu reavaliar
    const fresh = plan.backlog;
    const keep = this.navBacklog.filter(
      (old) => !fresh.some((f) => f.roomId === old.roomId && f.doorKey === old.doorKey)
        && !this.roomGraph.get(old.roomId)?.doors.get(old.doorKey)?.targetRoomId,
    );
    this.navBacklog = [...fresh, ...keep].slice(0, 12);
  }

  /** Registra A→B→A e, no segundo round trip pela mesma porta, proíbe a aresta como alvo. */
  private registerRoomBounce(prevRoomId: number, curRoomId: number): void {
    if (prevRoomId <= 0 || curRoomId <= 0 || prevRoomId === curRoomId) return;
    const chain = this.roomChain;
    const cameBackTo = chain.length > 0 && chain[chain.length - 1] === curRoomId;
    if (cameBackTo) {
      // chave NORMALIZADA pelo par: num vaivém A↔B os dois sentidos aparecem alternados, e contar
      // por orientação ("A->B", "B->A") divide o mesmo sintoma ao meio — ele nunca chega ao
      // limiar. É o par que importa, não o sentido.
      const key = prevRoomId < curRoomId ? `${prevRoomId}|${curRoomId}` : `${curRoomId}|${prevRoomId}`;
      const st = this.bounceTally.get(key);
      const n = st && this.stepIndex - st.tick < 1200 ? st.n + 1 : 1;
      this.bounceTally.set(key, { n, tick: this.stepIndex });
      // 2 round trips seguidos (4 travessias) sem nada coletado no meio já é o padrão do
      // playtest; 1 volta é jogo normal (entrou, viu que não tinha nada, saiu).
      if (n >= 2) {
        // 30 s de jogo sem essa aresta como destino, e uma leitura de mapa arma a fronteira
        // alternativa: sem um alvo novo, proibir só adia o mesmo erro
        this.bounceBan.set(`${curRoomId}->${prevRoomId}`, this.stepIndex + 900);
        this.bounceBan.set(`${prevRoomId}->${curRoomId}`, this.stepIndex + 900);
        // e planta a memória de colisão no batente de volta: o caminho que já existe para isso é
        // `recentBlockedSpots` + `hitKnownBlocked`, que inverte a direção e anota no grafo.
        const backDoor = this.lastRoomDoorsSnapshot.find((d) => d.side === (this.moveDir === 'LEFT' ? 'LEFT' : 'RIGHT'));
        if (backDoor) {
          this.recentBlockedSpots.push({ x: backDoor.x, y: backDoor.y, dir: this.moveDir });
          if (this.recentBlockedSpots.length > 12) this.recentBlockedSpots.shift();
        }
        this.bounceTally.delete(key);
        if (this.loopDetected) this.loopDetected = false;
        // e descarta os alvos pendentes que apontam para a sala proibida: sem isso a fila
        // `pendingTargets` continua puxando ela de volta pelo mesmo batente no tick seguinte
        this.pendingTargets = this.pendingTargets.filter(
          (t) => !(this.bounceBanned(curRoomId, t.roomId) || this.bounceBanned(prevRoomId, t.roomId)),
        );
      }
    }
    chain.push(prevRoomId);
    if (chain.length > 4) chain.shift();
  }

  private bounceBanned(fromRoom: number, toRoom: number): boolean {
    const until = this.bounceBan.get(`${fromRoom}->${toRoom}`);
    return until !== undefined && this.stepIndex < until;
  }

  /**
   * Chuta o alvo que só manda ela de volta pela porta por onde acabou de entrar. Devolve `null`
   * → o plano cai na exploração de fronteira da sala atual (que é o comportamento "procure
   * outra saída" que faltava). Não mexe na aresta física: a porta continua aberta e o grafo
   * continua sabendo dela — só deixa de ser o DESTINO por um tempo.
   */
  private applyBounceBan(target: NavTarget | null, wram: MetroidWramSnapshot): NavTarget | null {
    if (!target) return null;
    if (target.roomId === wram.roomId) return target;
    if (this.bounceBanned(wram.roomId, target.roomId)) return null;
    const node = this.roomGraph.get(wram.roomId);
    const nextRoom = target.firstDoor ? node?.doorLinks.get(target.firstDoor) : undefined;
    if (nextRoom !== undefined && this.bounceBanned(wram.roomId, nextRoom)) return null;
    return target;
  }

  /** Item chegou: reabre as portas que estavam no backlog e devolve a sala para pendingTargets. */
  private reopenNavBacklog(wram: MetroidWramSnapshot): void {
    if (this.navBacklog.length === 0) return;
    const lo = this.getAgentLoadout(wram);
    const { keep, reopened } = reopenBacklog(this.navBacklog, {
      MISSILES: lo.hasMissiles,
      SUPERS: lo.hasSupers,
      POWER_BOMBS: lo.hasPowerBombs,
      BOMBS: lo.hasBombs,
      MORPH_BALL: lo.hasMorphBall,
    });
    if (reopened.length === 0) return;
    this.navBacklog = keep;
    for (const e of reopened) {
      const node = this.roomGraph.get(e.roomId);
      const targetRoom = node?.doorLinks.get(e.doorKey);
      const door = wram.doors.find((d) => d.key === e.doorKey);
      this.addPendingTarget({
        roomId: targetRoom ?? e.roomId,
        x: door?.x ?? wram.samusX,
        y: door?.y ?? wram.samusY,
        dir: directionForDoor(e.doorKey) === 'LEFT' ? 'LEFT' : 'RIGHT',
        note: `backlog reaberto · ${e.note}`,
      });
      if (targetRoom === undefined) {
        const rec = node?.doors.get(e.doorKey);
        if (rec) rec.locked = false; // a parede não é mais o problema: agora temos o item
      }
      this.lastNavProgressTick = this.stepIndex;
    }
    this.replan(wram);
  }

  /**
   * Consulta o mapa do jogo (START): abre, lê a tela, fecha. Orçamento curto e fixo — o
   * objetivo é referência espacial, não passar minutos parado. Enquanto o mapa está na
   * tela o jogo pausa, então isso só roda em sala limpa e fora de luta de chefe.
   */
  /**
   * Chamado quando um save-state é carregado. A regra pedida: o menu abre depois de
   * 3 minutos de sessão NOVA (o reset já zera o relógio no load do jogo) OU logo depois de
   * carregar um save — neste caso a permissão vem imediata e vale para a próxima janela boa.
   */
  noteSaveStateLoaded(): void {
    this.menuGrantedAfterSave = true;
    this.menuClockOriginTick = this.stepIndex;
    // A regra do usuário é "logo depois de carregar um save". Então o refratário de leitura
    // zera (ele é o limite de taxa da consulta periódica, não uma ordem de prioridade) e a
    // próxima janela livre é armada de fato — sem isso, uma leitura que a ESCADA DE ESCAPE já
    // tinha feito pouco antes do load deixava o mapa bloqueado por mais 120 ticks.
    this.mapReadBackoff = 0;
    this.forceMapReadTicks = 40;
  }

  /** O portão do menu: 3 minutos de sessão desde o load, ou permissão dada por um save. */
  private menuOpenAllowed(): boolean {
    if (this.menuGrantedAfterSave) return true;
    if (this.menuClockOriginTick < 0) return false;
    return this.stepIndex - this.menuClockOriginTick >= this.menuArmAfterTicks;
  }

  private mapConsultStep(
    wram: MetroidWramSnapshot,
    bossEngaged: boolean,
    motionPct: number,
  ): AIAction | null {
    const phase = this.mapConsultPhase;
    if (phase === 'IDLE') {
      if (this.menuClockOriginTick < 0 && wram.gameState === 8) this.menuClockOriginTick = this.stepIndex;
      // "assim que carregar o jogo / um Save": fora do campo de jogo por um tempo (título,
      // menu de arquivo, tela de LOADING do save) o relógio reancora quando Samus volta.
      if (wram.gameState !== 8) {
        this.offPlayfieldTicks++;
        if (this.offPlayfieldTicks > 600) {
          this.menuClockOriginTick = this.stepIndex;
          this.offPlayfieldTicks = 0;
        }
      } else {
        this.offPlayfieldTicks = 0;
      }
      if (!this.menuOpenAllowed()) return null;
      // Refratário: ler o mapa é caro (o jogo pausa). Severidade 3 significa "ler já", não
      // "reler a cada 2 ticks". E reler o mesmo mapa sem ter descoberto sala nenhuma desde a
      // última leitura é inútil — cada leitura estéril triplica a espera, até o ciclo periódico.
      const sinceRead = this.stepIndex - this.lastMapReadTick;
      // o degrau MAP_READ da escada de escape fura o refratário: "presa há 420 ticks sem
      // ganhar um pixel na horizontal" é exatamente o caso em que reler o mapa NÃO é inútil
      if (sinceRead < this.mapReadBackoff && this.forceMapReadTicks <= 0) return null;
      const periodic = sinceRead >= this.MAP_CONSULT_INTERVAL_TICKS;
      const lost =
        (this.navLost.lost && this.stepIndex - this.mapReadFailedTick > 240) || this.forceMapReadTicks > 0;
      if (!lost && !periodic) return null;
      if (wram.enemies.some((e) => e.hp > 0) || bossEngaged) return null;
      if (wram.gameState !== 8) return null;
      this.mapConsultPhase = 'OPEN';
      this.mapConsultTick = this.stepIndex;
      this.menuGrantedAfterSave = false;
      return this.makeMetroidAction(
        'MENU',
        ['START'],
        120,
        'menu',
        motionPct,
        'Mapa · abrindo (START)',
        `Consultando o mapa do jogo · ${this.navLost.note}`,
        wram,
      );
    }

    const elapsed = this.stepIndex - this.mapConsultTick;

    if (phase === 'OPEN') {
      // O mapa do SM pausa o jogo (gameState sai de 8) e/ou preenche menuScreen.
      const mapLikelyUp = wram.gameState !== 8 || wram.menuScreen !== 0;
      const reading = readMapScreen(
        (this.lastCapturedFrame?.rgba ?? new Uint8ClampedArray(0)) as unknown as Uint8ClampedArray,
        this.lastCapturedFrame?.width ?? 0,
        this.lastCapturedFrame?.height ?? 0,
      );
      if (reading.ok && (mapLikelyUp || reading.coveragePct > 0)) {
        this.adoptMapReading(reading);
        // antes de fechar: varrer as áreas vizinhas com PARA DIREITA / PARA ESQUERDA e
        // procurar a tela da HABILIDADE pendente (o pedido explícito do usuário)
        this.mapConsultPhase = 'PAN';
        this.mapConsultTick = this.stepIndex;
        this.mapPageScanStep = 0;
        this.replan(wram);
        // Só registra a leitura: o START de fechamento é dado UMA vez, na fase CLOSE.
        // Apertar aqui também deixava o mapa aberto de novo (duplo toggle).
        return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, 'Mapa · lido', reading.note, wram);
      }
      if (elapsed >= this.MAP_CONSULT_MAX_TICKS) {
        // não reconhecemos a tela: fecha e volta muito tempo depois, sem ficar insistindo
        this.mapReadFailedTick = this.stepIndex;
        this.mapConsultPhase = 'CLOSE';
        this.mapConsultTick = this.stepIndex;
        return this.makeMetroidAction(
          'MENU',
          ['START'],
          120,
          'menu',
          motionPct,
          'Mapa · leitura falhou',
          'Não confirmei a tela de mapa · fechando e voltando às heurísticas',
          wram,
        );
      }
      return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, 'Mapa · aguardando abrir', 'Esperando a tela do mapa aparecer', wram);
    }

    // PAN: com o mapa na tela, PARA DIREITA / PARA ESQUERDA trocam a área exibida. Varremos
    // os dois lados (um tick de tecla, um tick de releitura cada) e adotamos a leitura com o
    // melhor alvo — é assim que a meta de "habilidade na área ao lado" entra no plano.
    if (phase === 'PAN') {
      const mapStillUp = wram.gameState !== 8 || wram.menuScreen !== 0;
      if (!mapStillUp || this.mapPageScanStep >= 4) {
        this.mapConsultPhase = 'CLOSE';
        this.mapConsultTick = this.stepIndex;
        this.mapClosePresses = 0;
        this.replan(wram);
        return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, 'Mapa · varrido', 'Áreas vizinhas conferidas', wram);
      }
      const step = this.mapPageScanStep;
      const frame = this.lastCapturedFrame;
      const reread = () =>
        readMapScreen(
          (frame?.rgba ?? new Uint8ClampedArray(0)) as unknown as Uint8ClampedArray,
          frame?.width ?? 0,
          frame?.height ?? 0,
        );
      if (step === 0) {
        this.mapPageScanStep = 1;
        return this.makeMetroidAction('MENU', ['RIGHT'], 110, 'menu', motionPct, 'Mapa · área à direita', 'Procurando a habilidade na área vizinha (→)', wram);
      }
      if (step === 1) {
        this.mapPageScanStep = 2;
        const r = reread();
        const better = this.adoptMapReading(r);
        return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, better ? 'Mapa · alvo à direita' : 'Mapa · direita vazia', better ? 'Área da direita tem alvo melhor' : 'Nada melhor na área da direita', wram);
      }
      if (step === 2) {
        this.mapPageScanStep = 3;
        return this.makeMetroidAction('MENU', ['LEFT', 'LEFT'], 110, 'menu', motionPct, 'Mapa · área à esquerda', 'Procurando a habilidade na área vizinha (←←)', wram);
      }
      this.mapPageScanStep = 4;
      const r = reread();
      const better = this.adoptMapReading(r);
      return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, better ? 'Mapa · alvo à esquerda' : 'Mapa · esquerda vazia', better ? 'Área da esquerda tem alvo melhor' : 'Nada melhor na área da esquerda', wram);
    }

    // CLOSE: só apertar START enquanto o mapa ainda estiver na tela, e uma vez por tentativa.
    // As versões anteriores fechavam com um pressionamento garantido + um extra, o que
    // reabria o mapa (toggle duplo) e travava o agente em loop de abrir/fechar.
    if (phase === 'CLOSE') {
      const mapStillUp = wram.gameState !== 8 || wram.menuScreen !== 0;
      if (!mapStillUp) {
        this.mapConsultPhase = 'IDLE';
        this.lastMapReadTick = this.stepIndex;
        if (this.mapReadRoomCount >= 0 && this.roomsExplored.size === this.mapReadRoomCount) {
          // nenhuma sala nova desde a última leitura: reler o mesmo mapa não vai ajudar já
          this.mapReadBackoff = Math.min(this.MAP_CONSULT_INTERVAL_TICKS, this.mapReadBackoff * 3);
        } else {
          this.mapReadBackoff = 120;
        }
        this.mapReadRoomCount = this.roomsExplored.size;
        return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, 'Mapa · fechado', 'Mapa lido · retomando a exploração', wram);
      }
      if (elapsed < 2) {
        return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, 'Mapa · fechando', 'Fechando o mapa', wram);
      }
      if (this.mapClosePresses >= 3) {
        this.mapConsultPhase = 'IDLE';
        this.lastMapReadTick = this.stepIndex;
        this.mapReadFailedTick = this.stepIndex;
        return this.makeMetroidAction('MENU', [], 90, 'menu', motionPct, 'Mapa · fechado (forçado)', 'Mapa não fechou · voltando às heurísticas', wram);
      }
      this.mapClosePresses++;
      this.mapConsultTick = this.stepIndex;
      return this.makeMetroidAction('MENU', ['START'], 120, 'menu', motionPct, 'Mapa · fechando', 'Fechando o mapa para voltar a jogar', wram);
    }
    return null;
  }

  /** Registra uma leitura de mapa se ela apontar um alvo melhor que o atual. */
  private adoptMapReading(reading: MapReading): boolean {
    if (!reading.ok) return false;
    this.mapReading = reading;
    let better = false;
    if (reading.hint) {
      const cur = this.mapHint ? this.mapHint.score : -1;
      if (reading.hint.score > cur) {
        this.mapHint = { dir: reading.hint.dir, score: reading.hint.score };
        this.mapHintTick = this.stepIndex;
        better = true;
        // viés horizontal: metade da heurística de exploração trabalha só com LEFT/RIGHT
        if (reading.hint.dir === 'LEFT' || reading.hint.dir === 'RIGHT') {
          this.preferredDirection = reading.hint.dir;
        }
      }
    }
    if (reading.coveragePct >= 92) this.mapFullyExplored = true;
    return better;
  }

  /** A comporta desta sala abre com o que temos agora? (cor lida do frame + munição real) */
  private navDoorAffordable(wram: MetroidWramSnapshot, doorKey: string): boolean {
    const color = this.navDoorColors.get(`${wram.roomId}:${doorKey}`) ?? 'UNKNOWN';
    if (color === 'UNKNOWN') return true; // sem cor lida: deixa a heurística de sonda agir
    const gate = gateForDoor(color, false);
    return checkGate(gate, this.navLoadoutView(wram)).openableNow;
  }

  /** Aplica o plano de navegação às prioridades de porta dentro da sala. */
  private applyNavBiasToDoorTargets(
    wram: MetroidWramSnapshot,
    targets: Array<{ key: string; bx: number; by: number; priority: number }>,
  ): void {
    const target = this.navTarget;
    const loadout = this.navLoadoutView(wram);
    for (const t of targets) {
      const color = this.navDoorColors.get(`${wram.roomId}:${t.key}`) ?? 'UNKNOWN';
      const gate = gateForDoor(color, false);
      const chk = checkGate(gate, loadout);
      if (!chk.openableNow) t.priority = Math.max(t.priority, 6); // não abre agora: deixa de lado
      if (target && target.firstDoor === t.key) {
        t.priority = Math.min(t.priority, -2); // rota escolhida pelo plano: seguir
      } else if (this.mapHint) {
        const dir = directionForDoor(t.key);
        if (dir === this.mapHint.dir) t.priority = Math.min(t.priority, 0);
      }
      if (this.lavaTopRow >= 0 && directionForDoor(t.key) === 'UP') {
        t.priority = Math.min(t.priority, -1); // cercada por lava: a saída é vertical
      }
      if (target && target.roomId === wram.roomId && target.route.length === 0) {
        t.priority = Math.max(t.priority, 4); // já estamos no alvo: não sair correndo
      }
    }
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

    // MISSÃO PRINCIPAL: manter energia e reserva em 100% até a fase final.
    // Se não está em vida máxima e há estação de save, priorizar ir até ela
    // antes de prosseguir com itens, chefes ou exploração.
    if (wram.maxHealth > 0 && wram.health < wram.maxHealth && hasSaveStation) {
      this.currentObjective = {
        type: 'SAVE_STATION',
        x: wram.samusX,
        y: wram.samusY,
        priority: 9,
        reason: 'MISSÃO: restaurando energia para 100% na estação de save',
      };
      this.objectiveTick = this.stepIndex;
      return;
    }

    // MISSÃO PRINCIPAL: ativar energia auxiliar em TODAS as bases.
    // powerAuxActivated não pode ser toggle global — cada sala/base tem seu próprio terminal.
    // Se há terminal não interagido nesta sala, prioridade alta (acima de itens comuns).
    const energyAuxHere = this.interactiveObjects.some(
      (o) => (o.type === 'ENERGY_AUX' || o.type === 'POWER_PANEL') && !o.interacted && this.canInteractWithObject(wram, o),
    );
    if (energyAuxHere) {
      this.currentObjective = {
        type: 'ENERGY_AUX',
        x: wram.samusX,
        y: wram.samusY,
        priority: 8,
        reason: 'MISSÃO: ativando energia auxiliar nesta base',
      };
      this.objectiveTick = this.stepIndex;
      return;
    }

    // MISSÃO PRINCIPAL: coletar TODOS os itens e habilidades.
    // Prioriza tanques de energia e reserva (para chegar a 100%),
    // depois expansões de munição, depois habilidades de mobilidade.
    if (activeItem) {
      const loadout = this.getAgentLoadout(wram);
      const canReach = loadout.hasMorphBall || loadout.hasSpaceJump || loadout.hasHiJump;
      const isEnergyOrReserve = activeItem.y > 0; // placeholder, será refinado pelo tipo do item

      // Itens de energia/reserva têm prioridade máxima entre coleta
      const itemPriority = activeItem.dist < 60 ? 7 : (canReach ? 6 : 4);

      if (canReach || activeItem.dist < 60) {
        this.currentObjective = {
          type: 'ITEM',
          x: activeItem.x,
          y: activeItem.y,
          priority: itemPriority,
          reason: `MISSÃO: coletando item/habilidade (${Math.round(activeItem.dist)}px)`,
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
    return this.updateEscapeLadder(wram).engaged;
  }

  /**
   * Escada de escape (F1/F5 do relatório). A versão antiga:
   *   1. media `netMovement` das últimas 30 amostras e, com ela ~0, invertia a *preferência de
   *      rota* — que muitas vezes ERA a direção da parede onde ela já estava presa (o
   *      `dir=LEFT` repetido ~130 vezes contra a parede esquerda da sala 0x8b7d);
   *   2. ao fim da janela de 60 ticks zerava `stuckInRoomTicks` e as posições — apagando a
   *      única evidência que poderia ter disparado a leitura do mapa.
   * Aqui o degrau vem do `EscapeLadder` (impulso → inverte o EMPURRÃO medido → varre com tiro
   * → lê o mapa → bloqueia a sala no grafo) e **nenhum degrau limpa o contador**: só trocar de
   * sala reseta. Cada degrau tem orçamento curto para não virar ele o novo loop.
   */
  private updateEscapeLadder(wram: MetroidWramSnapshot): EscapePlan {
    this.lastRoomPositions.push({ x: wram.samusX, y: wram.samusY, tick: this.stepIndex });
    if (this.lastRoomPositions.length > 30) this.lastRoomPositions.shift();

    const inCombat = this.bossEngagedThisTick || wram.enemies.some((e) => e.hp > 0);
    const plan = this.guardian.ladder.next(
      this.stepIndex,
      this.guardian.sentinel.current,
      this.roomChangedThisTick,
      { inCombat, canReadMap: this.menuOpenAllowed() },
    );

    // os dois campos antigos continuam coerentes (UI e uSearch leem isso)
    this.loopDetected = plan.engaged;
    this.forcedEscapeDir = plan.dir;
    if (plan.engaged) {
      this.forcedEscapeTick = this.stepIndex;
      if (plan.rung === 'MAP_READ' && this.forceMapReadTicks <= 0) this.forceMapReadTicks = 4;
      if (plan.rung === 'BLOCK_ROOM') this.sealCurrentRoom(wram);
    }
    return plan;
  }

  /**
   * "não é por aqui" com memória: a célula vira hostil, os dois lados da sala constam como
   * gastos e o portão onde ela bate deixa de ser tratado como quebrável. É o que tira do
   * repertório o estado "presa aqui para sempre" — ela pode voltar mais tarde, agora com
   * motivo registrado e com as apostas da sala renovadas só quando algo novo acontecer.
   */
  private sealCurrentRoom(wram: MetroidWramSnapshot): void {
    const node = this.getOrCreateRoom(wram.roomId);
    node.triedLeft = true;
    node.triedRight = true;
    const bx = Math.floor(wram.samusX / 16);
    const by = Math.floor(wram.samusY / 16);
    this.dangerCells.add(`${wram.roomId}:${bx},${by}`);
    for (const spot of [...this.recentBlockedSpots].slice(-4)) {
      this.dangerCells.add(`${wram.roomId}:${Math.floor(spot.x / 16)},${Math.floor(spot.y / 16)}`);
    }
    for (const [id, sp] of node.secretPaths) {
      const h = this.guardian.hypotheses.open(targetKey(wram.roomId, 'XRAY', sp.x, sp.y), 'SECRET_BLOCK', wram.roomId, 3);
      h.budget = 0;
      h.status = 'DEAD';
      this.unbreakableGates.add(`${wram.roomId}:${id}`);
    }
    node.secretPaths.clear();
    this.stuckInRoomTicks = 90;
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
      maxMissiles: wram?.maxMissiles,
      supers: wram?.supers,
      maxSupers: wram?.maxSupers,
      powerBombs: wram?.powerBombs,
      maxPowerBombs: wram?.maxPowerBombs,
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
      // Estado da luta contra chefe conforme o Codex de Chefes
      bossFight:
        this.bossDirective && wram
          ? {
              strategyId: this.bossDirective.strategyId,
              bossName: this.bossDirective.bossName,
              encounter: this.bossDirective.encounter,
              phaseLabel: this.bossDirective.phaseLabel,
              weakPoint: this.bossDirective.weakPoint,
              ammo: this.bossDirective.ammo,
              ammoLabel: this.bossDirective.ammoLabel,
              role: this.bossDirective.role,
              movement: this.bossDirective.movement,
              aim: this.bossDirective.aim,
              windowOpen: this.bossDirective.windowOpen,
              windowLabel: this.bossDirective.windowLabel,
              mayFire: this.bossDirective.mayFire,
              distance: this.bossDirective.distance,
              rangeState: this.bossDirective.rangeState,
              hpPct: this.bossDirective.hpPct,
              damageDealt: this.bossDirective.damageDealt,
              hits: this.bossDirective.hits,
              rotated: this.bossDirective.rotated,
              rotationNote: this.bossDirective.rotationNote,
              probeMode: this.bossDirective.probeMode,
              collectWhenExposed: this.bossDirective.collectWhenExposed,
              doNotKill: this.bossDirective.doNotKill,
              letDrain: this.bossDirective.letDrain,
              note: this.bossDirective.note,
              source: this.bossDirective.source,
              summary: describeDirectiveForUi(this.bossDirective),
            }
          : undefined,
      // Sistema de loadout: mostra quais habilidades/armadura/ferramentas o agente tem
      agentLoadout: wram ? this.getAgentLoadout(wram) : undefined,
      // Camada de verificação: o que o agente aposta, quantas vezes já perdeu, e em que degrau
      // de escape está. Sem isto a tela mostrava "explorando" enquanto ela pulava no mesmo
      // tijolo havia 22 minutos — que foi o diagnóstico mais difícil do playtest.
      guardian: (() => {
        const g = this.guardian.snapshot();
        return {
          stallTicks: g.stallTicks,
          roomTicks: g.roomTicks,
          severity: g.severity,
          pushDir: g.pushDir,
          pinnedEdge: g.pinnedEdge,
          escapeRung: g.escape.rung,
          escapeStep: g.escape.step,
          deadHypotheses: g.deadCount,
          hypotheses: g.hypotheses,
          jump: g.jump,
          slot: g.slot,
          lockedTarget: g.lock.lockedSlot,
          inventoryTrusted: wram ? wram.inventoryTrusted : true,
          inventoryIssue: wram ? wram.inventoryIssue : null,
        };
      })(),
      // Sistema de exploração do mapa
      mapExploration: wram
        ? {
            roomsExplored: this.roomsExplored.size,
            mapFullyExplored: this.mapFullyExplored,
            lost: this.navLost.lost,
            lostCause: this.navLost.cause,
            lostNote: this.navLost.note,
            lostSeverity: this.navLost.severity,
            mapRead: this.mapReading
              ? {
                  ok: this.mapReading.ok,
                  coveragePct: this.mapReading.coveragePct,
                  hint: this.mapReading.hint?.label ?? null,
                  hintDir: this.mapReading.hint?.dir ?? null,
                  note: this.mapReading.note,
                  ageTicks: this.stepIndex - this.mapHintTick,
                }
              : null,
            target: this.navTarget
              ? {
                  kind: this.navTarget.kind,
                  label: this.navTarget.label,
                  reason: this.navTarget.reason,
                  route: this.navTarget.route,
                  firstDoor: this.navTarget.firstDoor,
                  roomId: this.navTarget.roomId,
                }
              : null,
            backlog: this.navBacklog.map((b) => ({
              roomId: b.roomId,
              doorKey: b.doorKey,
              need: b.need,
              missing: b.missing,
            })),
            checklist: this.navChecklist.map((c) => ({
              id: c.id,
              label: c.label,
              kind: c.kind,
              have: c.have,
              total: c.total,
              done: c.done,
              note: c.note,
            })),
            checklistSummary: describeChecklistForUi(this.navChecklist),
            navSummary: describeNavForUi(this.navTarget, this.navBacklog, this.mapReading),
            preferredDirection: this.preferredDirection,
            floorHazard: this.lavaLake ? (this.stepIndex < this.lavaProbeUntil ? 'LAVA_PROBE' : 'LAVA') : 'NONE',
            completionProfile: this.completionProfile,
            lavaTopRow: this.lavaTopRow,
            lavaCalib: { ...this.selfFix.lavaCalib },
            /** o que a IA diagnosticou e mudou em si mesma (mais recente por último) */
            corrections: this.selfFix.describeForUi(),
            currentRoomDoors: wram.doors.map((d) => ({
              key: d.key,
              color: this.navDoorColors.get(`${wram.roomId}:${d.key}`) ?? 'UNKNOWN',
              closed: d.blockedByWall,
            })),
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
    // O sentinela precisa saber o que estava sendo segurado (para inverter o EMPURRÃO, não a
    // preferência de rota) e o `time` vira a cadência efetiva do laço no player.
    this.lastActionKeys = keys;
    this.lastActionMs = time;
    this.guardian.slots.setOwnedAmmo(wram.maxMissiles > 0, wram.maxSupers > 0, wram.maxPowerBombs > 0);
    if (this.forceMapReadTicks > 0) this.forceMapReadTicks--;
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

      this.registerRoomBounce(prevRoomId, wram.roomId);
      {
        const nodeHere = this.getOrCreateRoom(wram.roomId);
        let backKey: string | null = null;
        for (const [k, target] of nodeHere.doorLinks) if (target === prevRoomId) backKey = k;
        const backDoor = backKey ? wram.doors.find((d) => d.key === backKey) : undefined;
        if (backDoor && (backDoor.side === 'LEFT' || backDoor.side === 'RIGHT')) {
          this.entryCalm = {
            roomId: wram.roomId,
            forbid: backDoor.side,
            until: this.stepIndex + 14,
            x: backDoor.x,
            y: backDoor.y,
          };
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
      this.forgiveStall();
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
    let damageDelta = 0;
    if (!energyOrStateReset && this.prevHealth > 0 && wram.health > 0) {
      const deltaHp = this.prevHealth - wram.health;
      if (deltaHp >= 6) {
        samusDamagedThisTick = true;
        damageDelta = deltaHp;
        // doeu DURANTE a sonda: era lava de verdade. Volta o veto e não insiste toda hora
        if (this.stepIndex < this.lavaProbeUntil) {
          this.lavaProbeFails++;
          this.lavaProbeUntil = -1;
          this.lavaProbeLockUntil = this.stepIndex + 900;
        }
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
    // Usado pelo codex para reconhecer "agarrada" (Draygon) e dano sofrido no tick.
    this.samusDamagedThisTick = samusDamagedThisTick;
    // autocorreção: o dano é o rótulo barato de "minha leitura do mundo estava errada"
    if (samusDamagedThisTick && !this.bossEngagedThisTick) {
      this.selfCorrectFromDamage(wram, damageDelta);
    }

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

    // ─── sentinela de estagnação (F4 do relatório) ──────────────────────────────────────
    // O critério antigo era `|Δx| < 20 && |Δy| < 28`: qualquer pulo no lugar passava de 28 px
    // em y, re-ancorava a posição e ZERAVA o travamento. Uma Samus presa no fundo de um poço
    // — pulando e caindo no mesmo tijolo por 22 minutos — tinha severidade 1 e o detector de
    // "perdida" não podia subir para 2, que é o limiar de consultar o mapa. Agora só conta
    // ganho horizontal ou pouso numa célula de apoio diferente, e o número mora no sentinela.
    const roomChangedNow = wram.roomId !== this.guardianRoomId;
    this.roomChangedThisTick = roomChangedNow;
    this.guardianRoomId = wram.roomId;
    const gv = this.guardian.sentinel.feed({
      tick: this.stepIndex,
      roomId: wram.roomId,
      x: wram.samusX,
      y: wram.samusY,
      keys: this.lastActionKeys,
      grounded: this.isSamusGrounded(wram),
      roomChanged: roomChangedNow,
      progressEvent: Boolean(unlockedLabel),
      // "em combate" = ESTOU brigando (chefe ou modo COMBAT/FLEE no tick anterior), não
      // "existe um inimigo com HP nesta sala" — esta última formulação é quase sempre vera no
      // *X-Fusion* e desligava o sentinela para sempre.
      inCombat: this.bossEngagedThisTick || this.currentMode === 'COMBAT' || this.currentMode === 'EVADE_SAX',
      roomWidthPx: wram.roomWidthPx,
    });
    this.anchorX = wram.samusX;
    this.anchorY = wram.samusY;
    this.progressStallTicks = this.uSearch.active ? this.progressStallTicks : gv.stallTicks;
    if (gv.stallTicks === 0 && Math.abs(gv.lastNetDx) >= 40) {
      this.missileProbeCount = 0;
    }
    if (this.roomMovedOnce && !this.uSearch.active && gv.stallTicks > 0) {
      this.stuckInRoomTicks = Math.max(this.stuckInRoomTicks, gv.stallTicks);
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

  /**
   * Perdoa o travamento corrente (pouso em chão novo, item coletado, reset de energia, caça a
   * item em andamento) por UM motivo só: a aposta anterior já não explica o mundo. Mantém um
   * ponto de verdade — o contador mora no `StuckSentinel` — porque zerar só o espelho local foi
   * o que permitiu 22 minutos de loop sem ninguém notar.
   */
  private forgiveStall(): void {
    this.guardian.sentinel.forgive();
    this.progressStallTicks = 0;
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

    const isLavaHere = (bx: number, by: number): boolean => this.isLavaCell(wram, bx, by);

    const isCellAir = (bx: number, by: number, allowBreakable: boolean): boolean => {
      if (bx < 0 || by < 0 || bx >= rw || by >= rh) return false;
      // lava não é ar navegável: o mapa de blocos não sabe que ali machuca
      if (isLavaHere(bx, by)) return false;
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
      // superfície de lava não é chão para se parar em cima
      if (isLavaHere(bx, by)) return false;
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
            const hazardPen = dy < 0 && isHazardCeiling(nx, ny) ? this.hazardPenalty : 0;
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
          const hazardPen = isHazardCeiling(tx, ny) ? this.hazardPenalty : 0;
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
            const hazardPen = isHazardCeiling(nx, ny) ? this.hazardPenalty : 0;
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
      // A casca do Core-X é metálica/prateada e luminosa: sem esse brilho no sprite, um
      // vermelho qualquer (boca do Kraid, núcleo do Spore Spawn, peito dos Torizo) era
      // classificado como Core-X VERMELHO e o agente largava o plano certo do chefe.
      const hasMetallicShell = colors ? colors.silverCyanRatio >= 0.06 : false;
      if (
        colors &&
        e.hp > 0 &&
        e.hp < 450 &&
        hasMetallicShell &&
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
          // Infere a letra do terminal pelo posicionamento no mapa (cada letra ocupa uma região da sala)
          const terminalLetter = this.inferTerminalLetter(type, plm.bx, plm.by, wram.roomWidthBlocks, wram.roomHeightBlocks);
          this.interactiveObjects.push({
            bx: plm.bx,
            by: plm.by,
            x: plm.x,
            y: plm.y,
            type,
            interacted: false,
            priority,
            letter: terminalLetter,
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

    // Rastreia terminais pendentes por setor (sala)    const roomPending = new Set<string>();    for (const obj of this.interactiveObjects) {      if (!obj.interacted && obj.letter) {        roomPending.add(obj.letter);      }    }    this.sectorTerminalsPending.set(wram.roomId, roomPending);  // Infere a letra do terminal pelo posicionamento no mapa.
  // Cada letra (A, N, D, S) ocupa uma região diferente da sala.
  // Retorna undefined quando não é possível determinar.
  private inferTerminalLetter(
    type: InteractiveObject['type'],
    bx: number,
    by: number,
    roomWidthBlocks: number,
    roomHeightBlocks: number,
  ): string | undefined {
    // Mapeamento direto por tipo de PLM quando possível
    switch (type) {
      case 'SAVE_STATION':
        return 'S';
      case 'POWER_PANEL':
      case 'ENERGY_AUX':
        return 'A';
      case 'COMPUTER':
        return 'N';
      case 'TERMINAL':
        // Terminais genéricos podem ser D (Data) ou N (Navigation); usa posição como desempate
        if (!roomWidthBlocks || !roomHeightBlocks) return 'D';
        const cx = bx / roomWidthBlocks;
        const cy = by / roomHeightBlocks;
        return cy < 0.5 && cx > 0.5 ? 'N' : 'D';
      case 'DOOR_CONTROL':
        return 'N';
      default:
        return undefined;
    }
  }

  // Verifica se o terminal pode ser ativado neste setor.
  // O A (Auxiliary Power) é o gate do setor: sem ativar o A primeiro,
  // não dá para ativar N, D ou S naquele setor.
  private canActivateTerminalInSector(roomId: number, letter: string | undefined): boolean {
    if (!letter) return true; // sem letra conhecida: permite ativar (fallback)
    if (letter === 'A') return true; // A é sempre o primeiro a ser ativado no setor
    // Para N, D, S: só pode se o A já foi ativado neste setor
    return this.sectorPowerAuxActivated.has(roomId);
  }

  // Marca que o terminal A (Auxiliary Power) foi ativado neste setor.
  // Após isso, N, D e S ficam disponíveis no mesmo setor.
  private markSectorPowerAuxActivated(roomId: number): void {
    this.sectorPowerAuxActivated.add(roomId);
    // Remove do pendente se existir
    const pending = this.sectorTerminalsPending.get(roomId);
    if (pending) {
      pending.delete('A');
    }
  }

  // Mapeia o roomId do WRAM para um SectorId do sistema de missão.
  // Como os roomIds exatos do X-Fusion variam por versão, usa faixas aproximadas
  // baseadas na estrutura padrão do Super Metroid:
  //   0x00-0x3F: Crateria (SRX)
  //   0x40-0x7F: Brinstar (NOC)
  //   0x80-0xBF: Norfair (NOR)
  //   0xC0-0xFF: Wrecked Ship / Maridia (WST/EAS)
  //   0x100+: Tourian / área final (MET/CRT)
  private roomIdToSector(roomId: number): SectorId | null {
    if (roomId < 0x40) return 'SRX';
    if (roomId < 0x80) return 'NOC';
    if (roomId < 0xC0) return 'NOR';
    if (roomId < 0x100) return 'WST';
    if (roomId < 0x140) return 'EAS';
    return 'MET';
  }

  // =====================================================================
  // DETECÇÃO DE CAMINHOS SECRETOS / BLOCOS FALSOS (X-Ray Scope)
  // Quando o X-Ray Scope está equipado, blocos falsos nas paredes/teto/chão
  // revelam passagens ocultas. Marca essas posições no grafo para que o
  // agente saiba que há uma rota secreta a ser testada (atirar/bombardear).
  // =====================================================================
  private detectSecretPaths(wram: MetroidWramSnapshot): void {
    const currNode = this.getOrCreateRoom(wram.roomId);

    // 1) CONFRONTA a aposta do tick anterior: o bloco deixou de ser "sólido com BTS"? Então era
    // falso mesmo. Se não, é mais uma tentativa gasta — e ao estourar o orçamento a célula entra
    // em `unbreakableGates` e para de ser alvo. É exatamente o passo que faltava: o código
    // antigo fazia `sp.tested = true` e, no tick seguinte, `secretPaths.clear()` apagava a
    // marca. Resultado medido no ROM real: 5.678 ticks batendo tiro de feixe na mesma parede.
    if (this.pendingSecretShot) {
      const p = this.pendingSecretShot;
      if (p.roomId !== wram.roomId) {
        this.pendingSecretShot = null;
        this.secretApproach.clear();
      } else if (wram.blockTypes && wram.btsBytes) {
        const idx = p.by * wram.roomWidthBlocks + p.bx;
        const stillSolid =
          idx >= 0 &&
          idx < wram.blockTypes.length &&
          wram.blockTypes[idx] === 0x8 &&
          wram.btsBytes[idx] !== 0;
        this.guardian.hypotheses.settle(p.key, !stillSolid, this.stepIndex);
        if (!stillSolid) {
          currNode.secretPaths.delete(`${p.bx}:${p.by}`);
        } else if (this.guardian.hypotheses.isDead(p.key)) {
          this.unbreakableGates.add(cellKey(wram.roomId, p.bx, p.by));
          currNode.secretPaths.delete(`${p.bx}:${p.by}`);
        }
        this.pendingSecretShot = null;
      }
    }

    // 2) X-Ray vindo de inventário NÃO-confiável CRIA alvos que não existem. No *X-Fusion* o
    // bit 0x8000 aparecia armado no prólogo de Ceres (a máscara lida em $7E:09A4 vale 0xfbbf
    // com $7E:09A2 = 0), e a "caça ao segredo" virou o buraco negro da sessão. Sem confiança
    // na leitura, não há caçada: a navegação comum continua.
    if (!wram.inventoryTrusted) {
      if (currNode.secretPaths.size > 0) currNode.secretPaths.clear();
      return;
    }
    const hasXRay = (wram.itemsMask & 0x8000) !== 0;
    if (!hasXRay || !wram.blockTypes || !wram.btsBytes) return;

    const roomId = wram.roomId;
    const rw = wram.roomWidthBlocks;
    const rh = wram.roomHeightBlocks;

    // Varre SÓ as bordas, que é o domínio do critério. Antes: `for by { for bx { if (!isEdge)
    // continue; } }` — rw*rh voltas por tick (2.048 numa sala 128×16) para jogar fora ~96% no
    // primeiro `continue` (era o pico de 25 ms/decisão medido no playtest).
    const cells: number[] = [];
    for (let bx = 0; bx < rw; bx++) cells.push(bx, (rh - 1) * rw + bx);
    for (let by = 1; by < rh - 1; by++) cells.push(by * rw, by * rw + rw - 1);

    for (const idx of cells) {
      if (idx < 0 || idx >= wram.blockTypes.length) continue;
      const bx = idx % rw;
      const by = Math.floor(idx / rw);
      const id = `${bx}:${by}`;
      const gateKey = cellKey(roomId, bx, by);
      if (this.unbreakableGates.has(gateKey)) {
        if (currNode.secretPaths.has(id)) currNode.secretPaths.delete(id);
        continue;
      }
      if (wram.blockTypes[idx] !== 0x8) continue;
      if (wram.btsBytes[idx] === 0) continue;

      const x = bx * 16 + 8;
      const y = by * 16 + 8;
      const h = this.guardian.hypotheses.open(targetKey(roomId, 'XRAY', x, y), 'SECRET_BLOCK', roomId, 3, `bloco falso (${bx},${by})`);
      if (h.status === 'DEAD') {
        this.unbreakableGates.add(gateKey);
        continue;
      }
      if (!currNode.secretPaths.has(id)) {
        currNode.secretPaths.set(id, {
          bx,
          by,
          x,
          y,
          blockType: 0x8,
          bts: wram.btsBytes[idx],
          // "testada" = orçamento esgotado, não "atirei uma vez"
          tested: h.attempts >= h.budget,
          reason: 'bloco falso detectado via X-Ray',
        });
      }
      if (h.attempts === 0) {
        this.addPendingTarget({
          roomId,
          x,
          y,
          dir: bx < rw / 2 ? 'LEFT' : 'RIGHT',
          note: `CAMINHO SECRETO · teste bloco falso em (${bx},${by})`,
          priority: 50,
        });
      }
    }
  }

  // Testa um bloco falso candidato (atira/bomba para revelar passagem secreta)
  private executeSecretPathTest(wram: MetroidWramSnapshot, motionPct: number): AIAction | null {
    if (!wram.inventoryTrusted) return null;
    const hasXRay = (wram.itemsMask & 0x8000) !== 0;
    if (!hasXRay) return null;

    const currNode = this.getOrCreateRoom(wram.roomId);
    if (currNode.secretPaths.size === 0) return null;

    // Encontra o caminho secreto mais próximo AINDA VIVA no orçamento de tentativas
    let nearest: { key: string; sp: { bx: number; by: number; x: number; y: number; tested: boolean } } | null = null;
    let nearestDist = Infinity;
    for (const [key, sp] of currNode.secretPaths) {
      if (sp.tested) continue;
      const hypoKey = targetKey(wram.roomId, 'XRAY', sp.x, sp.y);
      if (this.guardian.hypotheses.isDead(hypoKey)) continue;
      const dist = Math.hypot(sp.x - wram.samusX, sp.y - wram.samusY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { key: hypoKey, sp };
      }
    }
    if (!nearest) return null;

    const { sp } = nearest;
    const dist = nearestDist;
    const { shoot: shootKey, jump: jumpKey, run: dashKey } = wram.controls;

    // Se está perto do bloco falso, testa atirando ou usando bomba
    if (dist < 64) {
      const keys: AIKey[] = [sp.x >= wram.samusX ? 'RIGHT' : 'LEFT'];
      const aimUp = sp.y < wram.samusY - 8;
      const aimDown = sp.y > wram.samusY + 8;
      if (aimUp) keys.push('UP');
      else if (aimDown) keys.push('DOWN');

      const shape = this.guardian.jumpHold(sp.y, wram.samusY, this.isSamusGrounded(wram));

      // Se tem bomba e está embaixo, planta bomba
      if (aimDown && (wram.itemsMask & 0x1004) === 0x1004) {
        keys.push('DOWN');
        if (this.nextShoot(true)) {
          keys.push(shootKey);
          this.guardian.hypotheses.attempt(nearest.key, this.stepIndex);
          this.pendingSecretShot = { key: nearest.key, roomId: wram.roomId, bx: sp.bx, by: sp.by };
        }
        return this.makeMetroidAction(
          'COLLECT',
          keys,
          140,
          'run',
          motionPct,
          'Caminho Secreto · Bomba',
          `Testando bloco falso com bomba em (${sp.bx},${sp.by}) (tentativa ${this.guardian.hypotheses.get(nearest.key)?.attempts ?? 0}/3)`,
          wram,
        );
      }

      // Senão, atira no bloco falso — UMA aposta por vez, conferida no tick seguinte
      if (this.nextShoot(true)) {
        keys.push(shootKey);
        this.guardian.hypotheses.attempt(nearest.key, this.stepIndex);
        this.pendingSecretShot = { key: nearest.key, roomId: wram.roomId, bx: sp.bx, by: sp.by };
        if (aimUp && shape.gapPx > 10 && this.nextJump(true, shape.holdTicks)) keys.push(jumpKey);
        const attempts = this.guardian.hypotheses.get(nearest.key)?.attempts ?? 1;
        return this.makeMetroidAction(
          'COLLECT',
          keys,
          // pulo curto = tick curto: é o `time` que devolve resolução ao aperto do botão
          aimUp ? Math.max(50, Math.min(160, shape.holdMs)) : 95,
          'run',
          motionPct,
          'Caminho Secreto · Atirar',
          `Atirando no bloco falso em (${sp.bx},${sp.by}) · tentativa ${attempts}/3${attempts >= 3 ? ' — próxima vira "parede", não alvo' : ''}`,
          wram,
        );
      }
      return this.makeMetroidAction(
        'COLLECT',
        keys,
        60,
        'run',
        motionPct,
        'Caminho Secreto · Mirando',
        `Alinhando o tiro no bloco falso em (${sp.bx},${sp.by})`,
        wram,
      );
    }

    // Se não está perto, se aproxima — com o pulo dimensionado pelo vão (F: "erro de pulo"
    // vinha do aperto fixo de 3 ticks: curto demais para plataforma alta, alto demais para
    // ajuste de borda, e sem encadear quando o vão passava do pulo simples)
    this.chargeSecretApproach(nearest.key, dist, wram.roomId, sp.bx, sp.by);
    const keys: AIKey[] = [sp.x >= wram.samusX ? 'RIGHT' : 'LEFT', dashKey];
    const shape = this.guardian.jumpHold(sp.y, wram.samusY, this.isSamusGrounded(wram));
    if (this.nextJump(true, shape.holdTicks)) keys.push(jumpKey);
    return this.makeMetroidAction(
      'COLLECT',
      keys,
      Math.max(55, Math.min(140, shape.holdMs)),
      'run',
      motionPct,
      'Caminho Secreto · Aproximando',
      `Indo até bloco falso em (${sp.bx},${sp.by}) · ${shape.why}`,
      wram,
    );
  }

  /**
   * Orçamento de APREXIMAÇÃO de um alvo de bloco falso. Caminhar até o bloco é parte da aposta,
   * não um prelúdio grátis: no playtest refeito a Samus passou 16.597 ticks em "Indo até bloco
   * falso em (47,13)" encostada na parede direita da sala 0x8b5a — o tiro nunca era disparado,
   * então nenhuma tentativa era contabilizada e a aposta nunca morria. Cada janela de 40 ticks
   * sem fechar 10 px de distância custa uma vida da hipótese; esgotado o orçamento, a célula vira
   * `unbreakableGates` e para de ser alvo.
   */
  private secretApproach = new Map<string, { dist: number; tick: number }>();

  /** devolve true quando a aproximação do alvo perdeu a última vida (alvo morto) */
  private chargeSecretApproach(key: string, dist: number, roomId: number, bx: number, by: number): boolean {
    const prev = this.secretApproach.get(key);
    if (!prev) {
      if (this.secretApproach.size > 64) this.secretApproach.clear();
      this.secretApproach.set(key, { dist, tick: this.stepIndex });
      return false;
    }
    if (dist <= prev.dist - 10) {
      this.secretApproach.set(key, { dist, tick: this.stepIndex });
      return false;
    }
    if (this.stepIndex - prev.tick < 40) return false;
    this.secretApproach.set(key, { dist, tick: this.stepIndex });
    this.guardian.hypotheses.attempt(key, this.stepIndex);
    this.guardian.hypotheses.settle(key, false, this.stepIndex);
    if (this.guardian.hypotheses.isDead(key)) {
      this.secretApproach.delete(key);
      this.unbreakableGates.add(cellKey(roomId, bx, by));
      this.getOrCreateRoom(roomId).secretPaths.delete(`${bx}:${by}`);
      return true;
    }
    return false;
  }

  /**
   * Encostar é o que coleta o parasita X (atirar nele destrói a cura). Caminha até o X solto —
   * ou até o ponto onde o inimigo caiu, se o X já flutuou para fora da tela — sem atirar, e o
   * `PreyChaser` fecha a janela quando vida/munição voltaram ou quando o prazo venceu. O vão
   * vertical usa o mesmo `JumpModulator` da navegação: sem pulo na altura certa a coleta
   * vira "pular no lugar" outra vez.
   */
  private executeParasiteAbsorb(
    wram: MetroidWramSnapshot,
    motionPct: number,
    intent:
      | { kind: 'ABSORB'; slot: number; dir: 'LEFT' | 'RIGHT'; aim: 'UP' | 'DOWN' | null }
      | { kind: 'SWEEP_LOOT'; x: number; y: number; dir: 'LEFT' | 'RIGHT' },
  ): AIAction | null {
    const { run: dashKey, jump: jumpKey } = wram.controls;
    const keys: AIKey[] = [intent.dir, dashKey];
    if (intent.kind === 'ABSORB' && intent.aim) keys.push(intent.aim);
    const targetY = intent.kind === 'SWEEP_LOOT' ? intent.y : wram.samusY;
    const shape = this.guardian.jumpHold(targetY, wram.samusY, this.isSamusGrounded(wram));
    if (shape.gapPx > 8 && this.nextJump(true, shape.holdTicks)) keys.push(jumpKey);
    return this.makeMetroidAction(
      'COLLECT',
      keys,
      Math.max(45, Math.min(120, shape.holdMs)),
      'run',
      motionPct,
      intent.kind === 'ABSORB' ? 'Coleta · absorvendo parasita X' : 'Coleta · varrendo o ponto do abate',
      intent.kind === 'ABSORB'
        ? 'Encostando no X solto (atirar nele jogaria a cura fora)'
        : 'Procurando o X liberado pelo abate antes de voltar a andar',
      wram,
    );
  }

  /**
   * SELECT é um seletor ROTATIVO: um toque e "torcer" só funciona para míssil. Este helper dá
   * ao caminho de porta a mesma disciplina que o codex de chefes já tinha — conta toques, sabe
   * quantas casas o HUD tem e desiste quando a volta não achou o slot (HUD de hack), em vez de
   * pingar SELECT para sempre.
   */
  private slotPlanFor(
    wram: MetroidWramSnapshot,
    need: string,
  ): { tap: boolean; restore: boolean; gaveUp: boolean; want: number; why: string } {
    const want: 0 | 1 | 2 | 3 =
      need === 'MISSILES' ? 1 : need === 'SUPERS' ? 2 : need === 'POWER_BOMBS' ? 3 : 0;
    const hasSpecial =
      want === 1
        ? wram.maxMissiles > 0 && wram.missiles > 0
        : want === 2
          ? wram.maxSupers > 0 && wram.supers > 0
          : want === 3
            ? wram.maxPowerBombs > 0 && wram.powerBombs > 0
            : false;
    const step = this.guardian.slots.plan(this.stepIndex, wram.selectedHudItem as 0 | 1 | 2 | 3, want, hasSpecial);
    return { tap: step.tapSelect, restore: step.restoreBeam, gaveUp: step.gaveUp, want, why: step.why };
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

    // Ativa energia/terminal se for do tipo relacionado
    if (
      obj.type === 'ENERGY_AUX' ||
      obj.type === 'POWER_PANEL' ||
      obj.type === 'TERMINAL' ||
      obj.type === 'SAVE_STATION'
    ) {
      this.powerAuxActivated = true;
      this.roomsWithPowerIssue.delete(wram.roomId);

      // Integração com o sistema de missão completa
      const sectorId = this.roomIdToSector(wram.roomId);
      if (sectorId && obj.letter) {
        this.missionSystem?.activateTerminal(sectorId, obj.letter as 'A' | 'N' | 'D' | 'S');
        this.missionSystem?.setCurrentSector(sectorId);
      }

      // Se é o terminal A (Auxiliary Power), marca o setor como com energia ativada.
      // Só após o A é que N, D e S ficam disponíveis neste setor.
      if (obj.letter === 'A') {
        this.markSectorPowerAuxActivated(wram.roomId);
      }
    }

    // Tratamento específico por letra do terminal
    if (obj.letter === 'S') {
      // Save Room: restaura energia para 100% (missão principal)
      if (wram.maxHealth > 0) {
        wram.health = wram.maxHealth;
      }
      const sectorId = this.roomIdToSector(wram.roomId);
      if (sectorId) {
        this.missionSystem?.setEnergyFull(sectorId, true);
        this.missionSystem?.setReserveFull(sectorId, true);
      }
    } else if (obj.letter === 'N') {
      // Navigation Room: Adam atualiza objetivos — marca para reavaliar mapa
      this.preferredDirection = null; // forçar releitura do mapa
    } else if (obj.letter === 'D') {
      // Data Room: download de equipamentos — marcar itens como disponíveis
      this.reopenNavBacklog(wram);
    } else if (obj.letter === 'A') {
      // Auxiliary Power: energia da área reativada — liberar portas/elevadores
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
    // A diretiva do codex só vale dentro do tick em que foi calculada.
    this.bossDirective = null;

    // Inicializa o sistema de missão (lazy, uma vez por sessão)
    if (!this.missionSystem) {
      this.missionSystem = getMissionSystem('super-metroid');
      void this.missionSystem.load();
    }

    // Primeiro, fecha as lutas cujo alvo sumiu (morrer limpa o slot do inimigo). Isso tem
    // que rodar antes de qualquer retorno antecipado: na hora da vitória a sala fica sem
    // inimigos, e a conferência de menu passaria na frente roubando o registro.
    this.reapBossFights(wram);

    // Navegação e mapa vêm antes do dispatch de gameState: com o mapa na tela o jogo pausa
    // (gameState sai de 8) e cair no executeMenuState nos deixaria presos ali.
    const bossEngaged = this.bossInRoom(wram);
    this.bossEngagedThisTick = bossEngaged;
    this.navPerceive(wram, bossEngaged);
    const mapAction = this.mapConsultStep(wram, bossEngaged, motionPct);
    if (mapAction) return mapAction;

    // 1) Estados de Menu / Pausa / Transição de Porta / Cutscene
    if ((wram.gameState <= 4 && wram.roomId === 0) || wram.gameState === 0x0c) {
      this.resetUSearch();
      return this.executeMenuState(m, motionPct, targetDifficulty, wram);
    }

    if (wram.gameState === 0x0b) {
      this.resetUSearch();
      this.jumpHoldRemaining = 0;
      // Medido no playtest: SOLTA-LA no meio do scroll é pior — o estado 0x0b deste hack só
      // anda com a tecla da porta pressionada (67 % → 83 % dos ticks dentro do estado quando o
      // direcional foi liberado). Então a tecla fica; o que muda é o primeiro tick DEPOIS da
      // transição (ver `entryDoorCalmTicks` em `syncRoomAndProgress`).
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

    // 0) O loadout vem da memória, não do menu: analisa uma vez e segue.
    if (!this.initialLoadoutAnalyzed) {
      this.analyzeInitialLoadout(wram);
    }
    // reafirma o gate do codex depois das transições de estado
    this.bossEngagedThisTick = bossEngaged;

    // Atualiza grafo de salas, progresso real e detecção de bloqueio
    const { unlockedLabel, hitKnownBlocked } = this.syncRoomAndProgress(wram);

    // "depois volta quando tiver a habilidade": item novo reabre as portas guardadas no backlog
    if (unlockedLabel) this.reopenNavBacklog(wram);

    // Identifica alvos REAIS no ambiente (ignorando elementos estáticos/visuais do cenário)
    const activeEnemies = wram.enemies.filter((e) => !this.enemyTracks.get(e.slot)?.ignoredAsStatic);

    const { omegaIntro, bigMetroid, coreXTarget, saxPursuer, metroidLarva } =
      this.classifySpecialEntities(wram, activeEnemies);

    const activeItem = wram.roomItems
      .map((it) => ({ ...it, dist: Math.hypot(it.x - wram.samusX, it.y - wram.samusY) }))
      .sort((a, b) => a.dist - b.dist)[0];

    // Detecta objetos interativos (terminais, computadores, painéis de energia, estações de save)
    this.detectInteractiveObjects(wram);

    // MISSÃO 100%: detecta caminhos secretos via X-Ray (blocos falsos nas bordas da sala)
    this.detectSecretPaths(wram);

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

    let nearbyEnemy = activeEnemies
      .map((e) => ({ ...e, dist: Math.hypot(e.x - wram.samusX, e.y - wram.samusY) }))
      .filter((e) => {
        if (e.hp <= 0) return false;
        // Um chefe em luta acompanhada pelo codex nunca é rebaixado a "cenário estático":
        // o filtro de hostilidade existia para ignorar decoração, não para largar um chefe.
        const isRegularBoss = e.hp >= 450 || this.isTrackedBoss(e);
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

    // ─── alvo travado + parasita X (objetivo 2 do pedido) ────────────────────────────────
    // Dois erros que o playtest mostrou: (1) o alvo era re-escolhido a cada tick por distância,
    // então dois inimigos no mesmo canto viravam tiro em nada; (2) não existia o conceito de
    // "encostar no X que o abate soltou" — em *X-Fusion* isso É a cura e a munição, e atirar
    // nele joga fora. `PreyChaser` resolve os dois: lock-on por `slot` com prazo, prioridade
    // absoluta ao X solto (andar, nunca atirar) e varredura do ponto do abate enquanto houver
    // vida/munição a recuperar.
    const preyIntent = this.guardian.prey.decide(
      this.stepIndex,
      activeEnemies.map((e) => ({
        slot: e.slot,
        x: e.x,
        y: e.y,
        hp: e.hp,
        xRadius: e.xRadius,
        yRadius: e.yRadius,
        // hitbox pequena e perto do corpo = X solto (ele não tem "vida" de inimigo)
        fromKill: e.xRadius <= 12 && e.yRadius <= 12 && Math.hypot(e.x - wram.samusX, e.y - wram.samusY) < 120,
      })),
      { x: wram.samusX, y: wram.samusY },
      {
        wantFight: !this.escortActive && !metroidLarva && !saxPursuer && !bossEngaged,
        needHeal: wram.maxHealth > 0 && wram.health < wram.maxHealth * 0.98,
        // "preciso de munição" = está BAIXA, não "não está no talo". Caçar X com 40/40 mísseis
        // é gastar a sala em nada; o ganho real aparece quando o estoque ameaça acabar.
        needAmmo:
          (wram.maxMissiles > 0 && wram.missiles <= Math.floor(wram.maxMissiles / 4)) ||
          (wram.maxSupers > 0 && wram.supers === 0) ||
          (wram.maxPowerBombs > 0 && wram.powerBombs === 0),
        maxHealth: wram.maxHealth,
      },
    );
    if (preyIntent.kind === 'ABSORB' || preyIntent.kind === 'SWEEP_LOOT') {
      const absorb = this.executeParasiteAbsorb(wram, motionPct, preyIntent);
      if (absorb) return absorb;
    } else if (preyIntent.kind === 'ENGAGE') {
      const locked = activeEnemies.find((e) => e.slot === preyIntent.slot);
      if (locked) {
        nearbyEnemy = { ...locked, dist: Math.hypot(locked.x - wram.samusX, locked.y - wram.samusY) };
      }
    }

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
      this.forgiveStall();
    }

    // Limpa pendência alcançada na sala atual
    this.pendingTargets = this.pendingTargets.filter(
      (t) => !(t.roomId === wram.roomId && t.unlockedToRetry && Math.abs(t.x - wram.samusX) < 64),
    );

    const backtrackDir = this.findBfsStepTowardPending(wram.roomId);

    // 2) Máquina de Estados de Comportamento (com prioridades especiais X-Fusion)
    //
    // 2a) ESCOLTA DE METROID — no Super Metroid (e no X-Fusion) o Metroid Grande/Ômega não é
    // um inimigo a matar nem um evento a esperar: ele é o ROTEIRO, é ele que abre o caminho.
    // O frame real do usuário (sala azul, TIME 00'50"94) mostrou os dois modos de errar:
    // atirar num bicho que não morre sem Ice Beam, e ficar PARADA esperando um dreno que só
    // existe no prólogo. Aqui a regra é uma só: fica na zona dele, segue por onde ele sai,
    // e não para para brigar com mob no caminho.
    {
      const met = bigMetroid && this.bigMetroidHealedTick < 0 ? bigMetroid : omegaIntro ?? metroidLarva;
      const escortEntity: EscortEntity | null = met
        ? {
            x: met.x,
            y: met.y,
            vx: met.x - this.metroidPrevX,
            vy: 0,
            hp: met.hp,
            kind: met === omegaIntro ? 'OMEGA' : met === bigMetroid ? 'BIG' : 'LARVA',
          }
        : null;
      if (escortEntity) {
        this.metroidSeenTick = this.stepIndex;
        this.metroidSeenRoomId = wram.roomId;
        this.metroidPrevX = escortEntity.x;
        if (escortEntity.x < 40) this.metroidExitDir = 'LEFT';
        else if (escortEntity.x > wram.roomWidthPx - 40) this.metroidExitDir = 'RIGHT';
      } else if (this.stepIndex - this.metroidSeenTick >= ESCORT_MEMORY_TICKS) {
        this.metroidExitDir = null;
      }
      // memória de escolta não pode arrastar a Samus pelo mapa afora: ela vale na sala do bicho
      // e por mais ~90 ticks (o tempo de cruzar a porta atrás dele); depois disso é história
      const escortMemoryOk =
        this.metroidSeenRoomId === wram.roomId || this.stepIndex - this.metroidSeenTick < 90;
      const escortDoors: EscortDoor[] = wram.doors.map((d) => ({
        key: d.key,
        side: d.side,
        x: d.x,
        y: d.y,
        open: !d.blockedByWall,
      }));
      if (escortEntity || (this.stepIndex - this.metroidSeenTick < ESCORT_MEMORY_TICKS && escortMemoryOk)) {
        const escort = decideEscort({
          samusX: wram.samusX,
          samusY: wram.samusY,
          entity: escortEntity,
          ticksSinceSeen: escortEntity ? 0 : this.stepIndex - this.metroidSeenTick,
          lastExitDir: this.metroidExitDir,
          doors: escortDoors,
          // Metroid só morre congelado: sem Ice Beam + míssil, atirar nele é perder a run
          canKill: metroidKillReady(wram.beamsMask, wram.missiles),
          // o dreno "resolve" alguma coisa apenas no prólogo, onde a SA-X vem e o resgate existe
          drainResolvesRescue:
            wram.maxHealth <= 199 &&
            (wram.itemsMask & 0x0021) === 0 &&
            (wram.countdownActive || saxPursuer !== null) &&
            this.bigMetroidHealedTick < 0,
          roomHasPendingBusiness: Boolean(activeItem) || bossEngaged || Boolean(coreXTarget),
          ticksSinceProgress: this.stepIndex - this.lastNavProgressTick,
          roomWidthPx: wram.roomWidthPx,
        });
        if (escort.action === 'HOLD' && bigMetroid) {
          // Imagem 9 (ramo original, agora dentro da escolta): deixar o Metroid Grande drenar
          // vida/habilidades sem fugir da sala, mesmo com a SA-X presente. "HOLD" NÃO é parar —
          // o dreno só existe por CONTATO, então é chegar nele e ficar (parar aqui é exatamente
          // o "fica ali paradinha e perde o tempo" do print).
          this.bigMetroidDrainSeen = true;
          this.resetUSearch();
          this.planBossFor(wram, bigMetroid, null);
          const approachDir: AIKey = bigMetroid.x >= wram.samusX ? 'RIGHT' : 'LEFT';
          const drainKeys: AIKey[] = bigMetroid.dist > 44 ? [approachDir] : ['NONE'];
          return this.makeMetroidAction(
            'COLLECT',
            drainKeys,
            140,
            'run',
            motionPct,
            'Metroid Grande · Evento de Dreno',
            'Permitindo o dreno do Metroid Grande para ativar o resgate contra SA-X',
            wram,
          );
        }
        // "já estou na zona dele" NÃO é um plano: ficar ali parado vendo o bicho é exatamente
        // o que come o countdown. Ela avança para a saída na direção do bicho (e o ramo normal
        // continua valendo para item/pulta, que é progresso de verdade).
        if (!escort.dir && !escort.vertical && escort.action === 'FOLLOW') {
          this.escortIgnoreMobsUntil = this.stepIndex + 40;
          const heading = escortEntity && Math.abs(escortEntity.vx) > 0.2
            ? (escortEntity.vx > 0 ? 'RIGHT' : 'LEFT')
            : null;
          const exit = wram.doors.find(
            (d) => !d.blockedByWall && (heading === null || (heading === 'RIGHT' ? d.x > wram.samusX + 8 : d.x < wram.samusX - 8)),
          );
          if (exit && !activeItem) {
            const dir: AIKey = exit.x >= wram.samusX ? 'RIGHT' : 'LEFT';
            this.moveDir = dir;
            this.resetUSearch();
            return this.makeMetroidAction(
              'COLLECT',
              [dir, wram.controls.run],
              128,
              'run',
              motionPct,
              'Escoltando o Metroid · até a saída',
              `Metroid na zona dele; avançando para a saída ${exit.side} em vez de esperar`,
              wram,
            );
          }
        }
        if ((escort.action === 'FOLLOW' || escort.action === 'CHASE_DOOR') && (escort.dir || escort.vertical)) {
          this.escortIgnoreMobsUntil = this.stepIndex + 120;
          this.resetUSearch();
          const { run: dashKey, jump: jumpKey } = wram.controls;
          const keys: AIKey[] = [];
          if (escort.dir) {
            keys.push(escort.dir, dashKey);
            this.moveDir = escort.dir === 'LEFT' ? 'LEFT' : 'RIGHT';
          }
          if (escort.vertical === 'UP' && this.nextJump(true, 3)) keys.push(jumpKey);
          if (escort.vertical === 'DOWN' && !this.isSamusGrounded(wram)) keys.push('DOWN');
          if (keys.length === 0) keys.push('NONE');
          return this.makeMetroidAction(
            'COLLECT',
            keys,
            130,
            'run',
            motionPct,
            escort.action === 'CHASE_DOOR'
              ? 'Escoltando o Metroid · atrás da saída'
              : 'Escoltando o Metroid (não atirar)',
            escort.reason,
            wram,
          );
        }
      }
    }

    if (coreXTarget && coreXTarget.stage === 'PODER_EXPOSTO') {
      // Imagem 7 + Imagem 2: núcleo Core-X exposto — perseguir diretamente sem desviar para a parede!
      this.resetUSearch();
      // Mantém o estado do codex vivo neste ramo (é assim que a sala é vinculada à estratégia
      // no momento em que o núcleo é absorvido e o slot do inimigo é limpo).
      this.planBossFor(wram, coreXTarget, 'PODER_EXPOSTO');
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
      // Imagem 1: acompanhar o ritmo do Omega Metroid inicial até o timer disparar e ele sumir.
      // Fallback: só chega aqui quando a ESCOLTA decidiu BRIGAR (Ice Beam + míssil na mão) ou
      // quando não há escolta ativa — sem isso, atirar no bicho é o modo padrão de perder a run.
      this.resetUSearch();
      const { shoot: shootKey, jump: jumpKey, run: dashKey } = wram.controls;
      const aimDir: 'LEFT' | 'RIGHT' = omegaIntro.x >= wram.samusX ? 'RIGHT' : 'LEFT';
      const paceDir: 'LEFT' | 'RIGHT' =
        omegaIntro.dist < 68 ? (aimDir === 'RIGHT' ? 'LEFT' : 'RIGHT') : aimDir;
      this.moveDir = paceDir;
      const keys: AIKey[] = [paceDir, dashKey];
      // Atirar no ômega sem gelo+míssil não faz NADA com ele e custa o tempo da corrida: só
      // dispara quem tem como matar (a mesma regra que a escolta usa — uma fonte de verdade).
      const canFight = metroidKillReady(wram.beamsMask, wram.missiles);
      if (canFight && this.nextShoot(true)) keys.push(shootKey);
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
    // Estagnação → escada de escape. `MAP_READ` não devolve teclas daqui: ele arma
    // `forceMapReadTicks` e deixa o `mapConsultStep` abrir o mapa (ele tem a máquina de
    // abrir/ler/varrer/fechar, que não é para duplicar aqui).
    const escape = this.updateEscapeLadder(wram);
    // um pedido de leitura de mapa pendente tem prioridade sobre o corpo do escape: o degrau
    // MAP_READ não devolve teclas de propósito (quem abre o menu é o `mapConsultStep`, com a
    // máquina de abrir/varrer/fechar). Sem esta cessão, o BLOCK_ROOM engolia a janela e o
    // START atrasava 100+ ticks (a simulação de navegação pegou: tick 438 em vez de <420).
    if (escape.engaged && escape.dir && this.forceMapReadTicks <= 0) {
      const { jump: jumpKey, run: dashKey, shoot: shootKey } = wram.controls;
      const keys: AIKey[] = [escape.dir, dashKey];
      // varrer com tiro é o jeito humano de achar vão em parede cega; no impulso não atira,
      // para não gastar munição nem grudar num novo alvo
      if (escape.rung === 'SWEEP' || escape.rung === 'REVERSE_PUSH') keys.push(shootKey);
      if (escape.jump) {
        const shape = this.guardian.jumpHold(wram.samusY - 52, wram.samusY, this.isSamusGrounded(wram));
        if (this.nextJump(true, shape.holdTicks)) keys.push(jumpKey);
      }
      return this.makeMetroidAction(
        'EXPLORE',
        keys,
        // impulso é um toquezinho; o resto anda no cadência normal
        escape.rung === 'NUDGE' ? 55 : 120,
        'run',
        motionPct,
        `Escape · ${escape.rung}`,
        `${escape.reason} · travada há ${this.guardian.sentinel.current.stallTicks} ticks na sala 0x${wram.roomId.toString(16)} (${escape.durationTicks} ticks de degrau)`,
        wram,
      );
    }

    // MISSÃO PRINCIPAL: definir ordem de prioridade comportamental.
    // 1. SA-X (fuga ou confronto final) — sempre acima de tudo
    // 2. Core-X poder exposto — coletar imediatamente
    // 3. Caminho secreto (X-Ray) — testar bloco falso para revelar rota oculta
    // 4. Energia auxiliar não ativada nesta sala — ativar (missão principal)
    // 5. Itens/habilidades para coletar — coleta (missão principal)
    // 6. Chefes — só combate se não houver energia/itens/caminhos secretos pendentes
    // 7. Backtracking — voltar para rotas bloqueadas
    // 8. Exploração — descobrir novas salas
    // MISSÃO PRINCIPAL: em cada setor, o terminal A (Auxiliary Power) deve ser
    // ativado PRIMEIRO antes de qualquer N, D ou S. Sem o A, é impossível
    // prosseguir naquele setor (portas, elevadores e sistemas ficam bloqueados).
    const energyAuxPending = this.interactiveObjects.some(
      (o) =>
        (o.type === 'ENERGY_AUX' || o.type === 'POWER_PANEL') &&
        !o.interacted &&
        this.canActivateTerminalInSector(wram.roomId, o.letter),
    );
    const itemPending = activeItem && this.itemChaseTicks < 42;
    // Caminho secreto pendente: há bloco falso não testado nesta sala e o jogador tem X-Ray
    const secretPathPending =
      (wram.itemsMask & 0x8000) !== 0 &&
      this.getOrCreateRoom(wram.roomId).secretPaths.size > 0 &&
      [...this.getOrCreateRoom(wram.roomId).secretPaths.values()].some((sp) => !sp.tested);

    let resolvedMode: AgentBehaviorMode = 'EXPLORE';
    if (saxPursuer && !this.omegaVanishedDuringTimer && !isEscapeCountdown) {
      const saxDisabledByMetroid =
        this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 320;
      const mustFight =
        saxPursuer.saxKind === 'SAX_MONSTER' || saxDisabledByMetroid || this.isReadyToFightSAX(wram);
      resolvedMode = mustFight ? 'COMBAT' : 'EVADE_SAX';
    } else if (coreXTarget) {
      resolvedMode = 'COMBAT';
    } else if (secretPathPending) {
      // Caminho secreto via X-Ray: testa bloco falso antes de prosseguir
      resolvedMode = 'COLLECT';
    } else if (energyAuxPending) {
      // Energia auxiliar tem prioridade sobre combate com chefes comuns
      resolvedMode = 'COLLECT';
    } else if (itemPending || unlockedLabel) {
      resolvedMode = 'COLLECT';
    } else if (backtrackDir && this.progressStallTicks < 16 && !this.omegaVanishedDuringTimer && !isEscapeCountdown) {
      resolvedMode = 'BACKTRACK';
    } else if (
      (metroidLarva || nearbyEnemy) &&
      // na escolta de Metroid, mob no caminho é atraso — os ~20 s atirando num bicho que não
      // morre sem Ice Beam foram exatamente o que o usuário chamou de "perder tempo por bobagem"
      !this.escortActive &&
      (bossEngaged || (!this.uSearch.active && this.progressStallTicks < 12)) &&
      !this.omegaVanishedDuringTimer &&
      (!isEscapeCountdown || Boolean(nearbyEnemy && nearbyEnemy.hp >= 450))
    ) {
      // Com chefe na sala a decisão é sua, não da exploração: sem este gate, ficar parado
      // mirando o ponto fraco contava como "sem progresso" e o agente trocava para EXPLORE.
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
        // Se há caminho secreto pendente via X-Ray, testa o bloco falso primeiro
        if (
          secretPathPending &&
          (wram.itemsMask & 0x8000) !== 0
        ) {
          const secretAction = this.executeSecretPathTest(wram, motionPct);
          if (secretAction) return secretAction;
        }
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
    // O codex usa isto para detectar "luta retomada depois da cena" (Mother Brain fase 3).
    this.lastCutsceneTick = this.stepIndex;
    this.cutsceneRoomId = wram.roomId;
    // O corte do X-Fusion pula a cena com X ("se você apertar X, ele pula logo as cutscenes",
    // narração do 100%). A gente avança com A uns 30 ticks — o suficiente para não perder o
    // trigger da cena — e se a cena persistir, passa a mandar X também.
    const k: AIKey =
      this.cutsceneHoldTicks <= 30
        ? this.cutsceneHoldTicks % 5 === 0
          ? 'A'
          : 'NONE'
        : this.cutsceneHoldTicks % 3 === 0
          ? 'X'
          : this.cutsceneHoldTicks % 3 === 1
            ? 'A'
            : 'NONE';
    return this.makeMetroidAction(
      'CUTSCENE',
      [k],
      125,
      'run',
      motionPct,
      'Cena / Briefing (PT)',
      this.cutsceneHoldTicks <= 30 ? 'Avançando diálogo inicial da missão' : 'Pulando cena longa com X (padrão do hack)',
      wram,
    );
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

  // =========================================================================
  // CODEX DE CHEFES — observação, plano e tradução da diretiva em teclas
  // =========================================================================

  /**
   * Confirma chefes derrotados (alvo ausente da sala após levar dano), vincula a estratégia
   * vitoriosa à sala e emite o registro de conhecimento persistente.
   */
  private reapBossFights(wram: MetroidWramSnapshot): void {
    if (this.bossFightMemory.size === 0) return;
    const alive = new Set(wram.enemies.map((e) => `${e.slot}|${e.id}`));
    for (const [key, mem] of this.bossFightMemory) {
      if (alive.has(key)) {
        mem.goneTicks = 0;
        continue;
      }
      mem.goneTicks += 1;
      if (mem.goneTicks < 4) continue;
      this.bossFightMemory.delete(key);
      if (mem.roomId !== wram.roomId || mem.ticksInFight < 8) continue;
      const wounded = mem.totalDamageDealt > 0 || mem.lastHp <= mem.peakHp * 0.5;
      if (!wounded) continue;
      if (!this.bossRoomBindings.has(mem.roomId)) {
        this.bossRoomBindings.set(mem.roomId, mem.strategyId);
      }
      this.pendingLearnedKnowledge.push({
        entityType: mem.entityType as never,
        entityLabel: mem.bossName,
        powerId: mem.strategyId,
        powerName: `${mem.bossName} · ${mem.phaseLabel}`,
        powerEffect: mem.note,
        roomId: mem.roomId,
      });
    }
  }

  /** Luta que o codex já está acompanhando neste alvo (slot + tipo de inimigo). */
  private isTrackedBoss(e: EnemyInfo): boolean {
    return this.bossFightMemory.has(`${e.slot}|${e.id}`);
  }

  /**
   * true quando há chefe na sala: a "conferência de menu" nunca pode interromper a luta.
   * O engajamento é pegajoso por sala — o HP do chefe cai durante o combate, e um limiar
   * fixo faria a IA desligar exatamente no meio da briga (o erro que isto corrige).
   */
  private bossInRoom(wram: MetroidWramSnapshot): boolean {
    if (wram.enemies.some((e) => e.hp >= 450 || this.isTrackedBoss(e))) {
      this.bossEngagedRoomId = wram.roomId;
      return true;
    }
    if (this.bossEngagedRoomId !== wram.roomId) return false;
    if (!wram.enemies.some((e) => e.hp > 0)) {
      this.bossEngagedRoomId = -1;
      return false;
    }
    return true;
  }

  private bossLoadoutView(wram: MetroidWramSnapshot): LoadoutView {
    const l = this.getAgentLoadout(wram);
    return {
      hasMissiles: l.hasMissiles,
      missileCount: l.missileCount,
      hasSupers: l.hasSupers,
      superCount: l.superCount,
      hasPowerBombs: l.hasPowerBombs,
      powerBombCount: l.powerBombCount,
      hasChargeBeam: l.hasChargeBeam,
      hasIceBeam: l.hasIceBeam,
      hasWaveBeam: l.hasWaveBeam,
      hasSpazerBeam: l.hasSpazer,
      hasPlasmaBeam: l.hasPlasmaBeam,
      beamsEquippedMask: wram.beamsEquipped,
      hasGrapple: l.hasGrapple,
      hasSpaceJump: l.hasSpaceJump,
      hasScrewAttack: l.hasScrewAttack,
      hasVaria: l.hasVaria,
      hasGravity: l.hasGravity,
    };
  }

  /**
   * Aproximação das "torres de energia" da arena do Draygon: alvos pequenos, parados,
   * encostados nas paredes e destrutíveis. Quando uma dessas some depois de a Samus
   * atirar por perto, contamos como torre derrubada — pré-requisito da finalização secreta.
   * É heurística deliberada: o codex só tenta o grapple com ≥1 torre caída e Samus agarrada.
   */
  private countDestroyedStations(wram: MetroidWramSnapshot): number {
    if (this.stationRoomId !== wram.roomId) {
      this.stationRoomId = wram.roomId;
      this.stationSpots.clear();
      this.stationsDestroyedCount = 0;
    }
    const seen = new Set<number>();
    for (const e of wram.enemies) {
      const nearWall = e.x < 60 || e.x > wram.roomWidthPx - 60;
      const smallAndHittable = e.xRadius <= 14 && e.yRadius <= 16 && e.hp > 0 && e.hp < 450;
      if (!nearWall || !smallAndHittable) continue;
      seen.add(e.slot);
      const rec = this.stationSpots.get(e.slot);
      if (rec) {
        rec.ticks += 1;
        rec.goneTicks = 0;
      } else {
        this.stationSpots.set(e.slot, { ticks: 1, goneTicks: 0, destroyed: false });
      }
    }
    for (const [slot, rec] of this.stationSpots) {
      if (seen.has(slot)) continue;
      rec.goneTicks += 1;
      if (!rec.destroyed && rec.ticks >= 3 && rec.goneTicks >= 4) {
        rec.destroyed = true;
        this.stationsDestroyedCount = Math.min(4, this.stationsDestroyedCount + 1);
      }
      if (rec.goneTicks > 40) this.stationSpots.delete(slot);
    }
    return this.stationsDestroyedCount;
  }

  /** Reconhece o alvo, consulta o codex e guarda a diretiva do tick. */
  private planBossFor(
    wram: MetroidWramSnapshot,
    target: (EnemyInfo & { dist: number }) | null,
    coreXStage: CoreXStage | null,
  ): BossDirective | null {
    this.bossDirective = null;
    if (!target) return null;

    // Mob comum não passa pelo codex: a heurística de sempre é mais barata e mais adequada.
    // Mas uma luta já em acompanhamento continua no codex mesmo com o HP do chefe baixo.
    const specialActive = this.activeSpecialEntity !== 'NONE';
    if (target.hp < 450 && !specialActive && !this.isTrackedBoss(target)) return null;

    if (this.bossMemoryRoomId !== wram.roomId) {
      this.bossMemoryRoomId = wram.roomId;
      this.bossFightMemory.clear();
      this.bossSelectTicks = 0;
      this.bossChargeHold = 0;
      this.bossSlotGaveUp = false;
    }

    const profile = this.sampleEnemyVisuals(wram, target);
    const track = this.enemyTracks.get(target.slot);
    const isSaxChase =
      this.activeSpecialEntity === 'SAX_VARIA' || this.activeSpecialEntity === 'SAX_GRAVITY';
    const saxDisabledByMetroid =
      this.bigMetroidHealedTick > 0 && this.stepIndex - this.bigMetroidHealedTick < 320;
    const observation: BossObservation = {
      hp: target.hp,
      spanX: target.xRadius * 2,
      spanY: target.yRadius * 2,
      movedPx: track?.totalMoved ?? 0,
      colors: profile
        ? {
            red: profile.redRatio,
            yellowGreen: profile.yellowGreenRatio,
            silverCyan: profile.silverCyanRatio,
            gold: profile.goldRatio,
            purple: profile.purpleRatio,
            orange: profile.orangeRatio,
            neonGreen: profile.neonGreenRatio,
          }
        : null,
      entity: specialActive ? this.activeSpecialEntity : undefined,
      samusHp: wram.health,
      samusMaxHp: wram.maxHealth,
      countdownActive: wram.countdownActive,
      openExits: wram.doors.filter((d) => !d.blockedByWall).length,
      // Agarrada = leva dano sem sair do lugar (Draygon/hold).
      grabbedImmobilized:
        this.samusDamagedThisTick && Math.abs(this.samusVx) < 1.2 && Math.abs(this.samusVy) < 1.2,
      bossStationary: (track?.totalMoved ?? 0) <= 4,
      stationsDestroyed: this.countDestroyedStations(wram),
      resumedAfterCutscene:
        this.stepIndex - this.lastCutsceneTick <= 90 &&
        this.cutsceneRoomId === wram.roomId &&
        this.cutsceneRoomId !== -1,
      fightable: isSaxChase ? saxDisabledByMetroid || this.isReadyToFightSAX(wram) : true,
      prologueState: wram.maxHealth <= 199 && (wram.itemsMask & 0x0021) === 0,
      coreExposed: coreXStage === 'PODER_EXPOSTO',
    };

    const key = `${target.slot}|${target.id}`;
    const { directive, memory, finished } = planBossFight({
      observation,
      roomId: wram.roomId,
      entityType: specialActive ? this.activeSpecialEntity : 'NONE',
      loadout: this.bossLoadoutView(wram),
      boundStrategyId: this.bossRoomBindings.get(wram.roomId) ?? null,
      memory: this.bossFightMemory.get(key) ?? null,
      targetX: target.x,
      targetY: target.y,
      samusX: wram.samusX,
      samusY: wram.samusY,
    });
    this.bossFightMemory.set(key, memory);
    this.bossDirective = directive;

    if (finished) {
      this.bossFightMemory.delete(key);
      // Vínculo sala→estratégia: ao voltar nesta sala, aplica direto sem re-reconhecer.
      if (!this.bossRoomBindings.has(wram.roomId)) {
        this.bossRoomBindings.set(wram.roomId, directive.strategyId);
      }
      this.pendingLearnedKnowledge.push({
        entityType: this.activeSpecialEntity,
        entityLabel: directive.bossName,
        powerId: directive.strategyId,
        powerName: `${directive.bossName} · ${directive.phaseLabel}`,
        powerEffect: directive.note,
        roomId: wram.roomId,
      });
    }

    return directive;
  }

  /**
   * Traduz a diretiva do codex em teclas reais do SNES.
   * `null` = o codex não mandou sobrescrever (o chamador mantém a heurística).
   */
  private applyBossDirective(
    wram: MetroidWramSnapshot,
    d: BossDirective,
    target: EnemyInfo & { dist: number },
  ): { keys: AIKey[]; tempo: number; sceneLabel: string; reason: string } | null {
    const { shoot: shootKey, jump: jumpKey, run: dashKey, cancel: cancelKey, select: selectKey } = wram.controls;
    const roomWidth = wram.roomWidthPx || 256;
    const half = roomWidth / 2;
    const faceTo: 'LEFT' | 'RIGHT' = target.x >= wram.samusX ? 'RIGHT' : 'LEFT';
    const awayFrom: 'LEFT' | 'RIGHT' = faceTo === 'RIGHT' ? 'LEFT' : 'RIGHT';

    // Vida crítica: nenhum plano de chefe vale apanhar até a morte — recua e dispara para trás.
    const critical = wram.maxHealth > 0 && wram.health > 0 && wram.health < wram.maxHealth * 0.22;

    // 1) Deixar o item certo selecionado no HUD antes de atirar (míssil ≠ super míssil).
    const keys: AIKey[] = [];
    if (d.desiredSlot !== 0 && wram.selectedHudItem !== d.desiredSlot && !this.bossSlotGaveUp) {
      this.bossSelectTicks += 1;
      if (this.bossSelectTicks > 4) {
        // O ciclo de SELECT deu a volta sem achar o índice esperado (HUD customizado):
        // desiste de uma vez e luta com o item que estiver selecionado, sem pingar.
        this.bossSlotGaveUp = true;
        this.bossSelectTicks = 0;
      } else {
        keys.push(selectKey);
        return {
          keys,
          tempo: 110,
          sceneLabel: `Combate · ${d.label}`,
          reason: `Selecionando ${d.ammoLabel} no HUD (slot ${d.desiredSlot}, atual ${wram.selectedHudItem}) · ${d.windowLabel}`,
        };
      }
    } else if (d.desiredSlot === 0 && wram.selectedHudItem !== 0 && !d.note.includes('torre')) {
      this.bossSelectTicks = 0;
      keys.push(cancelKey);
      return {
        keys,
        tempo: 110,
        sceneLabel: `Combate · ${d.label}`,
        reason: `Voltando ao feixe principal (${d.ammoLabel})`,
      };
    } else {
      this.bossSelectTicks = 0;
    }

    // 2) Movimento exigido pela estratégia.
    let step: AIKey | null = null;
    let wantJump = false;
    let jumpHold = 2;
    let wantDash = false;
    switch (d.movement) {
      case 'HOLD_GROUND':
        break;
      case 'DO_NOT_CHASE':
        step = awayFrom;
        wantDash = true;
        break;
      case 'RETREAT_TO_CORNER': {
        const goLeft = wram.samusX < half;
        const atCorner = goLeft ? wram.samusX < 28 : wram.samusX > roomWidth - 28;
        step = atCorner ? null : goLeft ? 'LEFT' : 'RIGHT';
        break;
      }
      case 'PLATFORM_UP':
        step = d.rangeState === 'TOO_FAR' ? faceTo : null;
        wantJump = true;
        jumpHold = 3;
        break;
      case 'AIRBORNE':
        // Space Jump sem dash: correr no ar ligaria o Speed Booster no meio da luta.
        wantJump = true;
        jumpHold = 6;
        break;
      case 'HOP_DODGE':
        wantJump = target.dist < 168 && this.stepIndex % 4 === 0;
        break;
      case 'CHASE':
      case 'APPROACH':
        step = faceTo;
        wantDash = d.movement === 'CHASE' && target.dist > 90;
        wantJump = target.y < wram.samusY - 10;
        break;
      case 'CENTER':
        step = wram.samusX < half - 10 ? 'RIGHT' : wram.samusX > half + 10 ? 'LEFT' : null;
        break;
      case 'PUSH_EAST':
        // Ficar sempre a oeste do chefe para que cada acerto o empurre para leste.
        step = wram.samusX > target.x ? 'LEFT' : d.rangeState === 'TOO_FAR' ? 'RIGHT' : null;
        break;
      case 'AMBUSH': {
        const ax = d.ambush?.active ? d.ambush.x : target.x;
        const dx = ax - wram.samusX;
        step = Math.abs(dx) > 26 ? (dx > 0 ? 'RIGHT' : 'LEFT') : null;
        break;
      }
      case 'KEEP_MID_RANGE':
      default:
        if (d.rangeState === 'TOO_CLOSE') step = awayFrom;
        else if (d.rangeState === 'TOO_FAR') step = faceTo;
        break;
    }
    if (critical) {
      step = awayFrom;
      wantDash = true;
    }
    if (step) keys.push(step);
    if (wantDash && d.movement !== 'AIRBORNE') keys.push(dashKey);

    // 3) Mira no ponto fraco.
    if (
      d.aim === 'UP' ||
      d.aim === 'DIAGONAL_UP' ||
      ((d.aim === 'TOWARD_TARGET' || d.farmFallingProjectiles) && target.y < wram.samusY - 20)
    ) {
      keys.push('UP');
    } else if (d.aim === 'DOWN' || (d.aim === 'TOWARD_TARGET' && target.y > wram.samusY + 34 && d.movement === 'CHASE')) {
      keys.push('DOWN');
    }

    // 4) Finalização secreta: agarrada + Grapple Beam mirado para cima na eletricidade.
    if (d.finisher === 'DRAYGON_GRAPPLE') {
      keys.push('UP');
      keys.push(shootKey);
      return {
        keys,
        tempo: 120,
        sceneLabel: `Combate · ${d.label} · FINALIZAÇÃO SECRETA`,
        reason: 'Torres destruídas e Samus agarrada: puxando pela eletricidade exposta (Grapple Beam)',
      };
    }

    // 5) Fogo com cadência própria do plano (carregar o tiro leva ~3 ticks).
    let wantShoot = d.mayFire && !d.doNotKill;
    if (d.ammo === 'CHARGE_BEAM' && wantShoot) {
      if (this.bossChargeHold < 3) {
        this.bossChargeHold += 1; // segurando o gatilho para carregar
      } else {
        this.bossChargeHold = 0;
        wantShoot = false; // soltar = disparo carregado saindo
      }
    } else {
      this.bossChargeHold = 0;
    }
    if (wantShoot && this.nextShoot(true)) keys.push(shootKey);
    if (this.nextJump(wantJump, jumpHold)) keys.push(jumpKey);

    const roleTag =
      d.role === 'SETUP'
        ? 'preparando'
        : d.role === 'HOLD'
          ? 'sem atacar (evento)'
          : d.role === 'FINISHER'
            ? 'golpe final'
            : 'atacando';
    const sceneLabel = `Combate · ${d.label} · ${roleTag}`;
    const reason = d.rotationNote
      ? `${d.rotationNote} · ${d.windowLabel}`
      : `${d.ammoLabel} no ${d.weakPoint === 'ANY' ? 'alvo' : d.weakPoint.toLowerCase()} · ${d.windowLabel} · ${d.distance}px (dano ${d.damageDealt})`;

    return { keys, tempo: d.tempoMs, sceneLabel, reason };
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

    // Codex de Chefes: reconhece o alvo, aplica o plano do guia e guarda a diretiva do tick.
    const codexPlan = this.planBossFor(
      wram,
      (saxPursuer ?? nearbyEnemy) ?? null,
      coreXStage,
    );
    // SA-X/Core-X/Metroid já têm scripts próprios; o codex entra com munição + janela.
    const codexMayFire = codexPlan ? codexPlan.mayFire : true;

    if (saxPursuer && codexPlan) {
      // O plano do codex para a SA-X já decide fugir × lutar, mirar e selecionar míssil.
      const driven = this.applyBossDirective(wram, codexPlan, saxPursuer);
      if (driven) {
        return this.makeMetroidAction(
          'COMBAT',
          driven.keys,
          driven.tempo,
          'run',
          motionPct,
          driven.sceneLabel,
          driven.reason,
          wram,
          true,
          codexPlan.role !== 'SETUP',
        );
      }
    }

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
      } else if (shouldFireMissile && this.nextShoot(codexMayFire)) {
        keys.push(shootKey);
        this.registerMissileUse();
      } else if (this.nextShoot(codexMayFire)) {
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
      } else if (shouldFireMissile && this.nextShoot(codexMayFire)) {
        keys.push(shootKey);
        this.registerMissileUse();
      } else if (this.nextShoot(codexMayFire)) {
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

    // ---- Chefe canônico: o Codex de Chefes assume munição, mira, posição e timing ----
    // Os scripts próprios de Core-X/Metroid seguem valendo (janela e congelar são deles);
    // para Torizo, Spore Spawn, Kraid, Crocomire, Phantoon, Botwoon, Draygon, Golden Torizo,
    // Ridley e Mother Brain a diretiva do guia substitui a heurística genérica.
    if (codexPlan && coreXStage === null && !isMetroidLarva) {
      const driven = this.applyBossDirective(wram, codexPlan, target);
      if (driven) {
        return this.makeMetroidAction(
          'COMBAT',
          driven.keys,
          driven.tempo,
          'run',
          motionPct,
          driven.sceneLabel,
          driven.reason,
          wram,
          saxPursuer !== null,
          codexPlan.role === 'ATTACK' || codexPlan.role === 'FINISHER',
        );
      }
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
      this.forgiveStall();
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
    this.forgiveStall();
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

    // Cancela arma secundária fora da janela de até 2 disparos de teste.
    // Durante uma luta de chefe a munição é do plano do codex: cancelar ali troca de arma
    // a cada tick e o agente nunca descarrega o Super Míssil na hora certa.
    if (
      !this.bossEngagedThisTick &&
      wram.selectedHudItem !== 0 &&
      // o driver de slot é dono da seleção: enquanto um pedido está armado (SELECT girado à
      // espera do HUD bater), desfazer aqui devolvia o tiro para o feixe e a porta não abria
      !this.guardian.slots.armed(this.stepIndex) &&
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
      this.forgiveStall();
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
      // o veto de ping-pong precisa valer também aqui: `navTarget` é filtrado, mas a lista de
      // portas-alvo da sala é o que realmente guia o passo — filtrar só o alvo deixava ela andar
      // até o batente proibido do mesmo jeito e atravessar (foi o que o playtest mostrou: o laço
      // apenas mudou de par de salas, 0x8B7D/0x8BBB → 0x8BF9/0x8C37)
      const linkedRoom = currNode.doorLinks.get(d.key);
      if (linkedRoom !== undefined && linkedRoom !== wram.roomId && this.bounceBanned(wram.roomId, linkedRoom)) {
        continue;
      }

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
    // rota vinda do grafo + da leitura do mapa: porta do plano tem prioridade máxima,
    // porta que não abre agora (cor/munição) sai do caminho
    this.applyNavBiasToDoorTargets(wram, doorTargets);

    let pathStep = this.planPathInRoom(wram, doorTargets);
    // veto de chegada: o plano não pode ser "voltar pela porta por onde ela acabou de entrar"
    if (
      pathStep &&
      this.entryCalm &&
      this.stepIndex < this.entryCalm.until &&
      this.entryCalm.roomId === wram.roomId &&
      pathStep.dir === this.entryCalm.forbid &&
      Math.hypot(wram.samusX - this.entryCalm.x, wram.samusY - this.entryCalm.y) < 88
    ) {
      pathStep = null;
    }
    if (this.entryCalm && this.stepIndex >= this.entryCalm.until) this.entryCalm = null;
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

    // Lava primeiro: o chão pode parecer sólido no mapa de blocos e o roteiro da sala pode
    // mandar para dentro do lago. Nenhuma outra decisão de andar acontece antes deste guard.
    const lavaEdge = this.lavaEdgeInfo(wram, samusBx, samusBy, pathStep?.dir ?? this.moveDir);
    if (lavaEdge) {
      return this.makeMetroidAction(
        'EXPLORE',
        lavaEdge.keys,
        120,
        'run',
        motionPct,
        'Exploração · Beira de lava',
        `Sala 0x${wram.roomId.toString(16).toUpperCase()} (${wram.samusX},${wram.samusY}) · ${lavaEdge.reason}`,
        wram,
      );
    }

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
        // Se a cor da comporta diz que o preço é munição que não temos, nem testar:
        // isso deixa a sala para o backlog e o agente volta quando tiver o item.
        const cantPay = targetDoor ? !this.navDoorAffordable(wram, targetDoor.key) : false;
        const useMissile = this.shouldUseMissile(
          wram,
          null,
          false, // não é boss na exploração
          isBlockedDoor,
          false, // não é entidade especial na exploração
        );

        if (useMissile && !cantPay) {
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
        this.forgiveStall();
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
      if (nearDoor && targetDoor) {
        const attemptKey = `${wram.roomId}:${targetDoor.key}`;
        this.doorAttempt = { key: attemptKey, ticks: this.doorAttempt.key === attemptKey ? this.doorAttempt.ticks + 1 : 1 };
        // 120 ticks (~15 s de jogo a 8 decisões/s) cobrem com folga o scroll de abertura + 3
        // projéteis + uma volta de slot. Passou disso, a premissa "esta porta abre agora" caiu.
        if (this.doorAttempt.ticks === 120) {
          const rec = this.getOrCreateRoom(wram.roomId).doors.get(targetDoor.key);
          if (rec) rec.locked = true;
          this.doorAttempt = { key: '', ticks: 0 };
          this.activeDoorKey = null;
          this.moveDir = this.moveDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
          this.anchorX = wram.samusX;
          this.anchorY = wram.samusY;
          this.forgiveStall();
          this.forceMapReadTicks = 12;
          this.replan(wram);
          return this.makeMetroidAction(
            'EXPLORE',
            [this.moveDir, dashKey],
            150,
            'run',
            motionPct,
            'Exploração · Porta desistida',
            '120 ticks na soleira sem a porta abrir · marcada como trancada e rota refeita',
            wram,
          );
        }
      } else if (this.doorAttempt.ticks > 0) {
        this.doorAttempt = { key: '', ticks: 0 };
      }
      const floorBelowT = this.resolveBlockType(wram, samusBx, samusBy + 1);
      const bombFloorUnderFoot =
        (pathStep.bomb || (pathStep.drop && floorBelowT === 0xf)) &&
        Math.abs(wram.samusX - wpX) <= 14 &&
        (isGrounded || (this.sameYStreak >= 1 && Math.abs(this.samusVy) <= 1)) &&
        (wram.itemsMask & 0x1004) === 0x1004;

      // CORREÇÃO: Porta acima (UP) — mirar para cima e atirar antes de pular/entrar
      const isUpDoor = targetDoor ? targetDoor.side === 'UP' : false;
      if (isUpDoor && nearDoor) {
        const loadout = this.getAgentLoadout(wram);
        const doorColor = this.navDoorColors.get(`${wram.roomId}:${targetDoor.key}`) ?? 'UNKNOWN';
        const gate = gateForDoor(doorColor, targetDoor.blockedByWall);
        const gateCheck = checkGate(gate, this.navLoadoutView(wram));
        const needsAmmoNow = gate.needsAmmoNow && gate.need !== 'NONE' && gate.need !== 'UNKNOWN';
        const canAfford = gateCheck.openableNow || gate.need === 'BOMB_OR_BEAM';
        const keys: AIKey[] = [];

        // 1) Selecionar munição adequada se a porta precisa e não está selecionada. Comporta
        // verde é SUPER míssil (slot 2) e amarela é power bomb (slot 3) — um toque só de SELECT
        // nunca chega lá, e o tiro saía com o feixe (que é o "gastei 30 tiros e nada" do
        // relatório). O driver gira até o slot certo e desiste se o HUD não tiver a casa.
        const slot = this.slotPlanFor(wram, gate.need);
        if (needsAmmoNow && !canAfford && (slot.tap || slot.restore)) {
          keys.push(slot.tap ? selectKey : wram.controls.cancel);
          return this.makeMetroidAction(
            'EXPLORE',
            [...keys, 'UP'],
            110,
            'run',
            motionPct,
            'Exploração · Porta acima · selecionar munição',
            `Porta acima (${doorColor}) · ${slot.why}`,
            wram,
          );
        }

        // 2) Mirar para cima e atirar na porta
        keys.push('UP');
        if (
          (gate.need === 'MISSILES' && loadout.missileCount >= gate.amount) ||
          (gate.need === 'SUPERS' && loadout.superCount >= gate.amount) ||
          (gate.need === 'POWER_BOMBS' && loadout.powerBombCount >= gate.amount) ||
          gate.need === 'BOMB_OR_BEAM' ||
          gate.need === 'NONE' ||
          gate.need === 'UNKNOWN'
        ) {
          if (this.nextShoot(true)) {
            keys.push(shootKey);
            if (gate.need === 'MISSILES' || gate.need === 'SUPERS' || gate.need === 'POWER_BOMBS') {
              this.registerMissileUse();
            }
          }
        }

        // 3) Após mirar/atirar, preparar pulo para entrar na porta
        if (this.nextJump(true, 3)) {
          keys.push(jumpKey);
        }

        return this.makeMetroidAction(
          'EXPLORE',
          keys,
          125,
          'run',
          motionPct,
          'Exploração · Porta acima · mirar e atirar',
          `Porta acima (${targetDoor.key}) · mirando para cima e atirando antes de pular`,
          wram,
        );
      }

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

    // Evita andar para dentro de perigo óbvio detectado por cor (espinho/lava)
    // quando WRAM não está disponível para dizer onde está o chão seguro.
    const dangerAhead = this.lastCapturedFrame && detectDangerColor(this.lastCapturedFrame, this.moveDir);
    if (dangerAhead) {
      const oppDir: 'LEFT' | 'RIGHT' = this.moveDir === 'RIGHT' ? 'LEFT' : 'RIGHT';
      this.moveDir = oppDir;
      const keys: AIKey[] = [oppDir, 'B'];
      if (this.nextJump(true, 4)) keys.push('A');
      this.currentMode = 'EXPLORE';
      return {
        key: keys[0],
        keys,
        time: 150,
        phase: 'run',
        motionPct,
        sceneLabel: 'Exploração · Perigo detectado',
        reason: 'Perigo à frente (espinho/lava) · inverte direção e salta',
        snapshot: buildVisualSnapshot('EXPLORE', keys, 'Exploração · Perigo detectado', 'Inverte direção por perigo visual'),
      };
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
