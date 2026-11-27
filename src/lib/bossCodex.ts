/**
 * # Codex de Chefes (BossCodex)
 *
 * Base de conhecimento declarativa sobre **como** vencer cada chefe de Super Metroid /
 * *Super Metroid: X-Fusion*, derivada do guia estratégico do projeto.
 *
 * O módulo é **puro**: não importa React, não lê memória e não toca o emulador. Recebe
 * uma *observação* (montada pelo `LocalVisionAgent` a partir da WRAM + do frame) e devolve
 * uma **diretiva**. Quem traduz diretiva em teclas é `applyBossDirective` em `localVisionAI.ts`.
 *
 * ## Prior + verificação empírica
 * As regras abaixo são *priors*: munição provável, ponto fraco, posicionamento e a janela
 * de vulnerabilidade. O agente não acredita cegamente nelas — ele mede o **dano real por
 * tipo de munição** (`evidence`) e rotaciona para a próxima alternativa da fila se o prior
 * não estiver ferindo. Isso cobre os dois modos de falha:
 *
 * - prior errado (chefe mal reconhecido) → degrada para o comportamento heurístico anterior;
 * - sensor de janela otimista/depusiado → `blindFireAfterTicks` libera o fogo às cegas.
 *
 * Chefes em que HP não é a condição de vitória (Crocomire morre ao bater na parede de
 * espinhos; Metroid Grande é evento) usam `expectHpDamage: false`, o que desliga a rotação
 * por evidência — senão o agente concluiria que a estratégia certa está "errada".
 *
 * ## Modelo de uma fase
 * ```
 * janela FECHADA  →  ammoWhileClosed + movementWhileClosed   (preparação: farmar esporo,
 *                                                            mirar no olho, congelar)
 * janela ABERTA   →  ammo + movement                          (dano real: super no núcleo)
 * ```
 */

// ---------------------------------------------------------------------------
// Vocabulário
// ---------------------------------------------------------------------------

/** Canais de cor medidos por `sampleEnemyVisuals` sobre o retângulo do inimigo. */
export type SpriteChannel =
  | 'red'
  | 'yellowGreen'
  | 'silverCyan'
  | 'gold'
  | 'purple'
  | 'orange'
  | 'neonGreen';

export type BossColors = Partial<Record<SpriteChannel, number>>;

/** Armas que o agente sabe acionar. Feixe = equipamento; míssil = slot do HUD. */
export type BossAmmo =
  | 'BASIC_BEAM'
  | 'CHARGE_BEAM'
  | 'WAVE_BEAM'
  | 'ICE_BEAM'
  | 'SPAZER_BEAM'
  | 'PLASMA_BEAM'
  | 'MISSILE'
  | 'SUPER_MISSILE'
  | 'POWER_BOMB'
  | 'GRAPPLE_FINISH'
  | 'HYPER_BEAM';

/**
 * Slot do item selecionado no HUD da Samus ($7E:09d2), na ordem do ciclo de SELECT:
 * 0 = feixe puro · 1 = mísseis · 2 = super mísseis · 3 = bomba/grapple.
 * O agente pressiona SELECT até o índice bater e desiste (voltando ao feixe) se
 * divergir — o custo de errar é uma pressionada a mais, não ficar preso selecionando.
 */
export type HudAmmoSlot = 0 | 1 | 2 | 3;

export type BossMovement =
  | 'HOLD_GROUND' // planta o pé e só atira
  | 'KEEP_MID_RANGE' // respeita keepDistancePx
  | 'RETREAT_TO_CORNER' // vai para o canto seguro
  | 'APPROACH' // encosta (poucos casos)
  | 'CHASE' // persegue o alvo
  | 'PLATFORM_UP' // sobe nas plataformas
  | 'AIRBORNE' // fica no ar (space jump)
  | 'HOP_DODGE' // pulos ritmados contra ondas/projéteis
  | 'CENTER' // fica no meio da sala
  | 'PUSH_EAST' // acompanha empurrando para a direita
  | 'AMBUSH' // espera no último ponto conhecido
  | 'DO_NOT_CHASE'; // só se defender

export type BossAim = 'NEUTRAL' | 'UP' | 'DIAGONAL_UP' | 'DOWN' | 'TOWARD_TARGET';

/** Sensor que estima "o ponto fraco está exposto agora". */
export type BossWindow =
  | { kind: 'ALWAYS'; label: string }
  | { kind: 'COLOR_RISE'; channel: SpriteChannel; minDelta: number; label: string }
  | { kind: 'COLOR_ABOVE'; channel: SpriteChannel; min: number; label: string }
  | { kind: 'COLOR_FALL'; channel: SpriteChannel; minDelta: number; label: string }
  | { kind: 'HITBOX_GROW'; axis: 'x' | 'y'; minPx: number; label: string }
  | { kind: 'HP_FALLING'; label: string }
  | { kind: 'ANY'; sensors: BossWindow[]; label: string };

/** Portão contextual que precede a regra de HP na escolha de fase. */
export type BossGate =
  | 'ANY'
  | 'FIGHTABLE' // agente julga que dá para brigar (ex.: loadout pronto p/ SA-X)
  | 'NOT_FIGHTABLE'
  | 'STATIONS_UNDONE'
  | 'STATIONS_DONE'
  | 'AFTER_CUTSCENE'
  | 'CORE_EXPOSED';

export interface BossSignature {
  minHp?: number;
  maxHp?: number;
  minSpanX?: number;
  minSpanY?: number;
  maxSpanX?: number;
  mobility?: 'STATIONARY' | 'ROAMING' | 'EITHER';
  colorAtLeast?: Array<{ channel: SpriteChannel; min: number }>;
  colorBelow?: Array<{ channel: SpriteChannel; max: number }>;
  /** Entidades já classificadas pelo agente (X-Fusion). */
  entity?: string[];
}

export interface BossPhasePlan {
  id: string;
  label: string;
  /** Ativa enquanto `hpPct > fromHpPct`. Ausente = sem restrição de HP. */
  fromHpPct?: number;
  /** Ativa só a partir de N ticks de luta (para chefes que não perdem HP). */
  fromTicks?: number;
  /** Portão contextual: vence `fromHpPct` quando bate. */
  gate?: BossGate;
  weakPoint:
    | 'ANY'
    | 'CHEST'
    | 'EYES'
    | 'MOUTH'
    | 'INNER_CORE'
    | 'HEAD'
    | 'BELLY'
    | 'CENTRAL_EYE'
    | 'GLASS_TANK'
    | 'BRAIN'
    | 'EXPOSED_CORE';
  /** Munição preferida com a janela aberta. A 1ª que ferir (e existir) vence. */
  ammo: BossAmmo[];
  /** O que fazer enquanto a janela está fechada (preparar/farmar/abrir a janela). */
  ammoWhileClosed?: BossAmmo[];
  movementWhileClosed?: BossMovement;
  /** Nunca usar — faz o chefe entrar em fúria ou rebater o projétil. */
  forbidden?: BossAmmo[];
  /** Proibição condicional a uma regra de contexto. */
  forbiddenWhen?: { when: 'BOSS_STATIONARY' | 'SAMUS_GRABBED' | 'LOW_SAMUS_HP'; ammo: BossAmmo[] };
  /** Exige o feixe realmente selecionado no menu ($7E:09a6). */
  requireBeam?: 'ICE' | 'PLASMA' | 'WAVE' | 'SPAZER';
  window?: BossWindow;
  /** Ticks sem confirmar a janela após os quais atira mesmo assim. */
  blindFireAfterTicks?: number;
  movement?: BossMovement;
  aim?: BossAim;
  keepDistancePx?: [number, number];
  tempoMs?: number;
  /** false = o objetivo não é tirar HP (empurrão, evento roteirizado). */
  expectHpDamage?: boolean;
  /** true = munição pesada só sai com a janela aberta (economiza). */
  heavyOnlyInWindow?: boolean;
  note: string;
}

export interface BossStrategy {
  id: string;
  name: string;
  encounter: string;
  signature: BossSignature;
  phases: BossPhasePlan[];
  special?: {
    /** Não tentar matar (Ridley do prólogo foge sozinho). */
    doNotKill?: boolean;
    /** HP da Samus em que o evento roteirizado dispara (Ridley Ceres: 29). */
    escapeTriggerSamusHp?: number;
    finisher?: 'DRAYGON_GRAPPLE';
    subTargets?: 'DRAYGON_POWER_STATIONS';
    /** Deixar o Metroid Grande drenar (gatilho canônico do resgate). */
    letDrain?: boolean;
    /** Emboscar o último buraco por onde a cabeça saiu (Botwoon). */
    ambushLastKnownPosition?: boolean;
    /** Atirar nos esporos/bombas que caem para recuperar vida e munição. */
    farmFallingProjectiles?: boolean;
    /** Parar de atirar e ir buscar o núcleo (Core-X). */
    collectWhenExposed?: boolean;
  };
  /** De onde vem o conhecimento, para o painel. */
  source: string;
}

