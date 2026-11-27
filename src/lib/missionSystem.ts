/**
 * missionSystem.ts — Sistema de missão completa para Super Metroid / X-Fusion
 *
 * Rastreia o progresso da campanha inteira, setor por setor, garantindo que a IA
 * siga o caminho normal do jogo:
 *
 *   1. Ativar terminal A (Auxiliary Power) em CADA setor antes de qualquer N, D ou S
 *   2. Coletar todos os itens e habilidades de cada setor
 *   3. Manter energia e reserva em 100% até a fase final
 *   4. Apenas então prosseguir para o próximo setor / fase final
 *
 * Toda a missão é persistida no IndexedDB via saveDb, sobrevivendo a recargas
 * de página e a carregamento de save states.
 */

import type {
  EncounterKnowledgeRecord,
  SpecialEntityType,
} from '../types/emulator';
import {
  readAIKnowledge,
  upsertAIKnowledge,
  clearAIKnowledge,
} from './saveDb';

/* ------------------------------------------------------------------ setores */

export type SectorId = 'SRX' | 'NOC' | 'CRT' | 'NOR' | 'WST' | 'EAS' | 'MET';

export interface SectorTerminals {
  /** terminal A (Auxiliary Power) ativado neste setor? */
  A: boolean;
  /** terminal N (Navigation) ativado neste setor? */
  N: boolean;
  /** terminal D (Data Room) ativado neste setor? */
  D: boolean;
  /** terminal S (Save Room) ativado neste setor? */
  S: boolean;
}

export interface SectorProgress {
  id: SectorId;
  name: string;
  /** salas visitadas neste setor */
  roomsVisited: number;
  /** terminais ativados */
  terminals: SectorTerminals;
  /** itens coletados (tanques, mísseis, supers, bombas, habilidades) */
  itemsCollected: number;
  /** itens totais conhecidos neste setor */
  itemsTotal: number;
  /** chefes derrotados neste setor */
  bossesDefeated: number;
  /** chefes conhecidos neste setor */
  bossesKnown: number;
  /** setor completamente terminado (A + N + D + S + todos itens + chefes) */
  completed: boolean;
  /** energia e reserva em 100% neste setor? */
  energyFull: boolean;
  /** reserve em 100%? */
  reserveFull: boolean;
}

/* ------------------------------------------------------------------ missão */

export interface MissionProgress {
  /** versão do formato de salvamento */
  version: number;
  /** setores já visitados */
  sectors: Record<SectorId, SectorProgress>;
  /** setor atual onde Samus está */
  currentSector: SectorId | null;
  /** tanques de energia coletados no total */
  energyTanksCollected: number;
  /** tanques de reserva coletados no total */
  reserveTanksCollected: number;
  /** expansões de míssil coletadas */
  missilesCollected: number;
  /** expansões de super míssil coletadas */
  supersCollected: number;
  /** expansões de power bomb coletadas */
  powerBombsCollected: number;
  /** habilidades coletadas */
  abilitiesCollected: string[];
  /** chefes derrotados no total */
  bossesDefeated: number;
  /** chefes conhecidos no total */
  bossesKnown: number;
  /** missão 100% completa? */
  missionComplete: boolean;
  /** fase final alcançada? */
  endgameReached: boolean;
  /** último timestamp de atualização */
  updatedAt: number;
}

/* ------------------------------------------------------------------ constantes */

const SECTOR_DEFINITIONS: Record<SectorId, { name: string; itemsTotal: number; bossesKnown: number }> = {
  SRX: { name: 'Setor SRX', itemsTotal: 12, bossesKnown: 2 },
  NOC: { name: 'Setor NOC', itemsTotal: 10, bossesKnown: 2 },
  CRT: { name: 'Setor CRT', itemsTotal: 8, bossesKnown: 1 },
  NOR: { name: 'Setor NOR', itemsTotal: 14, bossesKnown: 2 },
  WST: { name: 'Setor WST', itemsTotal: 10, bossesKnown: 2 },
  EAS: { name: 'Setor EAS', itemsTotal: 8, bossesKnown: 1 },
  MET: { name: 'Setor MET', itemsTotal: 6, bossesKnown: 1 },
};

