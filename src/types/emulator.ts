export interface GameItem {
  title: string;
  file: string;
  cover?: string;
  description?: string;
  isLocalBlob?: boolean;
}

export type AIKey =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'A'
  | 'B'
  | 'X'
  | 'Y'
  | 'L'
  | 'R'
  | 'START'
  | 'SELECT'
  | 'NONE';

export type AIEngine = 'local-vision' | 'ollama' | 'gemini';
export type AIProfile = 'action' | 'rpg';
export type AIPhase = 'menu' | 'run' | 'win' | 'missing' | 'unsure';

export type AgentBehaviorMode =
  | 'MENU'
  | 'CUTSCENE'
  | 'EXPLORE'
  | 'COLLECT'
  | 'COMBAT'
  | 'BACKTRACK'
  | 'EVADE_SAX';

export type USearchPhase = 'NONE' | 'BACKSTEP' | 'ASCEND' | 'DESCEND';

export type SpecialEntityType =
  | 'NONE'
  | 'OMEGA_INTRO'
  | 'SAX_VARIA'
  | 'SAX_GRAVITY'
  | 'CORE_X_SILVER'
  | 'CORE_X_YELLOW'
  | 'CORE_X_RED'
  | 'CORE_X_NAKED'
  | 'METROID_LARVA'
  | 'BIG_METROID'
  | 'SAX_MONSTER'
  | 'MISSION_PROGRESS';

export type CoreXStage = 'NORMAL' | 'AMARELO' | 'VERMELHO' | 'PODER_EXPOSTO';

export interface EncounterKnowledgeRecord {
  id: string;
  game: string;
  entityType: SpecialEntityType;
  entityLabel: string;
  powerId: string;
  powerName: string;
  powerEffect: string;
  roomId: number;
  defeatedCount: number;
  observedAt: number;
}

export type EquipmentPieceCategory = 'armor' | 'mobility' | 'beam';

export interface EquipmentPieceStatus {
  id: string;
  name: string;
  category: EquipmentPieceCategory;
  collected: boolean;
  equipped: boolean;
  note: string;
}

export interface ArmorAnalysis {
  suitTier: 'Fusion Suit (Base)' | 'Varia Suit' | 'Gravity Suit';
  damageReductionPct: number;
  thermalProtected: boolean;
  liquidMobility: boolean;
  effectiveHp: number;
  energyTanks: number;
  reserveEnergy: number;
  reserveMax: number;
  reserveMode: 'Desativado' | 'Automático' | 'Manual';
  collectedCount: number;
  equippedCount: number;
  totalPieces: number;
  missingPieces: string[];
  unequippedCollected: string[];
  saxReadinessPct: number;
  pieces: EquipmentPieceStatus[];
}

/** Estado da luta contra chefe, conforme o Codex de Chefes (`src/lib/bossCodex.ts`). */
export interface BossFightStatus {
  strategyId: string;
  bossName: string;
  encounter: string;
  phaseLabel: string;
  weakPoint: string;
  ammo: string;
  ammoLabel: string;
  /** SETUP = preparando (farmar/abrir janela) · ATTACK = dano · HOLD = não atacar · FINISHER = golpe secreto. */
  role: 'SETUP' | 'ATTACK' | 'HOLD' | 'FINISHER';
  movement: string;
  aim: string;
  windowOpen: boolean;
  windowLabel: string;
  mayFire: boolean;
  distance: number;
  rangeState: 'TOO_CLOSE' | 'IN_RANGE' | 'TOO_FAR';
  hpPct: number;
  damageDealt: number;
  hits: number;
  /** O prior do guia não estava ferindo e a munição foi trocada por evidência. */
  rotated: boolean;
  rotationNote: string | null;
  /** O plano do guia não estava ferindo e o agente caiu para sondagem de munição. */
  probeMode: boolean;
  /** Poder do Core-X exposto: parar de atirar e ir coletar. */
  collectWhenExposed: boolean;
  /** Chefe é evento roteirizado: não deve ser morto (ex.: Ridley prólogo, Omega). */
  doNotKill: boolean;
  /** Deixe o inimigo drenar vida/habilidade em vez de atacá-lo (ex.: Metroid Grande). */
  letDrain: boolean;
  note: string;
  source: string;
  summary: string;
}