// ---------------------------------------------------------------------------
// Observação / loadout / memória
// ---------------------------------------------------------------------------

export interface BossObservation {
  hp: number;
  spanX: number;
  spanY: number;
  /** Deslocamento acumulado do chefe (0 ≈ enraizado). */
  movedPx: number;
  /** Cores amostradas no retângulo do chefe (null se o frame não serve). */
  colors: BossColors | null;
  /** Rótulo de entidade especial já classificado pelo agente. */
  entity?: string;
  samusHp: number;
  samusMaxHp: number;
  countdownActive: boolean;
  /** Portas da sala que ainda abrem (0 = preso na sala com o chefe). */
  openExits: number;
  /** Samus imóvel levando dano (Draygon agarrando). */
  grabbedImmobilized: boolean;
  bossStationary: boolean;
  stationsDestroyed: number;
  resumedAfterCutscene: boolean;
  /** O agente julga que dá para lutar (ex.: `isReadyToFightSAX`). */
  fightable: boolean;
  /** Core-X com o núcleo de poder exposto (parar de atirar e ir coletar). */
  coreExposed: boolean;
  /** Prólogo de Ceres: Power Suit ainda não reconstruído. */
  prologueState: boolean;
}

export interface LoadoutView {
  hasMissiles: boolean;
  missileCount: number;
  hasSupers: boolean;
  superCount: number;
  hasPowerBombs: boolean;
  powerBombCount: number;
  hasChargeBeam: boolean;
  hasIceBeam: boolean;
  hasWaveBeam: boolean;
  hasSpazerBeam: boolean;
  hasPlasmaBeam: boolean;
  beamsEquippedMask: number;
  hasGrapple: boolean;
  hasSpaceJump: boolean;
  hasScrewAttack: boolean;
  hasVaria: boolean;
  hasGravity: boolean;
}

/** Memória por luta — o agente guarda um registro por slot de inimigo. */
export interface BossFightMemory {
  strategyId: string;
  phaseId: string;
  ticksInFight: number;
  ticksInPhase: number;
  peakHp: number;
  lastHp: number;
  lastSpanX: number;
  lastSpanY: number;
  totalDamageDealt: number;
  hitsLanded: number;
  evidence: Partial<Record<BossAmmo, { probes: number; damage: number }>>;
  currentAmmo: BossAmmo | null;
  smoothedColors: BossColors | null;
  lastSeenX: number;
  lastSeenY: number;
  targetVisible: boolean;
  ticksSinceVisible: number;
  windowOpenTicks: number;
  ticksSinceWindowOpen: number;
  freeTicks: number;
  finisherAttempted: boolean;
  rotations: number;
  defeated: boolean;
  /** true quando o plano do guia foi abandonado por não ferir: modo "caçar a munição que fere". */
  probeMode: boolean;
  /** Sala da luta (para o vínculo sala→estratégia quando o chefe morre). */
  roomId: number;
  /** Ticks com o alvo ausente da sala (morte = slot zerado pelo jogo). */
  goneTicks: number;
  /** Rótulos preservados para o registro de conhecimento. */
  bossName: string;
  phaseLabel: string;
  note: string;
  entityType: string;
}

export interface BossFightInput {
  observation: BossObservation;
  /** Sala atual — usada para vincular estratégia vencida ao quarto. */
  roomId: number;
  /** Rótulo de entidade especial do frame atual (Core-X, SA-X...). */
  entityType?: string;
  loadout: LoadoutView;
  /** Estratégia forçada por vínculo de sala aprendido antes. */
  boundStrategyId: string | null;
  /** Memória anterior; ausente = começou agora. */
  memory: BossFightMemory | null;
  targetX: number;
  targetY: number;
  samusX: number;
  samusY: number;
}

export type BossRole = 'SETUP' | 'ATTACK' | 'FINISHER' | 'HOLD';

export interface BossDirective {
  strategyId: string;
  bossName: string;
  encounter: string;
  phaseId: string;
  phaseLabel: string;
  note: string;
  source: string;
  role: BossRole;
  ammo: BossAmmo;
  /** Slot de HUD que o agente precisa deixar selecionado. */
  desiredSlot: HudAmmoSlot;
  ammoLabel: string;
  aim: BossAim;
  movement: BossMovement;
  keepDistance: [number, number];
  distance: number;
  rangeState: 'TOO_CLOSE' | 'IN_RANGE' | 'TOO_FAR';
  tempoMs: number;
  windowOpen: boolean;
  windowLabel: string;
  mayFire: boolean;
  conserveHeavyAmmo: boolean;
  requireBeam: 'ICE' | 'PLASMA' | 'WAVE' | 'SPAZER' | null;
  rotated: boolean;
  rotationNote: string | null;
  doNotKill: boolean;
  farmFallingProjectiles: boolean;
  ambush: { active: boolean; x: number; y: number } | null;
  finisher: 'DRAYGON_GRAPPLE' | null;
  subTargets: 'DRAYGON_POWER_STATIONS' | null;
  letDrain: boolean;
  collectWhenExposed: boolean;
  weakPoint: BossPhasePlan['weakPoint'];
  hpPct: number;
  /** O plano do guia foi abandonado por não ferir. */
  probeMode: boolean;
  damageDealt: number;
  hits: number;
  label: string;
}

export interface BossPlanResult {
  directive: BossDirective;
  memory: BossFightMemory;
  finished: boolean;
}

// ---------------------------------------------------------------------------
// O codex
// ---------------------------------------------------------------------------

