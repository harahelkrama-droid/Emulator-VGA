import type { AIKey, ArmorAnalysis, EquipmentPieceStatus } from '../types/emulator';
import { getEmulatorGameManager } from './emulatorBridge';

export interface EnemyInfo {
  slot: number;
  id: number;
  x: number;
  y: number;
  xRadius: number;
  yRadius: number;
  hp: number;
  props: number;
  extraProps: number;
  aiHandler: number;
}

export interface RoomItemTarget {
  plmId: number;
  x: number;
  y: number;
}

export interface PlmInfo {
  id: number;
  bx: number;
  by: number;
  x: number;
  y: number;
  arg: number;
}

export interface DoorInfo {
  key: string;
  side: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
  bx: number;
  by: number;
  x: number;
  y: number;
  blockedByWall: boolean;
  hasCapPlm: boolean;
  capCount: number;
}

export interface MetroidControlsBinding {
  shoot: Exclude<AIKey, 'NONE'>;
  jump: Exclude<AIKey, 'NONE'>;
  run: Exclude<AIKey, 'NONE'>;
  cancel: Exclude<AIKey, 'NONE'>;
  select: Exclude<AIKey, 'NONE'>;
  aimDown: Exclude<AIKey, 'NONE'>;
  aimUp: Exclude<AIKey, 'NONE'>;
}

export interface MetroidWramSnapshot {
  valid: boolean;
  gameState: number;
  roomId: number;
  areaIndex: number;
  roomWidthBlocks: number;
  roomHeightBlocks: number;
  roomWidthPx: number;
  roomHeightPx: number;
  cameraX: number;
  cameraY: number;
  health: number;
  maxHealth: number;
  reserveEnergy: number;
  reserveMax: number;
  reserveMode: number;
  missiles: number;
  maxMissiles: number;
  supers: number;
  maxSupers: number;
  powerBombs: number;
  maxPowerBombs: number;
  selectedHudItem: number;
  itemsMask: number;
  itemsEquipped: number;
  beamsMask: number;
  beamsEquipped: number;
  abilities: string[];
  armorAnalysis: ArmorAnalysis;
  samusX: number;
  samusY: number;
  pose: number;
  facingDir: number;
  menuScreen: number;
  menuCursor: number;
  controls: MetroidControlsBinding;
  enemies: EnemyInfo[];
  ignoredBackgroundEnemies: number;
  timerStatus: number;
  countdownActive: boolean;
  countdownSeconds: number;
  roomItems: RoomItemTarget[];
  plms: PlmInfo[];
  doors: DoorInfo[];
  blockTypes: Uint8Array | null;
  btsBytes: Uint8Array | null;
}

interface CachedDoorShape {
  key: string;
  side: DoorInfo['side'];
  midBx: number;
  midBy: number;
  entryBx: number;
  entryBy: number;
  x: number;
  y: number;
  clusterLength: number;
  adjCells: Array<{ bx: number; by: number }>;
}

let cachedRamOffset = -1;
let cachedStateLen = -1;
let cachedBlockTypes: Uint8Array | null = null;
let cachedBtsBytes: Uint8Array | null = null;
let cachedDoorRoomId = -1;
let cachedDoorWidth = 0;
let cachedDoorHeight = 0;
let cachedDoorShapes: CachedDoorShape[] = [];

function findRamBase(state: Uint8Array): number {
  // Estratégia 1: cache válido (mesmo tamanho de estado)
  if (cachedRamOffset > 10 && cachedStateLen === state.length) {
    if (
      state[cachedRamOffset - 1] === 58 &&
      state[cachedRamOffset - 11] === 82 &&
      state[cachedRamOffset - 10] === 65 &&
      state[cachedRamOffset - 9] === 77
    ) {
      return cachedRamOffset;
    }
  }

  // Estratégia 2: assinatura "RAM:" (padrão do EmulatorJS)
  const signatureScan = scanForSignature(state);
  if (signatureScan >= 0) {
    cachedRamOffset = signatureScan;
    cachedStateLen = state.length;
    return cachedRamOffset;
  }

  // Estratégia 3: offsets conhecidos comuns do SNES (fallback quando a assinatura varia por versão do core)
  const knownOffsets = [0x0000, 0x1000, 0x2000, 0x7E0000, 0x7F0000, 0x100000];
  for (const off of knownOffsets) {
    if (off + 0x2000 >= state.length) continue;
    // Validação rápida: gameState em 0x0998 deve ser um valor plausível (0..0x2A ou 8)
    const gs = state[off + 0x0998] | (state[off + 0x0999] << 8);
    if (gs === 0 || gs === 8 || (gs >= 1 && gs <= 0x2A)) {
      cachedRamOffset = off;
      cachedStateLen = state.length;
      return cachedRamOffset;
    }
  }

  return -1;
}