const EMPTY_SECTOR: SectorProgress = {
  id: 'SRX',
  name: 'Setor SRX',
  roomsVisited: 0,
  terminals: { A: false, N: false, D: false, S: false },
  itemsCollected: 0,
  itemsTotal: 0,
  bossesDefeated: 0,
  bossesKnown: 0,
  completed: false,
  energyFull: false,
  reserveFull: false,
};

function emptySector(id: SectorId): SectorProgress {
  const def = SECTOR_DEFINITIONS[id];
  return {
    ...EMPTY_SECTOR,
    id,
    name: def.name,
    itemsTotal: def.itemsTotal,
    bossesKnown: def.bossesKnown,
  };
}

const DEFAULT_MISSION: MissionProgress = {
  version: 1,
  sectors: {} as Record<SectorId, SectorProgress>,
  currentSector: null,
  energyTanksCollected: 0,
  reserveTanksCollected: 0,
  missilesCollected: 0,
  supersCollected: 0,
  powerBombsCollected: 0,
  abilitiesCollected: [],
  bossesDefeated: 0,
  bossesKnown: 0,
  missionComplete: false,
  endgameReached: false,
  updatedAt: Date.now(),
};

/* ------------------------------------------------------------------ classe */

export class MissionSystem {
  private progress: MissionProgress = { ...DEFAULT_MISSION };
  private readonly gameKey: string;
  private dirty = false;

  constructor(gameKey: string) {
    this.gameKey = gameKey;
    // Inicializa todos os setores como vazios
    for (const id of Object.keys(SECTOR_DEFINITIONS) as SectorId[]) {
      this.progress.sectors[id] = emptySector(id);
    }
  }

  /* ------------------------------------------------------------- carga / salva */

  async load(): Promise<void> {
    try {
      const knowledge = await readAIKnowledge(this.gameKey);
      const missionRecord = knowledge.find(
        (k) => k.entityType === 'MISSION_PROGRESS',
      );
      if (missionRecord) {
        const saved = JSON.parse(missionRecord.powerEffect) as Partial<MissionProgress>;
        this.progress = {
          ...DEFAULT_MISSION,
          ...saved,
          sectors: { ...DEFAULT_MISSION.sectors, ...saved.sectors },
        };
        // Garante que todos os setores existam
        for (const id of Object.keys(SECTOR_DEFINITIONS) as SectorId[]) {
          if (!this.progress.sectors[id]) {
            this.progress.sectors[id] = emptySector(id);
          }
        }
      }
    } catch {
      // Sem dados salvos: começa do zero
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await upsertAIKnowledge(this.gameKey, {
        entityType: 'MISSION_PROGRESS',
        entityLabel: 'Progresso da missão 100%',
        powerId: 'mission-progress',
        powerName: 'Missão Completa',
        powerEffect: JSON.stringify(this.progress),
        roomId: this.progress.currentSector ? 0 : -1,
      });
      this.dirty = false;
    } catch {
      // Ignora erro de gravação
    }
  }

  reset(): void {
    this.progress = { ...DEFAULT_MISSION };
    for (const id of Object.keys(SECTOR_DEFINITIONS) as SectorId[]) {
      this.progress.sectors[id] = emptySector(id);
    }
    this.dirty = true;
  }

  /* ------------------------------------------------------------- setor atual */

  setCurrentSector(sectorId: SectorId | null): void {
    this.progress.currentSector = sectorId;
    if (sectorId && !this.progress.sectors[sectorId]) {
      this.progress.sectors[sectorId] = emptySector(sectorId);
    }
    this.dirty = true;
  }

  getCurrentSector(): SectorProgress | null {
    if (!this.progress.currentSector) return null;
    return this.progress.sectors[this.progress.currentSector] ?? null;
  }

  /* ------------------------------------------------------------- terminais */