/** Abre aspas de contexto para a UI: nada aqui é chutado, vem do guia. */
export const BOSS_STRATEGIES: BossStrategy[] = [
  {
    id: 'ridley-ceres',
    name: 'Ridley',
    encounter: 'Prólogo — Estação Ceres',
    source: 'guia estratégico · item 1',
    signature: { minHp: 150, mobility: 'ROAMING', colorAtLeast: [{ channel: 'red', min: 0.04 }] },
    special: { doNotKill: true, escapeTriggerSamusHp: 29 },
    phases: [
      {
        id: 'harass',
        label: 'Atrito até ele fugir',
        weakPoint: 'HEAD',
        // Míssil aqui é desperdício: ele não morre nesta luta.
        ammo: ['CHARGE_BEAM', 'BASIC_BEAM', 'SPAZER_BEAM'],
        forbidden: ['SUPER_MISSILE'],
        window: { kind: 'ALWAYS', label: 'sempre atirando' },
        movement: 'KEEP_MID_RANGE',
        aim: 'DIAGONAL_UP',
        keepDistancePx: [64, 220],
        tempoMs: 120,
        note: 'Atirar para cima/diagonal desviando da cauda e das bolas de fogo. Não dá para matá-lo: com dano suficiente (ou vida da Samus em ~29) ele foge e liga a contagem de 60 s.',
      },
    ],
  },
  {
    id: 'torizo',
    name: 'Torizo',
    encounter: 'Estátua Chozo — Brinstar',
    source: 'guia estratégico · item 2',
    signature: {
      minHp: 300,
      minSpanX: 12,
      minSpanY: 16,
      // Torizo é esguio comparado aos chefes enraizados gigantes (60-80 px).
      maxSpanX: 40,
      mobility: 'EITHER',
      colorAtLeast: [{ channel: 'gold', min: 0.02 }],
      colorBelow: [{ channel: 'neonGreen', max: 0.05 }],
    },
    special: { farmFallingProjectiles: true },
    phases: [
      {
        id: 'chest',
        label: 'Mísseis no peito brilhante',
        weakPoint: 'CHEST',
        ammo: ['MISSILE', 'SUPER_MISSILE', 'CHARGE_BEAM'],
        ammoWhileClosed: ['MISSILE', 'CHARGE_BEAM'],
        window: {
          kind: 'ANY',
          label: 'peito brilhando',
          sensors: [
            { kind: 'COLOR_ABOVE', channel: 'gold', min: 0.09, label: 'peito dourado aceso' },
            { kind: 'HP_FALLING', label: 'dano entrando no peito' },
          ],
        },
        blindFireAfterTicks: 14,
        movement: 'HOP_DODGE',
        aim: 'NEUTRAL',
        keepDistancePx: [56, 150],
        tempoMs: 120,
        note: 'Segurar mísseis (ou tiros carregados) no peito brilhante, pulando as ondas de energia. Atirar nas bombas que ele lança devolve vida e munição.',
      },
    ],
  },
  {
    id: 'spore-spawn',
    name: 'Spore Spawn',
    encounter: 'Subterrâneo de Brinstar',
    source: 'guia estratégico · item 3',
    signature: {
      minHp: 200,
      minSpanX: 36,
      mobility: 'STATIONARY',
      colorAtLeast: [{ channel: 'yellowGreen', min: 0.06 }],
      // Planta enorme: sem dourado (Torizo/Crocomire) e sem roxo (Phantoon).
      colorBelow: [
        { channel: 'gold', max: 0.05 },
        { channel: 'purple', max: 0.08 },
      ],
    },
    special: { farmFallingProjectiles: true },
    phases: [
      {
        id: 'shell',
        label: 'Esperar o casco abrir',
        weakPoint: 'INNER_CORE',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        // Com o casco fechado: canto seguro + farmar esporos caindo.
        ammoWhileClosed: ['BASIC_BEAM', 'WAVE_BEAM', 'SPAZER_BEAM'],
        movementWhileClosed: 'RETREAT_TO_CORNER',
        window: {
          kind: 'ANY',
          label: 'casco aberto',
          sensors: [
            { kind: 'COLOR_ABOVE', channel: 'orange', min: 0.12, label: 'núcleo alaranhado visível' },
            { kind: 'COLOR_RISE', channel: 'orange', minDelta: 0.03, label: 'laranja subiu de repente' },
          ],
        },
        blindFireAfterTicks: 16,
        movement: 'HOLD_GROUND',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [30, 150],
        tempoMs: 125,
        heavyOnlyInWindow: true,
        note: 'Ficar num canto inferior (o balanço raramente acerta) e atirar nos esporos que caem para repor munição. Quando ele parar de balançar e abrir o casco, descarregar Super Mísseis no núcleo laranja.',
      },
    ],
  },
  {
    id: 'kraid',
    name: 'Kraid',
    encounter: 'Norfair',
    source: 'guia estratégico · item 4',
    signature: {
      minHp: 400,
      minSpanX: 44,
      minSpanY: 40,
      mobility: 'EITHER',
      colorAtLeast: [{ channel: 'yellowGreen', min: 0.03 }],
      colorBelow: [{ channel: 'purple', max: 0.08 }],
    },
    phases: [
      {
        id: 'eyes-mouth',
        label: 'Olhos → Super Míssil na garganta',
        fromHpPct: 0.55,
        weakPoint: 'MOUTH',
        ammo: ['SUPER_MISSILE', 'MISSILE'],
        ammoWhileClosed: ['MISSILE', 'CHARGE_BEAM'],
        movementWhileClosed: 'KEEP_MID_RANGE',
        window: {
          kind: 'ANY',
          label: 'boca aberta (rugido)',
          sensors: [
            { kind: 'COLOR_ABOVE', channel: 'red', min: 0.14, label: 'boca vermelha aberta' },
            { kind: 'HITBOX_GROW', axis: 'y', minPx: 2, label: 'hitbox cresceu' },
          ],
        },
        blindFireAfterTicks: 22,
        movement: 'KEEP_MID_RANGE',
        aim: 'DIAGONAL_UP',
        keepDistancePx: [70, 190],
        tempoMs: 128,
        heavyOnlyInWindow: true,
        note: 'Mísseis nos olhos até ele rugir de boca aberta; aí Super Míssil goela dentro. Do lado de fora da boca o míssil é só para acordá-lo.',
      },
      {
        id: 'awakened',
        label: 'Cresceu e quebrou o teto',
        weakPoint: 'EYES',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        ammoWhileClosed: ['MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'janela aberta' },
        movement: 'PLATFORM_UP',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [60, 200],
        tempoMs: 125,
        note: 'Depois que ele cresce e arrebenta o teto (proxy: HP abaixo de 55%), subir nas plataformas e repetir olhos→boca desviando das garras voadoras.',
      },
    ],
  },
  {
    id: 'crocomire',
    name: 'Crocomire',
    encounter: 'Norfair (poço de lava)',
    source: 'guia estratégico · item 5',
    signature: {
      minHp: 250,
      minSpanX: 44,
      mobility: 'STATIONARY',
      colorAtLeast: [{ channel: 'yellowGreen', min: 0.04 }],
      // Enorme e esverdeado, mas sem o brilho dourado do peito dos Torizo.
      colorBelow: [{ channel: 'gold', max: 0.06 }],
    },
    phases: [
      {
        id: 'shove',
        label: 'Empurrar até a parede de espinhos',
        weakPoint: 'MOUTH',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        ammoWhileClosed: ['CHARGE_BEAM', 'BASIC_BEAM'],
        movementWhileClosed: 'KEEP_MID_RANGE',
        window: {
          kind: 'ANY',
          label: 'boca aberta',
          sensors: [
            { kind: 'HITBOX_GROW', axis: 'x', minPx: 2, label: 'boca abrindo' },
            { kind: 'COLOR_RISE', channel: 'red', minDelta: 0.04, label: 'garganta vermelha' },
          ],
        },
        blindFireAfterTicks: 10,
        movement: 'PUSH_EAST',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [50, 170],
        tempoMs: 120,
        // A vitória é geography, não dano: não rotacionar a munição por falta de HP caindo.
        expectHpDamage: false,
        note: 'Ele não morre por dano: cada tiro na boca o faz recuar. Rajada rápida de Super Mísseis/mísseis na boca para empurrá-lo até a parede de espinhos e vê-lo cair na lava.',
      },
    ],
  },
  {
    id: 'phantoon',
    name: 'Phantoon',
    encounter: 'Maridia',
    source: 'guia estratégico · item 6',
    signature: {
      minHp: 300,
      minSpanX: 16,
      mobility: 'ROAMING',
      colorAtLeast: [{ channel: 'purple', min: 0.05 }],
      // Roxo é a assinatura dele; dourado forte apontaria para os dois Torizo.
      colorBelow: [{ channel: 'gold', max: 0.16 }],
    },
    phases: [
      {
        id: 'central-eye',
        label: 'Só o olho central · nunca Super Míssil',
        weakPoint: 'CENTRAL_EYE',
        ammo: ['MISSILE', 'CHARGE_BEAM', 'SPAZER_BEAM'],
        // Regra dura do guia: Super Míssil liga o modo fúria com chamas azuis.
        forbidden: ['SUPER_MISSILE', 'POWER_BOMB'],
        window: {
          kind: 'ANY',
          label: 'olho central aberto',
          sensors: [
            { kind: 'COLOR_ABOVE', channel: 'red', min: 0.1, label: 'olho central aberto (vermelho aceso)' },
            { kind: 'HP_FALLING', label: 'dano entrando no olho' },
          ],
        },
        blindFireAfterTicks: 12,
        movement: 'HOP_DODGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [80, 240],
        tempoMs: 125,
        heavyOnlyInWindow: true,
        note: 'Ele só toma dano com o olho central aberto: míssil normal ou tiro carregado no olho. Não usar Super Míssil — entra em fúria e invoca chamas azuis difíceis de desviar.',
      },
    ],
  },
  {
    id: 'botwoon',
    name: 'Botwoon',
    encounter: 'Maridia (túnel)',
    source: 'guia estratégico · item 7',
    signature: { minHp: 300, minSpanX: 12, mobility: 'ROAMING', colorAtLeast: [{ channel: 'silverCyan', min: 0.02 }] },
    special: { ambushLastKnownPosition: true },
    phases: [
      {
        id: 'predict-hole',
        label: 'Emboscada no buraco certo',
        weakPoint: 'HEAD',
        ammo: ['SUPER_MISSILE', 'CHARGE_BEAM', 'MISSILE'],
        ammoWhileClosed: ['BASIC_BEAM', 'CHARGE_BEAM'],
        movementWhileClosed: 'AMBUSH',
        window: {
          kind: 'ANY',
          label: 'cabeça emergiu',
          sensors: [
            { kind: 'HP_FALLING', label: 'dano entrando' },
            { kind: 'COLOR_ABOVE', channel: 'gold', min: 0.05, label: 'cabeça dourada visível' },
          ],
        },
        blindFireAfterTicks: 10,
        movement: 'AMBUSH',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [40, 170],
        tempoMs: 120,
        heavyOnlyInWindow: true,
        note: 'Ele entra e sai dos buracos da parede em alta velocidade: decorar o padrão, plantar-se no buraco de saída e encher a cabeça de Super Mísseis (~10) ou tiros carregados.',
      },
    ],
  },
  {
    id: 'draygon',
    name: 'Draygon',
    encounter: 'Maridia (plataforma de coral)',
    source: 'guia estratégico · item 8',
    signature: { minHp: 350, minSpanX: 18, minSpanY: 12, mobility: 'ROAMING', colorAtLeast: [{ channel: 'silverCyan', min: 0.03 }] },
    special: { subTargets: 'DRAYGON_POWER_STATIONS', finisher: 'DRAYGON_GRAPPLE' },
    phases: [
      {
        id: 'cut-stations',
        label: 'Destruir as torres de energia',
        gate: 'STATIONS_UNDONE',
        weakPoint: 'ANY',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'torres são alvos fixos' },
        movement: 'CENTER',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [60, 200],
        tempoMs: 125,
        expectHpDamage: false,
        note: 'Primeiro: destruir com Super Mísseis as torres de energia nas paredes — são elas que expõem a eletricidade usada na finalização secreta.',
      },
      {
        id: 'belly',
        label: 'Super Mísseis na barriga',
        weakPoint: 'BELLY',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'barriga exposta ao aproximar' },
        movement: 'HOP_DODGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [56, 170],
        tempoMs: 120,
        note: 'Método normal: encher a barriga de Super Mísseis desviando da gosma que ele cospe.',
      },
    ],
  },
  {
    id: 'golden-torizo',
    name: 'Golden Torizo',
    encounter: 'Templo Chozo',
    source: 'guia estratégico · item 9',
    signature: {
      minHp: 500,
      minSpanX: 12,
      minSpanY: 16,
      mobility: 'ROAMING',
      colorAtLeast: [
        { channel: 'gold', min: 0.05 },
        { channel: 'orange', min: 0.02 },
      ],
    },
    phases: [
      {
        id: 'chest-supers',
        label: 'Super Mísseis / Plasma carregado no peito',
        weakPoint: 'CHEST',
        ammo: ['SUPER_MISSILE', 'CHARGE_BEAM', 'PLASMA_BEAM'],
        // Parado, ele agarra o míssil normal no ar e devolve.
        forbiddenWhen: { when: 'BOSS_STATIONARY', ammo: ['MISSILE'] },
        window: {
          kind: 'ANY',
          label: 'peito aberto',
          sensors: [
            { kind: 'HP_FALLING', label: 'dano entrando' },
            { kind: 'COLOR_ABOVE', channel: 'gold', min: 0.14, label: 'peito dourado abriu' },
          ],
        },
        blindFireAfterTicks: 14,
        movement: 'HOP_DODGE',
        aim: 'NEUTRAL',
        keepDistancePx: [70, 190],
        tempoMs: 120,
        note: 'Versão muito mais rápida e forte do Torizo: Super Mísseis ou tiro carregado com Plasma no peito. Míssil normal ele agarra no ar e joga de volta.',
      },
    ],
  },
  {
    id: 'ridley-norfour',
    name: 'Ridley',
    encounter: 'Luta final — Norfair',
    source: 'guia estratégico · item 10',
    signature: { minHp: 700, minSpanX: 22, minSpanY: 20, mobility: 'ROAMING', colorAtLeast: [{ channel: 'red', min: 0.04 }] },
    phases: [
      {
        id: 'supers-first',
        label: 'Descarregar todos os Super Mísseis',
        fromHpPct: 0.62,
        fromTicks: 0,
        weakPoint: 'HEAD',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'janela aberta' },
        movement: 'AIRBORNE',
        aim: 'DIAGONAL_UP',
        keepDistancePx: [70, 220],
        tempoMs: 120,
        note: 'Descarregar todos os Super Mísseis primeiro, mirando rosto/peito, usando Space Jump para ficar no ar fora das rabadas.',
      },
      {
        id: 'sustain',
        label: 'Mísseis + carregado (Plasma/Wave/Ice)',
        weakPoint: 'CHEST',
        ammo: ['CHARGE_BEAM', 'PLASMA_BEAM', 'MISSILE'],
        window: { kind: 'ALWAYS', label: 'janela aberta' },
        movement: 'AIRBORNE',
        aim: 'DIAGONAL_UP',
        keepDistancePx: [80, 240],
        tempoMs: 120,
        note: 'Sem Super Mísseis, manter dano com mísseis e tiro carregado no rosto/peito e Space Jump para ficar no ar desviando das rabadas e bolas de fogo.',
      },
    ],
  },
  {
    id: 'mother-brain',
    name: 'Mother Brain',
    encounter: 'Cérebro Mãe — nau de Tourian',
    source: 'guia estratégico · item 11',
    signature: {
      minHp: 400,
      minSpanX: 40,
      minSpanY: 36,
      mobility: 'STATIONARY',
      colorAtLeast: [{ channel: 'red', min: 0.02 }],
      // A paleta dela é vermelho/cinza: verde-limão significa Kraid, Spore Spawn ou Crocomire.
      colorBelow: [{ channel: 'yellowGreen', max: 0.06 }],
    },
    phases: [
      {
        id: 'glass-tank',
        label: 'Fase 1 · Tanque de vidro',
        fromHpPct: 0.72,
        weakPoint: 'GLASS_TANK',
        ammo: ['MISSILE', 'SUPER_MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'tanque é o alvo' },
        movement: 'KEEP_MID_RANGE',
        aim: 'DIAGONAL_UP',
        keepDistancePx: [60, 200],
        tempoMs: 125,
        note: 'Quebrar as barreiras da sala e atirar mísseis no tanque de vidro até estilhaçar; depois acertar o cérebro diretamente.',
      },
      {
        id: 'giant-body',
        label: 'Fase 2 · Corpo gigante',
        fromHpPct: 0.1,
        weakPoint: 'BRAIN',
        ammo: ['SUPER_MISSILE', 'CHARGE_BEAM', 'MISSILE'],
        window: { kind: 'ALWAYS', label: 'cabeça exposta' },
        movement: 'HOP_DODGE',
        aim: 'DIAGONAL_UP',
        keepDistancePx: [70, 210],
        tempoMs: 120,
        note: 'Desviar dos anéis de energia e das bombas e encher a cabeça de Super Mísseis e tiros carregados.',
      },
      {
        id: 'hyper-beam',
        label: 'Fase 3 · Hyper Beam',
        gate: 'AFTER_CUTSCENE',
        weakPoint: 'BRAIN',
        ammo: ['HYPER_BEAM', 'CHARGE_BEAM', 'PLASMA_BEAM'],
        window: { kind: 'ALWAYS', label: 'só segurar o tiro' },
        movement: 'HOLD_GROUND',
        aim: 'UP',
        keepDistancePx: [90, 240],
        tempoMs: 130,
        note: 'Depois da cena do Baby Metroid você ganha o raio arco-íris (Hyper Beam): basta segurar o botão de tiro na cabeça dela até o fim.',
      },
    ],
  },

  // -- Entidades do X-Fusion: reconhecidas pelo agente, com política formalizada --
  {
    id: 'sax-humanoid',
    name: 'SA-X',
    encounter: 'X-Fusion · perseguição (Varia/Gravity)',
    source: 'classificador de entidades + guia X-Fusion',
    signature: {
      minHp: 800,
      minSpanX: 5,
      maxSpanX: 20,
      minSpanY: 14,
      mobility: 'ROAMING',
      entity: ['SAX_VARIA', 'SAX_GRAVITY'],
    },
    phases: [
      {
        id: 'break-contact',
        label: 'Desengajar: fugir',
        gate: 'NOT_FIGHTABLE',
        weakPoint: 'ANY',
        ammo: ['BASIC_BEAM', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'não há janela: prioridade é distância' },
        movement: 'DO_NOT_CHASE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [64, 400],
        tempoMs: 130,
        note: 'Sem o loadout completo não adianta trocar dano: míssil é recurso do confronto final. Abrir distância e procurar saída.',
      },
      {
        id: 'fight',
        label: 'Confronto com armamento pesado',
        gate: 'FIGHTABLE',
        weakPoint: 'ANY',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'janela de combate aberta' },
        movement: 'KEEP_MID_RANGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [64, 200],
        tempoMs: 125,
        note: 'Com armadura e feixes completos, recuar mantendo distância segura e punir com Super Mísseis a cada investida.',
      },
    ],
  },
  {
    id: 'sax-monster',
    name: 'SA-X Monstro',
    encounter: 'X-Fusion · confronto final',
    source: 'classificador de entidades + guia X-Fusion',
    signature: { minHp: 1100, minSpanX: 18, mobility: 'ROAMING', entity: ['SAX_MONSTER'] },
    phases: [
      {
        id: 'final',
        label: 'Forma monstro · armamento pesado',
        weakPoint: 'ANY',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'ALWAYS', label: 'janela aberta' },
        movement: 'KEEP_MID_RANGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [88, 260],
        tempoMs: 120,
        note: 'A forma monstro exige distância maior (≈88 px) e tudo o que sobrou de Super Mísseis; pulos para escapar das garras.',
      },
    ],
  },
  {
    id: 'core-x',
    name: 'Core-X',
    encounter: 'X-Fusion · núcleo de poder',
    source: 'classificador de entidades + guia X-Fusion',
    signature: {
      minHp: 1,
      maxHp: 449,
      minSpanX: 6,
      mobility: 'EITHER',
      entity: ['CORE_X_SILVER', 'CORE_X_YELLOW', 'CORE_X_RED', 'CORE_X_NAKED'],
      colorAtLeast: [{ channel: 'silverCyan', min: 0.06 }],
    },
    special: { collectWhenExposed: true },
    phases: [
      {
        id: 'collect',
        label: 'Poder exposto · perseguir e coletar',
        gate: 'CORE_EXPOSED',
        weakPoint: 'EXPOSED_CORE',
        ammo: ['BASIC_BEAM'],
        window: { kind: 'ALWAYS', label: 'ir buscar a orbe' },
        movement: 'CHASE',
        aim: 'NEUTRAL',
        keepDistancePx: [0, 400],
        tempoMs: 115,
        note: 'Com o poder exposto, parar de atirar e perseguir o núcleo para absorver a habilidade.',
      },
      {
        id: 'crack-shell',
        label: 'Abrir a casca com mísseis',
        weakPoint: 'EXPOSED_CORE',
        ammo: ['MISSILE', 'SUPER_MISSILE', 'CHARGE_BEAM'],
        window: {
          kind: 'ANY',
          label: 'casca cedendo',
          sensors: [
            { kind: 'HP_FALLING', label: 'dano entrando' },
            { kind: 'COLOR_RISE', channel: 'red', minDelta: 0.06, label: 'ficou vermelho (crítico)' },
          ],
        },
        blindFireAfterTicks: 12,
        movement: 'KEEP_MID_RANGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [40, 150],
        tempoMs: 120,
        note: 'Mísseis na carapaça até ela ceder; nas fases amarela e vermelha o dano entra melhor, então manter o ritmo sem se expor.',
      },
    ],
  },
  {
    id: 'metroid',
    name: 'Metroid',
    encounter: 'X-Fusion · larvas e adultos',
    source: 'classificador de entidades + guia X-Fusion',
    signature: {
      minHp: 1,
      maxHp: 449,
      minSpanX: 10,
      maxSpanX: 24,
      mobility: 'ROAMING',
      entity: ['METROID_LARVA'],
      colorAtLeast: [
        { channel: 'red', min: 0.08 },
        { channel: 'neonGreen', min: 0.04 },
      ],
    },
    phases: [
      {
        id: 'freeze-shatter',
        label: 'Congelar com Ice Beam → estilhaçar com míssil',
        weakPoint: 'ANY',
        ammo: ['MISSILE', 'SUPER_MISSILE', 'CHARGE_BEAM'],
        // Janela = congelado. Fora dela o trabalho é congelar.
        ammoWhileClosed: ['ICE_BEAM', 'BASIC_BEAM', 'CHARGE_BEAM'],
        requireBeam: 'ICE',
        window: {
          kind: 'ANY',
          label: 'congelado',
          sensors: [
            { kind: 'COLOR_ABOVE', channel: 'silverCyan', min: 0.1, label: 'gelo prata/ciano cobrindo o corpo' },
            { kind: 'COLOR_FALL', channel: 'red', minDelta: 0.03, label: 'vermelho do corpo caiu' },
          ],
        },
        blindFireAfterTicks: 12,
        movement: 'HOP_DODGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [40, 140],
        tempoMs: 118,
        note: 'Congelar com Ice Beam abre a janela; o dano real vem do míssil que estilhaça. Sem Ice Beam, dano contínuo e recuo.',
      },
    ],
  },
  {
    id: 'omega-metroid',
    name: 'Omega Metroid',
    encounter: 'X-Fusion · prólogo com contagem regressiva',
    source: 'classificador de entidades + guia X-Fusion',
    signature: { minHp: 150, minSpanX: 16, mobility: 'ROAMING', entity: ['OMEGA_INTRO'] },
    special: { doNotKill: true },
    phases: [
      {
        id: 'pace',
        label: 'Acompanhar o ritmo até o timer',
        weakPoint: 'ANY',
        ammo: ['CHARGE_BEAM', 'BASIC_BEAM', 'MISSILE'],
        window: { kind: 'ALWAYS', label: 'janela aberta' },
        movement: 'KEEP_MID_RANGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [68, 200],
        tempoMs: 125,
        note: 'No prólogo não dá para matá-lo: manter distância, atirar para marcar presença e deixar o temporizador/cutscene resolver.',
      },
    ],
  },
  {
    id: 'big-metroid',
    name: 'Metroid Grande',
    encounter: 'X-Fusion · evento de dreno',
    source: 'classificador de entidades + guia X-Fusion',
    signature: {
      minHp: 1,
      minSpanX: 24,
      mobility: 'STATIONARY',
      entity: ['BIG_METROID'],
      colorAtLeast: [
        { channel: 'neonGreen', min: 0.1 },
        { channel: 'red', min: 0.04 },
      ],
    },
    special: { letDrain: true },
    phases: [
      {
        id: 'let-drain',
        label: 'Deixar drenar (não fugir, não atirar)',
        weakPoint: 'ANY',
        ammo: ['BASIC_BEAM'],
        window: { kind: 'ALWAYS', label: 'sem ataque: é um evento' },
        movement: 'APPROACH',
        aim: 'NEUTRAL',
        keepDistancePx: [0, 44],
        tempoMs: 140,
        expectHpDamage: false,
        note: 'Permitir o dreno do Metroid Grande é o gatilho canônico do resgate contra a SA-X. Atirar aqui estraga o evento.',
      },
    ],
  },

  // -- Fallback: HP alto sem assinatura confiável --
  {
    id: 'generic-boss',
    name: 'Chefe não catalogado',
    encounter: 'detecção por HP/size',
    source: 'política padrão do agente',
    signature: { minHp: 450, mobility: 'EITHER' },
    phases: [
      {
        id: 'probe',
        label: 'Sondando o ponto fraco',
        fromHpPct: 0.9,
        weakPoint: 'ANY',
        ammo: ['MISSILE', 'CHARGE_BEAM', 'SUPER_MISSILE'],
        window: { kind: 'ALWAYS', label: 'sondagem livre' },
        movement: 'KEEP_MID_RANGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [56, 190],
        tempoMs: 125,
        note: 'Sem estratégia catalogada: medir qual munição tira HP e travar nela.',
      },
      {
        id: 'committed',
        label: 'Pressão com a munição comprovada',
        weakPoint: 'ANY',
        ammo: ['SUPER_MISSILE', 'MISSILE', 'CHARGE_BEAM'],
        window: { kind: 'HP_FALLING', label: 'enquanto o HP cair' },
        blindFireAfterTicks: 24,
        movement: 'KEEP_MID_RANGE',
        aim: 'TOWARD_TARGET',
        keepDistancePx: [56, 200],
        tempoMs: 120,
        note: 'Pressionar com a arma comprovadamente eficaz, mantendo distância de contato.',
      },
    ],
  },
];