function scanForSignature(state: Uint8Array): number {
  let i = 0;
  const limit = state.length - 12;
  while (i < limit) {
    const pos = state.indexOf(82, i); // 'R'
    if (pos < 0 || pos >= limit) break;
    if (state[pos + 1] === 65 && state[pos + 2] === 77 && state[pos + 3] === 58) {
      let j = pos + 4;
      while (j < pos + 24 && state[j] !== 58) j++;
      if (state[j] === 58) {
        return j + 1;
      }
    }
    i = pos + 1;
  }
  return -1;
}

function decodeSnesMaskToKey(mask: number, fallback: Exclude<AIKey, 'NONE'>): Exclude<AIKey, 'NONE'> {
  if (mask & 0x8000) return 'B';
  if (mask & 0x4000) return 'Y';
  if (mask & 0x2000) return 'SELECT';
  if (mask & 0x1000) return 'START';
  if (mask & 0x0080) return 'A';
  if (mask & 0x0040) return 'X';
  if (mask & 0x0020) return 'L';
  if (mask & 0x0010) return 'R';
  return fallback;
}

function decodeAbilities(
  itemsMask: number,
  beamsMask: number,
  maxMissiles: number,
  maxSupers: number,
  maxPbs: number,
  reserveMax: number,
): string[] {
  const list: string[] = [];
  if (maxMissiles > 0) list.push('Mísseis');
  if (maxSupers > 0) list.push('Super Mísseis');
  if (maxPbs > 0) list.push('Power Bomb');
  if (reserveMax > 0) list.push('Reserva');
  if (itemsMask & 0x0004) list.push('Morph Ball');
  if (itemsMask & 0x1000) list.push('Bombas');
  if (itemsMask & 0x0002) list.push('Spring Ball');
  if (itemsMask & 0x0100) list.push('Hi-Jump');
  if (itemsMask & 0x0001) list.push('Varia Suit');
  if (itemsMask & 0x0020) list.push('Gravity Suit');
  if (itemsMask & 0x2000) list.push('Speed Booster');
  if (itemsMask & 0x0200) list.push('Space Jump');
  if (itemsMask & 0x0008) list.push('Screw Attack');
  if (itemsMask & 0x4000) list.push('Grapple');
  if (itemsMask & 0x8000) list.push('X-Ray Scope');
  if (beamsMask & 0x1000) list.push('Charge Beam');
  if (beamsMask & 0x0001) list.push('Wave Beam');
  if (beamsMask & 0x0002) list.push('Ice Beam');
  if (beamsMask & 0x0004) list.push('Spazer');
  if (beamsMask & 0x0008) list.push('Plasma Beam');
  return list;
}