  activateTerminal(sectorId: SectorId, letter: 'A' | 'N' | 'D' | 'S'): void {
    const sector = this.progress.sectors[sectorId];
    if (!sector) return;

    switch (letter) {
      case 'A':
        sector.terminals.A = true;
        break;
      case 'N':
        // Só permite ativar N se o A já foi ativado neste setor
        if (!sector.terminals.A) return;
        sector.terminals.N = true;
        break;
      case 'D':
        if (!sector.terminals.A) return;
        sector.terminals.D = true;
        break;
      case 'S':
        if (!sector.terminals.A) return;
        sector.terminals.S = true;
        break;
    }

    this.updateSectorCompletion(sectorId);
    this.dirty = true;
  }

  isTerminalActivated(sectorId: SectorId, letter: 'A' | 'N' | 'D' | 'S'): boolean {
    return this.progress.sectors[sectorId]?.terminals[letter] ?? false;
  }

  /** O terminal A é o gate do setor: sem ele, N/D/S não podem ser ativados. */
  canActivateTerminalInSector(sectorId: SectorId, letter: 'A' | 'N' | 'D' | 'S'): boolean {
    if (letter === 'A') return true;
    return this.progress.sectors[sectorId]?.terminals.A ?? false;
  }

  /** Quais terminais ainda estão pendentes neste setor? */
  pendingTerminals(sectorId: SectorId): ('A' | 'N' | 'D' | 'S')[] {
    const sector = this.progress.sectors[sectorId];
    if (!sector) return [];
    const result: ('A' | 'N' | 'D' | 'S')[] = [];
    if (!sector.terminals.A) result.push('A');
    if (!sector.terminals.N && sector.terminals.A) result.push('N');
    if (!sector.terminals.D && sector.terminals.A) result.push('D');
    if (!sector.terminals.S && sector.terminals.A) result.push('S');
    return result;
  }

  /** O próximo terminal que deve ser ativado neste setor (ou null se nenhum). */
  nextTerminalInSector(sectorId: SectorId): 'A' | 'N' | 'D' | 'S' | null {
    const pendings = this.pendingTerminals(sectorId);
    return pendings.length > 0 ? pendings[0] : null;
  }

  /* ------------------------------------------------------------- itens */

  collectItem(sectorId: SectorId | null, itemType: string): void {
    if (sectorId) {
      const sector = this.progress.sectors[sectorId];
      if (sector) {
        sector.itemsCollected = Math.min(sector.itemsCollected + 1, sector.itemsTotal);
        this.updateSectorCompletion(sectorId);
      }
    }

    // Contadores globais
    switch (itemType) {
      case 'energy-tank':
        this.progress.energyTanksCollected += 1;
        break;
      case 'reserve-tank':
        this.progress.reserveTanksCollected += 1;
        break;
      case 'missile':
        this.progress.missilesCollected += 1;
        break;
      case 'super':
        this.progress.supersCollected += 1;
        break;
      case 'power-bomb':
        this.progress.powerBombsCollected += 1;
        break;
      default:
        if (!this.progress.abilitiesCollected.includes(itemType)) {
          this.progress.abilitiesCollected.push(itemType);
        }
        break;
    }
    this.dirty = true;
  }

  /* ------------------------------------------------------------- chefes */

  defeatBoss(sectorId: SectorId | null): void {
    this.progress.bossesDefeated += 1;
    if (sectorId) {
      const sector = this.progress.sectors[sectorId];
      if (sector) {
        sector.bossesDefeated = Math.min(sector.bossesDefeated + 1, sector.bossesKnown);
        this.updateSectorCompletion(sectorId);
      }
    }
    this.dirty = true;
  }

  /* ------------------------------------------------------------- energia e reserva */

  setEnergyFull(sectorId: SectorId | null, full: boolean): void {
    if (sectorId) {
      const sector = this.progress.sectors[sectorId];
      if (sector) sector.energyFull = full;
      this.updateSectorCompletion(sectorId);
    }
    this.dirty = true;
  }