export interface AIStatusSnapshot {
  bossFight?: BossFightStatus;
  mode: AgentBehaviorMode;
  behaviorLabel: string;
  uSearchPhase?: USearchPhase;
  keys: AIKey[];
  sceneLabel: string;
  reason: string;
  health?: number;
  maxHealth?: number;
  reserveEnergy?: number;
  reserveMax?: number;
  missiles?: number;
  maxMissiles?: number;
  supers?: number;
  maxSupers?: number;
  powerBombs?: number;
  maxPowerBombs?: number;
  roomId?: number;
  abilities: string[];
  pendingBacktracks: number;
  saxThreat: boolean;
  saxCombatReady: boolean;
  ignoredBackgroundCount?: number;
  armorAnalysis?: ArmorAnalysis;
  detectedEntity?: SpecialEntityType;
  detectedEntityLabel?: string;
  coreXStage?: CoreXStage | null;
  countdownActive?: boolean;
  countdownSeconds?: number;
  energyResetDetected?: boolean;
  // Sistema de loadout: habilidades, armadura e ferramentas do agente
  agentLoadout?: {
    totalAbilities: number;
    energyTanks: number;
    missileCount: number;
    superCount: number;
    powerBombCount: number;
    hasVaria: boolean;
    hasGravity: boolean;
    hasMorphBall: boolean;
    hasBombs: boolean;
    hasHiJump: boolean;
    hasSpringBall: boolean;
    hasSpeedBooster: boolean;
    hasSpaceJump: boolean;
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
  };
  // Sistema de exploração do mapa
  mapExploration?: {
    roomsExplored: number;
    mapFullyExplored: boolean;
    /** veredicto do detector de "estou perdido" */
    lost: boolean;
    lostCause: string | null;
    lostNote: string;
    /** 0..3 — 2+ dispara a consulta do mapa do jogo (START) */
    lostSeverity: number;
    /** última leitura da tela de mapa */
    mapRead: {
      ok: boolean;
      coveragePct: number;
      hint: string | null;
      hintDir: string | null;
      note: string;
      ageTicks: number;
    } | null;
    /** próximo alvo escolhido no grafo de salas */
    target: {
      kind: string;
      label: string;
      reason: string;
      route: string[];
      firstDoor: string | null;
      roomId: number;
    } | null;
    /** portas que faltam habilidade/munição — o "volta depois" */
    backlog: Array<{ roomId: number; doorKey: string; need: string; missing: string }>;
    /** checklist do objetivo (tanques, expansões, chefes, terminais) */
    checklist: Array<{
      id: string;
      label: string;
      kind: string;
      have: number;
      total: number;
      done: boolean;
      note: string;
    }>;
    checklistSummary: string;
    navSummary: string;
    preferredDirection: string | null;
    /** chão hostil da sala atual, reconhecido no frame (lava não é bloco no SM) */
    floorHazard: 'LAVA' | 'LAVA_PROBE' | 'NONE';
    completionProfile?: 'vanilla' | 'xfusion';
    /** linha (em blocos da sala) onde o lago começa; -1 = sem lago */
    lavaTopRow: number;
    /** corte atual do detector de lava (muda sozinho quando a IA erra e o frame separa) */
    lavaCalib: { minRed: number; maxGreen: number; minRun: number };
    /** o que a IA diagnosticou no próprio erro e o que mudou por causa disso */
    corrections: Array<{
      id: number;
      kind: string;
      scope: string;
      diagnosis: string;
      action: string;
      status: 'ACTIVE' | 'HELPED' | 'REVERTED';
    }>;
    /** portas da sala atual com a cor reconhecida no frame (base da decisão de abrir/voltar) */
    currentRoomDoors: Array<{ key: string; color: string; closed: boolean }>;
  };
  /** camada de verificação (`src/lib/actionGuardian.ts`): apostas, travamento e degrau de escape */
  guardian?: {
    stallTicks: number;
    roomTicks: number;
    severity: number;
    pushDir: string | null;
    pinnedEdge: 'LEFT' | 'RIGHT' | null;
    escapeRung: 'NONE' | 'NUDGE' | 'REVERSE_PUSH' | 'SWEEP' | 'MAP_READ' | 'BLOCK_ROOM';
    escapeStep: number;
    deadHypotheses: number;
    hypotheses: Array<{ key: string; kind: string; attempts: number; failures: number; status: string; note: string }>;
    jump: { holdFrames: number; gapPx: number };
    slot: { taps: number; gaveUp: boolean; ownedSlots: number };
    lockedTarget: number | null;
    /** tentativa de porta: há quantos ticks ela está na soleira desta porta (limite = budget) */
    doorAttempt: { doorKey: string; ticks: number; budget: number };
    inventoryTrusted: boolean;
    inventoryIssue: string | null;
  };
  // Sistema de interação com objetos/terminal/energia
  interaction?: {
    nearbyObjects: Array<{
      type: string;
      x: number;
      y: number;
      priority: number;
      interacted: boolean;
    }>;
    currentTarget: string | null;
    powerAuxActivated: boolean;
    roomsWithPowerIssue: number;
    stuckInRoomTicks: number;
  };
}

export interface AIAction {
  key: AIKey;
  keys?: AIKey[];
  time: number;
  phase: AIPhase;
  reason?: string;
  question?: string;
  motionPct?: number;
  sceneLabel?: string;
  snapshot?: AIStatusSnapshot;
  learnedKnowledge?: Array<
    Omit<EncounterKnowledgeRecord, 'id' | 'game' | 'defeatedCount' | 'observedAt'>
  >;
}

export interface CapturedFrame {
  base64Jpeg: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  signature: string;
  source: 'gameManager.screenshot' | 'canvas.drawImage';
  fresh?: boolean;
}

export interface SaveSlotSummary {
  slot: 1 | 2;
  savedAt: number | null;
  byteLength: number;
}