function buildArmorAnalysis(
  health: number,
  maxHealth: number,
  reserveEnergy: number,
  reserveMax: number,
  reserveModeRaw: number,
  itemsCollected: number,
  itemsEquipped: number,
  beamsCollected: number,
  beamsEquipped: number,
  maxMissiles: number,
  maxSupers: number,
): ArmorAnalysis {
  const hasVariaCol = (itemsCollected & 0x0001) !== 0;
  const hasVariaEq = (itemsEquipped & 0x0001) !== 0;
  const hasGravityCol = (itemsCollected & 0x0020) !== 0;
  const hasGravityEq = (itemsEquipped & 0x0020) !== 0;

  const suitTier: ArmorAnalysis['suitTier'] = hasGravityEq
    ? 'Gravity Suit'
    : hasVariaEq
      ? 'Varia Suit'
      : 'Fusion Suit (Base)';

  const damageReductionPct = hasGravityEq ? 75 : hasVariaEq ? 50 : 0;
  const thermalProtected = hasVariaEq || hasGravityEq;
  const liquidMobility = hasGravityEq;
  const reserveMode: ArmorAnalysis['reserveMode'] =
    reserveModeRaw === 1 ? 'Automático' : reserveModeRaw === 2 ? 'Manual' : 'Desativado';

  const totalPool = health + (reserveMax > 0 ? reserveEnergy : 0);
  const multiplier = damageReductionPct === 75 ? 4 : damageReductionPct === 50 ? 2 : 1;
  const effectiveHp = totalPool * multiplier;
  const energyTanks = Math.max(0, Math.floor((maxHealth - 99) / 100));

  const pieces: EquipmentPieceStatus[] = [
    {
      id: 'varia',
      name: 'Varia Suit',
      category: 'armor',
      collected: hasVariaCol,
      equipped: hasVariaEq,
      note: '50% redução de dano e proteção térmica',
    },
    {
      id: 'gravity',
      name: 'Gravity Suit',
      category: 'armor',
      collected: hasGravityCol,
      equipped: hasGravityEq,
      note: '75% redução de dano e mobilidade em líquidos/lava',
    },
    {
      id: 'morph',
      name: 'Morph Ball',
      category: 'mobility',
      collected: (itemsCollected & 0x0004) !== 0,
      equipped: (itemsEquipped & 0x0004) !== 0,
      note: 'Acesso a passagens estreitas',
    },
    {
      id: 'bombs',
      name: 'Bombas',
      category: 'mobility',
      collected: (itemsCollected & 0x1000) !== 0,
      equipped: (itemsEquipped & 0x1000) !== 0,
      note: 'Quebra blocos em Morph Ball',
    },
    {
      id: 'spring',
      name: 'Spring Ball',
      category: 'mobility',
      collected: (itemsCollected & 0x0002) !== 0,
      equipped: (itemsEquipped & 0x0002) !== 0,
      note: 'Salto direto em Morph Ball',
    },
    {
      id: 'hijump',
      name: 'Hi-Jump Boots',
      category: 'mobility',
      collected: (itemsCollected & 0x0100) !== 0,
      equipped: (itemsEquipped & 0x0100) !== 0,
      note: 'Aumenta altura de salto',
    },
    {
      id: 'speed',
      name: 'Speed Booster',
      category: 'mobility',
      collected: (itemsCollected & 0x2000) !== 0,
      equipped: (itemsEquipped & 0x2000) !== 0,
      note: 'Corrida supersônica e Shinespark',
    },
    {
      id: 'space',
      name: 'Space Jump',
      category: 'mobility',
      collected: (itemsCollected & 0x0200) !== 0,
      equipped: (itemsEquipped & 0x0200) !== 0,
      note: 'Saltos múltiplos no ar',
    },
    {
      id: 'screw',
      name: 'Screw Attack',
      category: 'armor',
      collected: (itemsCollected & 0x0008) !== 0,
      equipped: (itemsEquipped & 0x0008) !== 0,
      note: 'Escudo giratório ofensivo no salto',
    },
    {
      id: 'grapple',
      name: 'Grapple Beam',
      category: 'mobility',
      collected: (itemsCollected & 0x4000) !== 0,
      equipped: (itemsEquipped & 0x4000) !== 0,
      note: 'Gancho para blocos e abismos',
    },
    {
      id: 'xray',
      name: 'X-Ray Scope',
      category: 'mobility',
      collected: (itemsCollected & 0x8000) !== 0,
      equipped: (itemsEquipped & 0x8000) !== 0,
      note: 'Detecta passagens e blocos ocultos',
    },
    {
      id: 'charge',
      name: 'Charge Beam',
      category: 'beam',
      collected: (beamsCollected & 0x1000) !== 0,
      equipped: (beamsEquipped & 0x1000) !== 0,
      note: 'Disparo carregado de alto impacto',
    },
    {
      id: 'wave',
      name: 'Wave / Wide Beam',
      category: 'beam',
      collected: (beamsCollected & 0x0001) !== 0,
      equipped: (beamsEquipped & 0x0001) !== 0,
      note: 'Atravessa paredes e amplia alcance',
    },
    {
      id: 'ice',
      name: 'Ice Beam',
      category: 'beam',
      collected: (beamsCollected & 0x0002) !== 0,
      equipped: (beamsEquipped & 0x0002) !== 0,
      note: 'Congela inimigos e parasitas X',
    },
    {
      id: 'spazer',
      name: 'Spazer',
      category: 'beam',
      collected: (beamsCollected & 0x0004) !== 0,
      equipped: (beamsEquipped & 0x0004) !== 0,
      note: 'Feixe triplo paralelo',
    },
    {
      id: 'plasma',
      name: 'Plasma Beam',
      category: 'beam',
      collected: (beamsCollected & 0x0008) !== 0,
      equipped: (beamsEquipped & 0x0008) !== 0,
      note: 'Perfura armadura e múltiplos alvos',
    },
  ];

  const collectedCount = pieces.filter((p) => p.collected).length;
  const equippedCount = pieces.filter((p) => p.equipped).length;
  const missingPieces = pieces.filter((p) => !p.collected).map((p) => p.name);
  const unequippedCollected = pieces.filter((p) => p.collected && !p.equipped).map((p) => p.name);

  let saxScore = 0;
  saxScore += Math.min(30, Math.round(((maxHealth + reserveMax) / 600) * 30));
  saxScore += hasGravityEq ? 25 : hasVariaEq ? 18 : 0;
  saxScore += (beamsEquipped & 0x1009) !== 0 ? 25 : (beamsEquipped & 0x0006) !== 0 ? 12 : 0;
  saxScore += Math.min(20, Math.round(Math.max(maxSupers / 10, maxMissiles / 40) * 20));

  return {
    suitTier,
    damageReductionPct,
    thermalProtected,
    liquidMobility,
    effectiveHp,
    energyTanks,
    reserveEnergy,
    reserveMax,
    reserveMode,
    collectedCount,
    equippedCount,
    totalPieces: pieces.length,
    missingPieces,
    unequippedCollected,
    saxReadinessPct: Math.max(0, Math.min(100, saxScore)),
    pieces,
  };
}