  setReserveFull(sectorId: SectorId | null, full: boolean): void {
    if (sectorId) {
      const sector = this.progress.sectors[sectorId];
      if (sector) sector.reserveFull = full;
      this.updateSectorCompletion(sectorId);
    }
    this.dirty = true;
  }

  /* ------------------------------------------------------------- conclusão */

  private updateSectorCompletion(sectorId: SectorId): void {
    const sector = this.progress.sectors[sectorId];
    if (!sector) return;

    const allTerminals = sector.terminals.A && sector.terminals.N &&
                         sector.terminals.D && sector.terminals.S;
    const allItems = sector.itemsCollected >= sector.itemsTotal;
    const allBosses = sector.bossesDefeated >= sector.bossesKnown;
    const energyOk = sector.energyFull;
    const reserveOk = sector.reserveFull;

    sector.completed = allTerminals && allItems && allBosses && energyOk && reserveOk;
  }

  private updateMissionCompletion(): void {
    const sectors = Object.values(this.progress.sectors);
    const allSectorsCompleted = sectors.every((s) => s.completed);
    const allBosses = this.progress.bossesDefeated >= this.progress.bossesKnown;

    this.progress.missionComplete =
      allSectorsCompleted && allBosses && this.progress.endgameReached;

    this.progress.updatedAt = Date.now();
    this.dirty = true;
  }

  setEndgameReached(reached: boolean): void {
    this.progress.endgameReached = reached;
    this.updateMissionCompletion();
  }

  /* ------------------------------------------------------------- consultas */

  getProgress(): MissionProgress {
    return { ...this.progress };
  }

  getCompletedSectors(): SectorId[] {
    return Object.entries(this.progress.sectors)
      .filter(([, s]) => s.completed)
      .map(([id]) => id as SectorId);
  }

  getPendingSectors(): SectorId[] {
    return Object.entries(this.progress.sectors)
      .filter(([, s]) => !s.completed)
      .map(([id]) => id as SectorId);
  }

  /** O próximo setor que ainda não foi completado (ordem fixa). */
  nextPendingSector(): SectorId | null {
    const order: SectorId[] = ['SRX', 'NOC', 'CRT', 'NOR', 'WST', 'EAS', 'MET'];
    for (const id of order) {
      if (!this.progress.sectors[id]?.completed) return id;
    }
    return null;
  }

  /** Missão 100% completa? */
  isMissionComplete(): boolean {
    return this.progress.missionComplete;
  }

  /** Percentual de conclusão da missão (0-100). */
  getCompletionPct(): number {
    const sectors = Object.values(this.progress.sectors);
    if (sectors.length === 0) return 0;
    const completed = sectors.filter((s) => s.completed).length;
    return Math.round((completed / sectors.length) * 100);
  }

  /** Resumo textual da missão para a UI. */
  getMissionSummary(): string {
    const completed = this.getCompletedSectors().length;
    const total = Object.keys(SECTOR_DEFINITIONS).length;
    const pct = this.getCompletionPct();
    const pending = this.getPendingSectors();
    const next = pending.length > 0 ? pending[0] : null;

    let summary = `Missão 100%: ${completed}/${total} setores (${pct}%)`;
    if (next) {
      const sector = this.progress.sectors[next];
      const nextTerminal = this.nextTerminalInSector(next);
      summary += ` · Próximo: ${sector?.name ?? next}`;
      if (nextTerminal) {
        summary += ` (terminal ${nextTerminal} pendente)`;
      }
    }
    if (this.progress.missionComplete) {
      summary += ' · MISSÃO COMPLETA — hora de voltar para casa';
    }
    return summary;
  }
}

/* ------------------------------------------------------------------ instância global */

const missionInstances = new Map<string, MissionSystem>();

export function getMissionSystem(gameKey: string): MissionSystem {
  let instance = missionInstances.get(gameKey);
  if (!instance) {
    instance = new MissionSystem(gameKey);
    missionInstances.set(gameKey, instance);
  }
  return instance;
}

export function resetMissionSystem(gameKey?: string): void {
  if (gameKey) {
    missionInstances.delete(gameKey);
  } else {
    missionInstances.clear();
  }
}