export const GENERIC_BOSS_STRATEGY_ID = 'generic-boss';

// ---------------------------------------------------------------------------
// Reconhecimento por assinatura
// ---------------------------------------------------------------------------

export function findStrategyById(id: string | null | undefined): BossStrategy | null {
  if (!id) return null;
  return BOSS_STRATEGIES.find((s) => s.id === id) ?? null;
}

/**
 * Com cores medidas, exige o nível; sem pixels (frame em cache/HD), é neutro —
 * dar bônus aqui faria qualquer blob virar "Spore Spawn" por falta de evidência.
 */
function colorScore(obs: BossObservation, list: Array<{ channel: SpriteChannel; min: number }>): number {
  if (!obs.colors) return 0;
  return list.every(({ channel, min }) => (obs.colors?.[channel] ?? 0) >= min) ? 10 : -10;
}

/** Pontua o quanto a observação bate com a assinatura (0 = nada a ver). */
export function scoreSignature(strategy: BossStrategy, obs: BossObservation): number {
  const s = strategy.signature;
  let score = 0;

  if (s.entity && s.entity.length > 0) {
    if (obs.entity && s.entity.includes(obs.entity)) score += 40;
    else if (obs.entity) score -= 40;
    else score -= 6;
  }

  if (typeof s.minHp === 'number') score += obs.hp >= s.minHp ? 10 : -14;
  if (typeof s.maxHp === 'number') score += obs.hp <= s.maxHp ? 8 : -12;
  if (typeof s.minSpanX === 'number') score += obs.spanX >= s.minSpanX ? 6 : -8;
  if (typeof s.minSpanY === 'number') score += obs.spanY >= s.minSpanY ? 5 : -6;
  if (typeof s.maxSpanX === 'number') score += obs.spanX <= s.maxSpanX ? 4 : -8;

  if (s.mobility === 'STATIONARY') score += obs.movedPx <= 6 ? 8 : -6;
  if (s.mobility === 'ROAMING') score += obs.movedPx > 6 ? 8 : -6;
  if (s.mobility === 'EITHER') score += 2;

  if (s.colorAtLeast) score += colorScore(obs, s.colorAtLeast);

  if (s.colorBelow && obs.colors) {
    if (s.colorBelow.some(({ channel, max }) => (obs.colors?.[channel] ?? 0) > max)) score -= 8;
  }

  // Contextos que distinguem estratégias com assinatura parecida.
  if (strategy.id === 'ridley-ceres') score += obs.prologueState ? 22 : -12;
  if (strategy.id === 'ridley-norfour' && obs.prologueState) score -= 30;
  if (strategy.id === 'mother-brain' && obs.countdownActive) score -= 14;
  if (strategy.id === 'draygon' && obs.openExits === 0) score += 4;
  if (strategy.id === 'sax-monster' && obs.openExits === 0) score += 6;
  if (strategy.id === 'big-metroid' && obs.grabbedImmobilized) score += 6;
  if (strategy.id === 'metroid' && obs.entity === 'METROID_LARVA') score += 6;
  if (strategy.id === 'generic-boss') score += 1; // só desempate

  return score;
}

