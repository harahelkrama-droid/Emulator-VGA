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
  | 'SAX_MONSTER';

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

export interface AIStatusSnapshot {
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
  supers?: number;
  powerBombs?: number;
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