export async function readMetroidWram(): Promise<MetroidWramSnapshot | null> {
  if (window.EJS_core !== 'snes') return null;
  const gm = getEmulatorGameManager();
  if (!gm || typeof gm.getState !== 'function') return null;

  try {
    const raw = await Promise.resolve(gm.getState());
    if (!raw) return null;
    const state = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const base = findRamBase(state);
    if (base < 0 || base + 0x2000 >= state.length) return null;

    const u16 = (addr: number) => state[base + addr] | (state[base + addr + 1] << 8);
    const gameState = u16(0x0998);
    const maxHealth = u16(0x09c4);
    const health = u16(0x09c2);

    // Validação relaxada: aceita estados iniciais (tela título / carregando) e estados
    // em jogo. ROMs hack (ex.: X-Fusion) podem ter offsets ligeiramente diferentes,
    // então não rejeitamos apenas por maxHealth fora de um intervalo estreito.
    const looksLikeMetroid =
      (gameState <= 0x2a && maxHealth === 0 && health === 0) || // título / carregando
      (maxHealth > 0 && maxHealth <= 9999 && health <= maxHealth + 9999); // em jogo

    if (!looksLikeMetroid) return null;

    const roomId = u16(0x079b);
    const areaIndex = u16(0x079f);
    const roomWidthBlocks = Math.max(16, Math.min(256, u16(0x07a5)));
    const roomHeightBlocks = Math.max(16, Math.min(256, u16(0x07a7)));
    const roomWidthPx = roomWidthBlocks * 16;
    const roomHeightPx = roomHeightBlocks * 16;
    const cameraX = u16(0x0911);
    const cameraY = u16(0x0915);

    const reserveMax = u16(0x09d4);
    const reserveEnergy = u16(0x09d6);
    const reserveMode = u16(0x09d8);
    const missiles = u16(0x09c6);
    const maxMissiles = u16(0x09c8);
    const supers = u16(0x09ca);
    const maxSupers = u16(0x09cc);
    const powerBombs = u16(0x09ce);
    const maxPowerBombs = u16(0x09d0);
    const selectedHudItem = u16(0x09d2);
    const itemsEquipped = u16(0x09a2);
    const itemsMask = u16(0x09a4);
    const beamsEquipped = u16(0x09a6);
    const beamsMask = u16(0x09a8);
    const samusX = u16(0x0af6);
    const samusY = u16(0x0afa);
    const pose = u16(0x0a1c);
    const facingDir = state[base + 0x0a1e] ?? 0;
    const menuScreen = state[base + 0x00d1] ?? 0;
    const menuCursor = state[base + 0x0745] ?? 0;
    const timerStatus = u16(0x0943);
    const bcdToInt = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
    const timerSecByte = state[base + 0x0946] ?? 0;
    const timerMinByte = state[base + 0x0947] ?? 0;
    const countdownActive = timerStatus > 0 && timerStatus < 0x0100;
    const countdownSeconds = countdownActive
      ? Math.max(0, bcdToInt(timerMinByte) * 60 + bcdToInt(timerSecByte))
      : 0;

    const controls: MetroidControlsBinding = {
      shoot: decodeSnesMaskToKey(u16(0x09b2), 'X'),
      jump: decodeSnesMaskToKey(u16(0x09b4), 'A'),
      run: decodeSnesMaskToKey(u16(0x09b6), 'B'),
      cancel: decodeSnesMaskToKey(u16(0x09b8), 'Y'),
      select: decodeSnesMaskToKey(u16(0x09ba), 'SELECT'),
      aimDown: decodeSnesMaskToKey(u16(0x09bc), 'L'),
      aimUp: decodeSnesMaskToKey(u16(0x09be), 'R'),
    };

    const enemies: EnemyInfo[] = [];
    let ignoredBackgroundEnemies = 0;

    if (gameState === 8 && roomId > 0) {
      for (let slot = 0; slot < 32; slot++) {
        const eBase = 0x0f78 + slot * 0x40;
        const id = u16(eBase);
        if (id === 0) continue;
        const x = u16(eBase + 0x02);
        const y = u16(eBase + 0x06);
        if (x === 0 || y === 0 || x > roomWidthPx + 96 || y > roomHeightPx + 96) continue;

        const xRadius = u16(eBase + 0x0a);
        const yRadius = u16(eBase + 0x0c);
        const props = u16(eBase + 0x0e); // $7E:0F86 (0x0100 invisível, 0x0200 deletado, 0x0400 intangível/cenário)
        const extraProps = u16(eBase + 0x10); // $7E:0F88
        const aiHandler = u16(eBase + 0x12); // $7E:0F8A
        const hp = u16(eBase + 0x14); // $7E:0F8C

        // Ignora elementos visuais de cenário/background, intangíveis, deletados ou sem hitbox
        if ((props & 0x0700) !== 0 || xRadius === 0 || yRadius === 0 || hp === 0 || hp === 0xffff) {
          ignoredBackgroundEnemies++;
          continue;
        }

        enemies.push({
          slot,
          id,
          x,
          y,
          xRadius,
          yRadius,
          hp,
          props,
          extraProps,
          aiHandler,
        });
      }
    }

    const roomItems: RoomItemTarget[] = [];
    const plms: PlmInfo[] = [];
    let blockTypes: Uint8Array | null = null;
    let btsBytes: Uint8Array | null = null;
    const doors: DoorInfo[] = [];

    if (gameState === 8 && roomId > 0) {
      for (let i = 0; i < 40; i++) {
        const plmId = u16(0x1c37 + i * 2);
        if (plmId === 0) continue;
        const blockIdx = u16(0x1c87 + i * 2) >> 1;
        const bx = blockIdx % roomWidthBlocks;
        const by = Math.floor(blockIdx / roomWidthBlocks);
        const arg = u16(0x1dc7 + i * 2);
        plms.push({
          id: plmId,
          bx,
          by,
          x: bx * 16 + 8,
          y: by * 16 + 8,
          arg,
        });
        if (plmId >= 0xeed0 && plmId <= 0xf150) {
          roomItems.push({
            plmId,
            x: bx * 16 + 8,
            y: by * 16 + 8,
          });
        }
      }

      const totalBlocks = roomWidthBlocks * roomHeightBlocks;
      if (totalBlocks > 0 && totalBlocks <= 16384 && base + 0x16402 + totalBlocks <= state.length) {
        if (!cachedBlockTypes || cachedBlockTypes.length !== totalBlocks) {
          cachedBlockTypes = new Uint8Array(totalBlocks);
        }
        if (!cachedBtsBytes || cachedBtsBytes.length !== totalBlocks) {
          cachedBtsBytes = new Uint8Array(totalBlocks);
        }
        blockTypes = cachedBlockTypes;
        btsBytes = cachedBtsBytes;

        for (let i = 0; i < totalBlocks; i++) {
          const tileOff = base + 0x10002 + i * 2;
          const tile = state[tileOff] | (state[tileOff + 1] << 8);
          blockTypes[i] = (tile >> 12) & 0x0f;
          btsBytes[i] = state[base + 0x16402 + i];
        }

        const tAt = (bx: number, by: number): number => {
          let cx = bx;
          let cy = by;
          for (let hop = 0; hop < 8; hop++) {
            if (cx < 0 || cy < 0 || cx >= roomWidthBlocks || cy >= roomHeightBlocks) return 0x8;
            const idx = cy * roomWidthBlocks + cx;
            const t = blockTypes![idx];
            if (t === 0x5) {
              const raw = btsBytes![idx];
              cx += raw === 0 ? -1 : raw >= 128 ? raw - 256 : raw;
              continue;
            }
            if (t === 0xd) {
              const raw = btsBytes![idx];
              cy += raw === 0 ? -1 : raw >= 128 ? raw - 256 : raw;
              continue;
            }
            return t;
          }
          return 0x8;
        };

        if (
          cachedDoorRoomId !== roomId ||
          cachedDoorWidth !== roomWidthBlocks ||
          cachedDoorHeight !== roomHeightBlocks
        ) {
          cachedDoorRoomId = roomId;
          cachedDoorWidth = roomWidthBlocks;
          cachedDoorHeight = roomHeightBlocks;
          cachedDoorShapes = [];

          const visitedDoor = new Uint8Array(totalBlocks);
          for (let by = 0; by < roomHeightBlocks; by++) {
            for (let bx = 0; bx < roomWidthBlocks; bx++) {
              const idx = by * roomWidthBlocks + bx;
              if (blockTypes[idx] !== 0x9 || visitedDoor[idx]) continue;

              const cluster: Array<{ bx: number; by: number }> = [{ bx, by }];
              visitedDoor[idx] = 1;
              let qHead = 0;
              while (qHead < cluster.length) {
                const cur = cluster[qHead++];
                const neighbors = [
                  { bx: cur.bx, by: cur.by + 1 },
                  { bx: cur.bx, by: cur.by - 1 },
                  { bx: cur.bx + 1, by: cur.by },
                  { bx: cur.bx - 1, by: cur.by },
                ];
                for (const nb of neighbors) {
                  if (nb.bx < 0 || nb.by < 0 || nb.bx >= roomWidthBlocks || nb.by >= roomHeightBlocks) continue;
                  const nIdx = nb.by * roomWidthBlocks + nb.bx;
                  if (blockTypes[nIdx] === 0x9 && !visitedDoor[nIdx]) {
                    visitedDoor[nIdx] = 1;
                    cluster.push(nb);
                  }
                }
              }

              let minX = roomWidthBlocks;
              let maxX = -1;
              let minY = roomHeightBlocks;
              let maxY = -1;
              for (const c of cluster) {
                if (c.bx < minX) minX = c.bx;
                if (c.bx > maxX) maxX = c.bx;
                if (c.by < minY) minY = c.by;
                if (c.by > maxY) maxY = c.by;
              }

              const spanX = maxX - minX + 1;
              const spanY = maxY - minY + 1;
              const midBx = Math.round((minX + maxX) / 2);
              const midBy = Math.round((minY + maxY) / 2);

              let side: DoorInfo['side'] = 'RIGHT';
              if (spanY >= spanX) {
                if (minX === 0) {
                  side = 'LEFT';
                } else if (maxX === roomWidthBlocks - 1) {
                  side = 'RIGHT';
                } else {
                  const rightOpen = tAt(maxX + 1, midBy) !== 0x8;
                  const leftOpen = tAt(minX - 1, midBy) !== 0x8;
                  side = rightOpen && !leftOpen ? 'LEFT' : 'RIGHT';
                }
              } else {
                if (minY === 0) {
                  side = 'UP';
                } else if (maxY === roomHeightBlocks - 1) {
                  side = 'DOWN';
                } else {
                  const downOpen = tAt(midBx, maxY + 1) !== 0x8;
                  side = downOpen ? 'UP' : 'DOWN';
                }
              }

              const adjCells = cluster.map((c) => ({
                bx: side === 'LEFT' ? c.bx + 1 : side === 'RIGHT' ? c.bx - 1 : c.bx,
                by: side === 'UP' ? c.by + 1 : side === 'DOWN' ? c.by - 1 : c.by,
              }));

              const entryBx =
                side === 'LEFT'
                  ? Math.min(roomWidthBlocks - 1, maxX + 1)
                  : side === 'RIGHT'
                    ? Math.max(0, minX - 1)
                    : midBx;
              const entryBy =
                side === 'UP'
                  ? Math.min(roomHeightBlocks - 1, maxY + 1)
                  : side === 'DOWN'
                    ? Math.max(0, minY - 1)
                    : maxY;

              cachedDoorShapes.push({
                key: `${side}@${minX}:${minY}-${maxY}`,
                side,
                midBx,
                midBy,
                entryBx,
                entryBy,
                x: entryBx * 16 + 8,
                y: entryBy * 16 + 8,
                clusterLength: cluster.length,
                adjCells,
              });
            }
          }
        }

        for (const shape of cachedDoorShapes) {
          let solidAdj = 0;
          let capCount = 0;
          for (const adj of shape.adjCells) {
            const adjT = tAt(adj.bx, adj.by);
            if (adjT === 0x8) solidAdj++;
            if (adjT === 0xb || adjT === 0xc || adjT === 0xf) capCount++;
          }
          const hasCapPlm = plms.some(
            (p) => Math.abs(p.bx - shape.midBx) <= 3 && Math.abs(p.by - shape.midBy) <= 4 && (p.id < 0xeed0 || p.id > 0xf150),
          );
          const blockedByWall = solidAdj === shape.clusterLength && !hasCapPlm && capCount === 0;
          doors.push({
            key: shape.key,
            side: shape.side,
            bx: shape.entryBx,
            by: shape.entryBy,
            x: shape.x,
            y: shape.y,
            blockedByWall,
            hasCapPlm,
            capCount,
          });
        }
      }
    }

    const armorAnalysis = buildArmorAnalysis(
      health,
      maxHealth,
      reserveEnergy,
      reserveMax,
      reserveMode,
      itemsMask,
      itemsEquipped,
      beamsMask,
      beamsEquipped,
      maxMissiles,
      maxSupers,
    );

    return {
      valid: true,
      gameState,
      roomId,
      areaIndex,
      roomWidthBlocks,
      roomHeightBlocks,
      roomWidthPx,
      roomHeightPx,
      cameraX,
      cameraY,
      health,
      maxHealth,
      reserveEnergy,
      reserveMax,
      reserveMode,
      missiles,
      maxMissiles,
      supers,
      maxSupers,
      powerBombs,
      maxPowerBombs,
      selectedHudItem,
      itemsMask,
      itemsEquipped,
      beamsMask,
      beamsEquipped,
      abilities: decodeAbilities(itemsMask, beamsMask, maxMissiles, maxSupers, maxPowerBombs, reserveMax),
      armorAnalysis,
      samusX,
      samusY,
      pose,
      facingDir,
      menuScreen,
      menuCursor,
      controls,
      enemies,
      ignoredBackgroundEnemies,
      timerStatus,
      countdownActive,
      countdownSeconds,
      roomItems,
      plms,
      doors,
      blockTypes,
      btsBytes,
    };
  } catch {
    return null;
  }
}