/** Melhor assinatura acima do mínimo, senão o fallback genérico. */
export function matchBossStrategy(obs: BossObservation): { strategy: BossStrategy; score: number } {
  let best: BossStrategy | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const strategy of BOSS_STRATEGIES) {
    const score = scoreSignature(strategy, obs);
    if (score > bestScore) {
      best = strategy;
      bestScore = score;
    }
  }
  const fallback = findStrategyById(GENERIC_BOSS_STRATEGY_ID) as BossStrategy;
  if (best && best !== fallback && bestScore >= 18) return { strategy: best, score: bestScore };
  return { strategy: fallback, score: bestScore };
}

// ---------------------------------------------------------------------------
// Fases
// ---------------------------------------------------------------------------

function gateMatches(gate: BossGate | undefined, obs: BossObservation): boolean {
  switch (gate) {
    case undefined:
    case 'ANY':
      return true;
    case 'FIGHTABLE':
      return obs.fightable;
    case 'NOT_FIGHTABLE':
      return !obs.fightable;
    case 'STATIONS_UNDONE':
      return obs.stationsDestroyed === 0;
    case 'STATIONS_DONE':
      return obs.stationsDestroyed > 0;
    case 'AFTER_CUTSCENE':
      return obs.resumedAfterCutscene;
    case 'CORE_EXPOSED':
      return obs.coreExposed;
    default:
      return true;
  }
}

/**
 * Fase ativa: portões contextuais primeiro, depois a 1ª fase cujas condições de
 * HP/tempo batem; a última funciona como catch-all.
 */
export function pickPhase(
  strategy: BossStrategy,
  hpPct: number,
  ticksInFight: number,
  obs: BossObservation,
): BossPhasePlan {
  const gated = strategy.phases.find((p) => p.gate && p.gate !== 'ANY' && gateMatches(p.gate, obs));
  if (gated) return gated;
  const fitting = strategy.phases.find(
    (p) =>
      gateMatches(p.gate, obs) &&
      (p.fromHpPct === undefined || hpPct > p.fromHpPct) &&
      (p.fromTicks === undefined || ticksInFight >= p.fromTicks),
  );
  return fitting ?? strategy.phases[strategy.phases.length - 1];
}

// ---------------------------------------------------------------------------
// Janela de vulnerabilidade
// ---------------------------------------------------------------------------

function blendColors(prev: BossColors | null, next: BossColors | null, alpha: number): BossColors | null {
  if (!next) return prev;
  const keys = new Set<SpriteChannel>([
    ...(Object.keys(next) as SpriteChannel[]),
    ...(prev ? (Object.keys(prev) as SpriteChannel[]) : []),
  ]);
  if (keys.size === 0) return null;
  const out: BossColors = {};
  for (const k of keys) {
    const a = prev?.[k];
    const b = next[k];
    out[k] = a === undefined ? (b ?? 0) : b === undefined ? a : a * (1 - alpha) + b * alpha;
  }
  return out;
}

export interface WindowVerdict {
  open: boolean;
  label: string;
}

export function evaluateWindow(
  window: BossWindow | undefined,
  obs: BossObservation,
  prevColors: BossColors | null,
  spanDX: number,
  spanDY: number,
  hpDelta: number,
): WindowVerdict {
  if (!window || window.kind === 'ALWAYS') {
    return { open: true, label: window?.label ?? 'sem janela restrita' };
  }
  switch (window.kind) {
    case 'HP_FALLING':
      return {
        open: hpDelta < 0,
        label: `${window.label}${hpDelta < 0 ? ` (+${-hpDelta} dano)` : ' · ainda sem dano'}`,
      };
    case 'COLOR_RISE': {
      if (!obs.colors) return { open: true, label: `${window.label} · sem pixels, assumindo aberta` };
      const now = obs.colors[window.channel] ?? 0;
      const before = prevColors?.[window.channel] ?? now;
      const delta = now - before;
      return { open: delta >= window.minDelta, label: `${window.label} · Δ${delta.toFixed(3)}` };
    }
    case 'COLOR_ABOVE': {
      if (!obs.colors) return { open: true, label: `${window.label} · sem pixels, assumindo aberta` };
      const level = obs.colors[window.channel] ?? 0;
      return {
        open: level >= window.min,
        label: `${window.label} · nível ${level.toFixed(3)} vs ${window.min}`,
      };
    }
    case 'COLOR_FALL': {
      if (!obs.colors) return { open: true, label: `${window.label} · sem pixels, assumindo aberta` };
      const now = obs.colors[window.channel] ?? 0;
      const before = prevColors?.[window.channel] ?? now;
      const delta = before - now;
      return { open: delta >= window.minDelta, label: `${window.label} · Δ${delta.toFixed(3)}` };
    }
    case 'HITBOX_GROW': {
      const d = window.axis === 'x' ? spanDX : spanDY;
      return { open: d >= window.minPx, label: `${window.label} · Δ${d}px` };
    }
    case 'ANY': {
      const results = window.sensors.map((s) =>
        evaluateWindow(s, obs, prevColors, spanDX, spanDY, hpDelta),
      );
      const hit = results.find((r) => r.open);
      return {
        open: Boolean(hit),
        label: hit ? `${window.label} · ${hit.label}` : `${window.label} · fechada`,
      };
    }
    default:
      return { open: true, label: 'sensor desconhecido → assumindo aberta' };
  }
}

// ---------------------------------------------------------------------------
// Munição: prior + evidência
// ---------------------------------------------------------------------------

function ammoAvailable(ammo: BossAmmo, loadout: LoadoutView, phase: BossPhasePlan): boolean {
  switch (ammo) {
    case 'MISSILE':
      return loadout.missileCount > 0;
    case 'SUPER_MISSILE':
      return loadout.superCount > 0;
    case 'POWER_BOMB':
      return loadout.powerBombCount > 0;
    case 'CHARGE_BEAM':
      return loadout.hasChargeBeam;
    case 'ICE_BEAM':
      return loadout.hasIceBeam && (phase.requireBeam !== 'ICE' || (loadout.beamsEquippedMask & 0x0002) !== 0);
    case 'WAVE_BEAM':
      return loadout.hasWaveBeam;
    case 'SPAZER_BEAM':
      return loadout.hasSpazerBeam;
    case 'PLASMA_BEAM':
      return loadout.hasPlasmaBeam;
    case 'GRAPPLE_FINISH':
      return loadout.hasGrapple;
    case 'HYPER_BEAM':
      return true; // concedido pela cutscene, não é item do HUD
    default:
      return true;
  }
}

function forbiddenNow(
  phase: BossPhasePlan,
  obs: BossObservation,
): Set<BossAmmo> {
  const set = new Set<BossAmmo>(phase.forbidden ?? []);
  const cond = phase.forbiddenWhen;
  if (cond) {
    const hit =
      (cond.when === 'BOSS_STATIONARY' && obs.bossStationary) ||
      (cond.when === 'SAMUS_GRABBED' && obs.grabbedImmobilized) ||
      (cond.when === 'LOW_SAMUS_HP' && obs.samusMaxHp > 0 && obs.samusHp <= obs.samusMaxHp * 0.3);
    if (hit) for (const a of cond.ammo) set.add(a);
  }
  return set;
}

const AMMO_LABELS: Record<BossAmmo, string> = {
  MISSILE: 'Mísseis',
  SUPER_MISSILE: 'Super Mísseis',
  POWER_BOMB: 'Bombas de Energia',
  CHARGE_BEAM: 'Tiro carregado',
  ICE_BEAM: 'Ice Beam',
  WAVE_BEAM: 'Wave Beam',
  SPAZER_BEAM: 'Spazer',
  PLASMA_BEAM: 'Plasma Beam',
  HYPER_BEAM: 'Hyper Beam',
  GRAPPLE_FINISH: 'Grapple Beam (finalização)',
  BASIC_BEAM: 'Feixe básico',
};

function slotFor(ammo: BossAmmo): HudAmmoSlot {
  if (ammo === 'MISSILE') return 1;
  if (ammo === 'SUPER_MISSILE' || ammo === 'POWER_BOMB') return 2;
  if (ammo === 'GRAPPLE_FINISH') return 3;
  return 0;
}

export interface AmmoDecision {
  ammo: BossAmmo;
  slot: HudAmmoSlot;
  label: string;
  rotated: boolean;
  rotationNote: string | null;
}

/**
 * Munição real: parte da fila do prior, remove proibido/indisponível e fura a fila
 * quando a evidência mostra que a arma preferida não fere.
 */
export function decideAmmo(
  queue: BossAmmo[],
  phase: BossPhasePlan,
  loadout: LoadoutView,
  obs: BossObservation,
  memory: BossFightMemory,
): AmmoDecision {
  const expectHpDamage = phase.expectHpDamage !== false;
  const forbidden = forbiddenNow(phase, obs);
  const usable = queue.filter((a) => !forbidden.has(a) && ammoAvailable(a, loadout, phase));
  const pool = usable.length > 0 ? usable : queue.filter((a) => !forbidden.has(a));

  if (pool.length === 0) {
    return {
      ammo: 'BASIC_BEAM',
      slot: 0,
      label: 'Feixe básico (munição preferida indisponível)',
      rotated: false,
      rotationNote: forbidden.size > 0 ? `${[...forbidden].map((a) => AMMO_LABELS[a]).join('/')} proibido para este chefe` : null,
    };
  }

  const primary = pool[0];
  const primaryEvidence = memory.evidence[primary];
  const primaryFailing =
    expectHpDamage && primaryEvidence !== undefined && primaryEvidence.probes >= PROBE_WINDOW && primaryEvidence.damage <= 0;

  if (primaryFailing) {
    // Reordena a fila pelo dano observado; se outra arma já provou que fere, troca.
    const ranked = pool
      .map((ammo, idx) => ({ ammo, idx, e: memory.evidence[ammo] }))
      .sort((a, b) => {
        const da = a.e?.damage ?? 0;
        const db = b.e?.damage ?? 0;
        if (db !== da) return db - da;
        return a.idx - b.idx;
      });
    const winner = ranked[0];
    if (winner && winner.ammo !== primary && (winner.e?.damage ?? 0) > 0) {
      return {
        ammo: winner.ammo,
        slot: slotFor(winner.ammo),
        label: `${AMMO_LABELS[winner.ammo]} · trocada por evidência`,
        rotated: true,
        rotationNote: `${AMMO_LABELS[primary]} não tirou HP em ${primaryEvidence?.probes ?? 0} sondagens · indo para ${AMMO_LABELS[winner.ammo]}`,
      };
    }
  }

  return {
    ammo: primary,
    slot: slotFor(primary),
    label: AMMO_LABELS[primary] + (expectHpDamage ? '' : ' · empurrão, não dano'),
    rotated: false,
    rotationNote: null,
  };
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

const COLOR_ALPHA = 0.45;
/** Ticks sem nenhum dano com o plano do guia antes de cair para o modo de sondagem. */
const MISFIRE_TICKS = 240;
/** Margem de pontuação para abandonar a estratégia já assumida nesta luta. */
const SWITCH_MARGIN = 16;
/** Tentativas mínimas com uma munição antes de considerar que ela não fere. */
const PROBE_WINDOW = 26;

export function createFightMemory(strategyId: string, obs: BossObservation): BossFightMemory {
  return {
    strategyId,
    phaseId: '',
    ticksInFight: 0,
    ticksInPhase: 0,
    peakHp: Math.max(1, obs.hp),
    lastHp: obs.hp,
    lastSpanX: obs.spanX,
    lastSpanY: obs.spanY,
    totalDamageDealt: 0,
    hitsLanded: 0,
    evidence: {},
    currentAmmo: null,
    smoothedColors: obs.colors ? { ...obs.colors } : null,
    lastSeenX: 0,
    lastSeenY: 0,
    targetVisible: true,
    ticksSinceVisible: 0,
    windowOpenTicks: 0,
    ticksSinceWindowOpen: 0,
    freeTicks: 0,
    finisherAttempted: false,
    rotations: 0,
    defeated: false,
    probeMode: false,
    roomId: -1,
    goneTicks: 0,
    bossName: '',
    phaseLabel: '',
    note: '',
    entityType: 'NONE',
  };
}

/**
 * Avança a luta em um tick e devolve a diretiva a executar.
 * Pura: recebe a memória anterior, devolve a nova (não muta nada).
 */
export function planBossFight(input: BossFightInput): BossPlanResult {
  const { observation: obs, loadout } = input;
  let boundStrategy = findStrategyById(input.boundStrategyId);
  const match = matchBossStrategy(obs);
  const remembered = input.memory ? findStrategyById(input.memory.strategyId) : null;
  // A identidade é pegajosa dentro da mesma luta: o inimigo não troca de espécie no meio
  // do combate, e medir pixels a cada tick faria o rótulo piscar (torcendo o plano inteiro).
  // Só solta o rótulo anterior quando outro candidato vence com folga.
  let strategy = boundStrategy ?? match.strategy;
  if (!boundStrategy && remembered && remembered.id !== match.strategy.id) {
    const margin = match.score - scoreSignature(remembered, obs);
    if (margin < SWITCH_MARGIN) strategy = remembered;
  }

  const base =
    input.memory && input.memory.strategyId === strategy.id ? input.memory : createFightMemory(strategy.id, obs);

  const memory: BossFightMemory = { ...base, evidence: { ...base.evidence } };
  // Rede de segurança: o reconhecimento por pixels+hitbox pode errar entre chefes de
  // silhueta parecida (Spore Spawn × Kraid × Crocomire são todos "verde parado gigante").
  // Se ~30 s do plano do guia não tiraram 1 ponto de HP, abandona o plano e passa a caçar
  // a munição que fere — mais vale um genérico eficaz que um especialista errado.
  if (
    strategy.id !== GENERIC_BOSS_STRATEGY_ID &&
    memory.ticksInFight > MISFIRE_TICKS &&
    memory.totalDamageDealt === 0 &&
    !memory.probeMode
  ) {
    memory.probeMode = true;
    memory.strategyId = GENERIC_BOSS_STRATEGY_ID;
    memory.phaseId = '';
    memory.ticksInPhase = 0;
    memory.evidence = {};
    boundStrategy = findStrategyById(GENERIC_BOSS_STRATEGY_ID);
    strategy = boundStrategy ?? strategy;
  }
  if (memory.probeMode && strategy.id !== GENERIC_BOSS_STRATEGY_ID) {
    strategy = findStrategyById(GENERIC_BOSS_STRATEGY_ID) ?? strategy;
  }
  memory.ticksInFight += 1;
  memory.ticksInPhase += 1;
  memory.roomId = input.roomId;
  memory.goneTicks = 0;
  memory.entityType = input.entityType ?? 'NONE';

  const hpDelta = obs.hp - memory.lastHp;
  memory.peakHp = Math.max(memory.peakHp, obs.hp);
  const hpPct = memory.peakHp > 0 ? Math.max(0, obs.hp / memory.peakHp) : 1;

  if (hpDelta < 0) {
    memory.hitsLanded += 1;
    memory.totalDamageDealt += -hpDelta;
    const ammo = memory.currentAmmo;
    if (ammo) {
      const e = memory.evidence[ammo] ?? { probes: 0, damage: 0 };
      memory.evidence[ammo] = { probes: e.probes, damage: e.damage + -hpDelta };
    }
  }
  memory.lastHp = obs.hp;

  const spanDX = obs.spanX - memory.lastSpanX;
  const spanDY = obs.spanY - memory.lastSpanY;
  memory.lastSpanX = obs.spanX;
  memory.lastSpanY = obs.spanY;

  const phase = pickPhase(strategy, hpPct, memory.ticksInFight, obs);
  memory.bossName = strategy.name;
  memory.phaseLabel = phase.label;
  memory.note = phase.note;
  if (phase.id !== memory.phaseId) {
    memory.phaseId = phase.id;
    memory.ticksInPhase = 0;
    memory.windowOpenTicks = 0;
  }

  const rawWin = evaluateWindow(phase.window, obs, memory.smoothedColors, spanDX, spanDY, hpDelta);
  // Um único frame amostrado mal não deve fechar a janela no meio do golpe:
  // mantém aberta por até 4 ticks depois do último sinal.
  if (rawWin.open) {
    memory.windowOpenTicks += 1;
    memory.ticksSinceWindowOpen = 0;
  } else {
    memory.ticksSinceWindowOpen += 1;
  }
  const stickyOpen = !rawWin.open && memory.windowOpenTicks > 0 && memory.ticksSinceWindowOpen <= 4;
  const win: WindowVerdict = stickyOpen
    ? { open: true, label: `${rawWin.label} · janela ainda quente` }
    : rawWin;
  const blindLimit = phase.blindFireAfterTicks ?? 18;
  const blindExpired = memory.ticksInPhase >= blindLimit;
  const canFireOnWindow = win.open || blindExpired;

  // Janela fechada + fase com lista de preparação → roda a ação de preparação.
  const setupMode = !canFireOnWindow && (phase.ammoWhileClosed?.length ?? 0) > 0;
  const queue = setupMode ? (phase.ammoWhileClosed as BossAmmo[]) : phase.ammo;
  let ammo = decideAmmo(queue, phase, loadout, obs, memory);

  // Munição pesada reservada: enquanto a janela não abre, cutuca com o feixe básico
  // em vez de queimar míssil (Kraid nos olhos, esporos caindo, olho do Phantoon).
  const heavyOnly = Boolean(phase.heavyOnlyInWindow);
  const isHeavy = ammo.ammo === 'SUPER_MISSILE' || ammo.ammo === 'MISSILE' || ammo.ammo === 'POWER_BOMB';
  const pokeWhileClosed = heavyOnly && isHeavy && !win.open && !blindExpired && !setupMode;
  if (pokeWhileClosed) {
    ammo = {
      ammo: 'BASIC_BEAM',
      slot: 0,
      label: 'Feixe básico · segurando a munição pesada',
      rotated: false,
      rotationNote: null,
    };
  }

  if (memory.currentAmmo !== ammo.ammo && !ammo.rotated) {
    // Troca de arma por janela (não por falha): zera a contagem de sondagem.
    memory.evidence = {};
  }
  memory.currentAmmo = ammo.ammo;
  if (ammo.rotated) memory.rotations += 1;
  if (phase.expectHpDamage !== false) {
    const e = memory.evidence[ammo.ammo] ?? { probes: 0, damage: 0 };
    memory.evidence[ammo.ammo] = { probes: Math.min(e.probes + 1, 400), damage: e.damage };
  }

  memory.smoothedColors = blendColors(memory.smoothedColors, obs.colors, COLOR_ALPHA);

  // Finalização secreta do Draygon: torres caídas + Samus agarrada + Grapple Beam.
  const finisherKind = strategy.special?.finisher ?? null;
  if (obs.grabbedImmobilized) {
    memory.freeTicks = 0;
  } else if (memory.finisherAttempted) {
    // Solta do agarrão → pode tentar a finalização de novo na próxima investida.
    memory.freeTicks += 1;
    if (memory.freeTicks >= 4) memory.finisherAttempted = false;
  }
  const finisherReady =
    finisherKind === 'DRAYGON_GRAPPLE' &&
    !memory.finisherAttempted &&
    loadout.hasGrapple &&
    obs.stationsDestroyed > 0 &&
    obs.grabbedImmobilized;
  if (finisherReady) memory.finisherAttempted = true;

  // Emboscada (Botwoon): lembra o último ponto em que a cabeça apareceu.
  const visibleNow = obs.hp > 0 && obs.spanX > 0;
  if (visibleNow) {
    memory.lastSeenX = input.targetX;
    memory.lastSeenY = input.targetY;
    memory.ticksSinceVisible = 0;
  } else {
    memory.ticksSinceVisible += 1;
  }
  memory.targetVisible = visibleNow;

  const distance = Math.max(0, Math.hypot(input.targetX - input.samusX, input.targetY - input.samusY));
  const keepDistance: [number, number] = phase.keepDistancePx ?? [56, 190];
  const rangeState: BossDirective['rangeState'] =
    distance < keepDistance[0] ? 'TOO_CLOSE' : distance > keepDistance[1] ? 'TOO_FAR' : 'IN_RANGE';

  const escapeTrigger = strategy.special?.escapeTriggerSamusHp;
  const scriptedRetire =
    typeof escapeTrigger === 'number' && obs.samusHp > 0 && obs.samusHp <= escapeTrigger;

  const role: BossRole = finisherReady
    ? 'FINISHER'
    : strategy.special?.letDrain
      ? 'HOLD'
      : setupMode || pokeWhileClosed
        ? 'SETUP'
        : 'ATTACK';

  const movement: BossMovement = finisherReady
    ? 'HOLD_GROUND'
    : scriptedRetire
      ? 'DO_NOT_CHASE'
      : role === 'SETUP'
        ? (phase.movementWhileClosed ?? phase.movement ?? 'KEEP_MID_RANGE')
        : (phase.movement ?? 'KEEP_MID_RANGE');

  // `mayFire` é false apenas quando não há nada produtivo a fazer: nem a janela abriu,
  // nem há ação de preparação, nem o tempo de tolerância (blindFireAfterTicks) venceu.
  // Atirar durante o dreno do Metroid Grande estraga o evento, então HOLD nunca atira.
  const mayFire =
    role === 'HOLD'
      ? false
      : role === 'FINISHER' || role === 'SETUP' || canFireOnWindow;

  const finished = obs.hp <= 0 && memory.ticksInFight > 2;
  if (finished) memory.defeated = true;

  const directive: BossDirective = {
    strategyId: strategy.id,
    bossName: strategy.name,
    encounter: strategy.encounter,
    phaseId: phase.id,
    phaseLabel: phase.label,
    note: phase.note,
    source: strategy.source,
    role,
    ammo: ammo.ammo,
    desiredSlot: ammo.slot,
    ammoLabel: ammo.label,
    aim: phase.aim ?? 'TOWARD_TARGET',
    movement,
    keepDistance,
    distance: Math.round(distance),
    rangeState,
    tempoMs: phase.tempoMs ?? 125,
    windowOpen: win.open,
    windowLabel: win.label,
    mayFire,
    conserveHeavyAmmo: pokeWhileClosed,
    requireBeam: phase.requireBeam ?? null,
    rotated: ammo.rotated,
    rotationNote: ammo.rotationNote,
    doNotKill: Boolean(strategy.special?.doNotKill) || scriptedRetire,
    farmFallingProjectiles: Boolean(strategy.special?.farmFallingProjectiles),
    ambush: strategy.special?.ambushLastKnownPosition
      ? { active: !visibleNow, x: memory.lastSeenX, y: memory.lastSeenY }
      : null,
    finisher: finisherReady ? finisherKind : null,
    subTargets: strategy.special?.subTargets ?? null,
    letDrain: Boolean(strategy.special?.letDrain),
    collectWhenExposed:
      Boolean(strategy.special?.collectWhenExposed) && (obs.entity === 'CORE_X_NAKED' || phase.id === 'collect'),
    weakPoint: phase.weakPoint,
    hpPct: Math.round(hpPct * 100) / 100,
    probeMode: memory.probeMode,
    damageDealt: memory.totalDamageDealt,
    hits: memory.hitsLanded,
    label: `${strategy.name} · ${phase.label}`,
  };

  return { directive, memory, finished };
}

/** Rótulo compacto para o painel da UI. */
export function describeDirectiveForUi(d: BossDirective): string {
  const parts = [d.label, d.ammoLabel];
  if (d.role === 'SETUP') parts.push('preparando');
  else if (d.role === 'HOLD') parts.push('sem atacar');
  else if (!d.mayFire) parts.push('esperando janela');
  if (d.rotated) parts.push('munição trocada por evidência');
  if (d.finisher) parts.push('finalização secreta');
  return parts.join(' · ');
}

/** Utilitário de diagnóstico/teste. */
export function codexSize(): number {
  return BOSS_STRATEGIES.length;
}
