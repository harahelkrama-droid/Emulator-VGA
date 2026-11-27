/**
 * Autocorreção: a IA analisa a própria falha e muda o próprio comportamento no tick seguinte.
 *
 * Por que isto existe separado do resto: até aqui, cada paleta/limite errado que o agente
 * não conhecia precisava de um humano olhando um print (foi exatamente assim que a lava
 * carmim do X-Fusion foi corrigida — medir o frame, achar o corte, fixar o número). Este
 * módulo fecha o ciclo sem humano: o WRAM rotula o erro ("aqui doeu", "a porta que eu
 * chamei de vermelha estava aberta"), o frame fornece as features, e o ledger decide se
 * vale a pena mexer no parâmetro — com três regras que não são negociáveis:
 *
 *  1. **Não inventar.** Se as classes não separam (folga pequena, amostra suja), a correção
 *     vira recuo conservador (marcar célula perigosa), nunca um threshold novo.
 *  2. **Limitado.** Cada parâmetro tem teto/piso; a autocorreção anda o corte dentro da
 *     janela, não o joga para onde a estatística mandar.
 *  3. **Revisável.** Toda correção nasce ACTIVE; se a mesma falha se repete com ela ligada,
 *     escalamos uma vez e na segunda revertermos e abandonamos a tese — errar é permitido,
 *     insistir no erro não.
 *
 * O ledger é puro (nada de DOM/emulador) e devolve EFEITOS para o agente aplicar, então dá
 * para testar o raciocínio sozinho: `npm run check:selffix`.
 */
import {
  LAVA_CALIB_BASE,
  LAVA_CALIB_LIMITS,
  type DoorColor,
  type MoltenCalib,
} from './mapStrategy';

export type FaultKind =
  /** pisei/em cima de lava que o detector de cor não marcou — paleta desconhecida */
  | 'LAVA_UNSIGHTED'
  /** dano numa célula que o mapa de blocos + perigos dizia ser segura (espinho novo) */
  | 'HAZARD_BLIND'
  /** a cor amostrada da porta contradiz o estado real dela no WRAM */
  | 'DOOR_COLOR_WRONG'
  /** gastei munição na mesma porta N vezes sem nenhum efeito */
  | 'AMMO_WASTED'
  /** vou e volto entre as mesmas salas */
  | 'OSCILLATION'
  /** empurro o mesmo ponto sem me mover */
  | 'POSITION_STALL'
  /** morri / perdi itens (reset de energia) */
  | 'RESPAWN';

export interface FaultEvidence {
  kind: FaultKind;
  tick: number;
  roomId: number;
  /** bloco da sala envolvido (chão que doeu / célula da porta) */
  bx?: number;
  by?: number;
  hpLost?: number;
  /** `${side}@${bx}:${by}` como no WRAM */
  doorKey?: string;
  /** o que o pixel dizia da porta, antes da verdade do WRAM */
  colorSampled?: DoorColor;
  /** o que o WRAM dizia (verdade de campo) */
  doorOpen?: boolean;
  attempts?: number;
  /** calibração derivada do frame que machucou; null = as classes não separaram */
  calib?: MoltenCalib | null;
  hurtHex?: string;
  safeHex?: string;
  gap?: number;
}

export type CorrectionStatus = 'ACTIVE' | 'HELPED' | 'REVERTED';

export interface CorrectionRecord {
  id: number;
  kind: FaultKind;
  /** 'sessão' (paleta é global) ou `sala N` (comportamento local) */
  scope: string;
  /** leitura humana do diagnóstico, com os números medidos */
  diagnosis: string;
  /** o que foi mudado, em palavras */
  action: string;
  appliedTick: number;
  status: CorrectionStatus;
  /** quantas vezes a falha voltou com a correção ligada */
  faultsWhileActive: number;
  /** o efeito aplicado. Em hazardPenAdd é o DELTA que este registro somou (a escalada soma
   * dentro do mesmo registro), para que a reversão desfaça tudo que a tese fez — não só o 1º passo. */
  lavaCalib?: MoltenCalib;
  lavaCalibPrev?: MoltenCalib;
  hazardPenAdd?: number;
  doorOverride?: { doorKey: string; color: DoorColor };
  doorSampleRadius?: number;
  unbreakable?: string;
  escalated?: boolean;
}

/** O que o agente deve aplicar agora. Efeitos são absolutos quando fazem sentido ser. */
export interface CorrectionEffect {
  record?: CorrectionRecord;
  /** adotar esta calibração de lava (também reflete ao reverter: volta para `lavaCalibPrev`) */
  lavaCalib?: MoltenCalib;
  /** novo total de penalidade de perigo (o agente lê isto no pathfinding) */
  hazardPenAdd?: number;
  doorOverride?: { doorKey: string; color: DoorColor };
  /** raio de amostragem da cor da porta (encolhe para fugir de pulga/lava no batente) */
  doorSampleRadius?: number;
  /** célula a tratar como inquebrável / a adicionar às perigosas */
  unbreakable?: string;
  dangerCells?: string[];
  /** true = o ledger pediu para FORÇAR uma re-leitura do frame com a calibração nova */
  rescanNow?: boolean;
}

/** Quantos ticks uma correção precisa ficar sem repetir a falha para virar conhecimento. */
export const CORRECTION_PROVE_TICKS = 900;
/** Nunca acumular correções ativas além disto (memória limitada, comportamento auditável). */
export const CORRECTION_MAX_ACTIVE = 6;

export interface SelfCorrectionSnapshotView {
  id: number;
  kind: string;
  scope: string;
  diagnosis: string;
  action: string;
  status: CorrectionStatus;
}

export class SelfCorrectionLedger {
  private records_: CorrectionRecord[] = [];
  private nextId_ = 1;
  private strikes = new Map<string, number>();
  private hazardPenAdd_ = 0;
  private lavaCalib_: MoltenCalib = { ...LAVA_CALIB_BASE };
  private doorSampleRadius_ = 7;
  private doorOverrides = new Map<string, DoorColor>();
  /** true enquanto houver correção pendente de aplicar (o agente consome e limpa) */
  private dirtyRescan = false;

  get records(): readonly CorrectionRecord[] {
    return this.records_;
  }

  get lavaCalib(): MoltenCalib {
    return this.lavaCalib_;
  }

  get hazardPenAdd(): number {
    return this.hazardPenAdd_;
  }

  get doorSampleRadius(): number {
    return this.doorSampleRadius_;
  }

  doorOverrideFor(doorKey: string): DoorColor | undefined {
    return this.doorOverrides.get(doorKey);
  }

  get needsRescan(): boolean {
    return this.dirtyRescan;
  }

  clearRescanFlag(): void {
    this.dirtyRescan = false;
  }

  /** Registra um erro e devolve o que mudar por causa dele. */
  observe(e: FaultEvidence): CorrectionEffect {
    const scopedByRoom = e.kind !== 'LAVA_UNSIGHTED' && e.kind !== 'RESPAWN';
    const scope = scopedByRoom ? `sala ${e.roomId}` : 'sessão';
    const key = `${e.kind}:${scope}`;
    const strikes = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, strikes);

    const live = this.records_.find(
      (r) => `${r.kind}:${r.scope}` === key && r.status !== 'REVERTED',
    );
    if (live && live.status === 'HELPED') {
      // já aprendido: não re-registrar, mas se o problema voltou com o conhecimento ligado,
      // o conhecimento não bastava — volta a ACTIVE com uma escalada
      live.status = 'ACTIVE';
      live.faultsWhileActive += 1;
      return this.escalate(live, e);
    }
    if (live) return this.escalate(live, e);
    // tese já enterrada neste escopo não volta: errar é permitido, insistir no mesmo erro não
    const burned = this.records_.find(
      (r) => `${r.kind}:${r.scope}` === key && r.status === 'REVERTED',
    );
    if (burned) return this.fallback(e);

    if (this.records_.filter((r) => r.status === 'ACTIVE').length >= CORRECTION_MAX_ACTIVE) {
      // já temos correções demais no ar: só o recuo conservador, sem nova tese
      return this.fallback(e);
    }

    const rec = this.decide(e, scope);
    if (!rec) return this.fallback(e);
    this.records_.push(rec);
    if (this.records_.length > 40) this.prune();
    return this.apply(rec, e);
  }

  /** Chamado a cada tick com um sinal de progresso (sala nova, item, porta aberta). */
  review(tick: number, progressed: boolean): CorrectionEffect | null {
    let out: CorrectionEffect | null = null;
    for (const r of this.records_) {
      if (r.status !== 'ACTIVE') continue;
      if (!progressed || tick - r.appliedTick < CORRECTION_PROVE_TICKS) continue;
      r.status = 'HELPED';
      // se a correção colou, a penalidade de perigo dela vira permanente e o raio de
      // amostragem fica pequeno (evitou o problema real)
      out = out ?? {};
      if (r.lavaCalib) out.lavaCalib = r.lavaCalib;
      if (typeof r.hazardPenAdd === 'number') out.hazardPenAdd = this.hazardPenAdd_;
      if (typeof r.doorSampleRadius === 'number') out.doorSampleRadius = r.doorSampleRadius;
    }
    return out;
  }

  /** Leitura para o HUD: o diagnóstico e a ação de cada correção, mais velha primeiro. */
  describeForUi(limit = 4): SelfCorrectionSnapshotView[] {
    return this.records_
      .slice(-limit)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        scope: r.scope,
        diagnosis: r.diagnosis,
        action: r.action,
        status: r.status,
      }));
  }

  private decide(e: FaultEvidence, scope: string): CorrectionRecord | null {
    const base = (kind: FaultKind, diagnosis: string, action: string): CorrectionRecord => ({
      id: this.nextId_++,
      kind,
      scope,
      diagnosis,
      action,
      appliedTick: e.tick,
      status: 'ACTIVE',
      faultsWhileActive: 0,
    });

    switch (e.kind) {
      case 'LAVA_UNSIGHTED': {
        if (!e.calib) return null; // o frame não separou as classes: não inventar número
        const c = e.calib;
        const rec = base(
          'LAVA_UNSIGHTED',
          `pisei em lava que o detector não via: chão medido ${e.safeHex ?? '?'} vs lava ${e.hurtHex ?? '?'}` +
            ` (folga de R ${(e.gap ?? 0).toFixed(0)})`,
          `corte do corpo da lava r>${this.lavaCalib_.minRed} → r>${c.minRed}, g<${c.maxGreen} ` +
            `(derivado do frame que me machucou, na sala ${e.roomId})`,
        );
        rec.lavaCalib = { ...c };
        return rec;
      }
      case 'HAZARD_BLIND':
        return base(
          'HAZARD_BLIND',
          `dano (${e.hpLost ?? '?'} HP) em ${e.bx},${e.by} que o mapa de blocos + meu mapa de perigo` +
            ' chamavam de seguro',
          'pousos nesse tipo de célula passam a custar mais caro no pathfinding',
        );
      case 'DOOR_COLOR_WRONG': {
        const truth: DoorColor = e.doorOpen ? 'PINK' : 'UNKNOWN';
        return base(
          'DOOR_COLOR_WRONG',
          `amostra do batente dizia ${e.colorSampled ?? '?'} e o WRAM diz ${
            e.doorOpen ? 'porta ABERTA' : 'porta fechada'
          }`,
          `cor da porta ${e.doorKey ?? '?'} corrigida para ${truth} e raio da amostra ` +
            `${this.doorSampleRadius_} → ${Math.max(3, this.doorSampleRadius_ - 1)} (menos contaminação de pulga/lava)`,
        );
      }
      case 'AMMO_WASTED':
        return base(
          'AMMO_WASTED',
          `${e.attempts ?? '?'} tiros na porta ${e.doorKey ?? '?'} sem nenhum efeito`,
          'deixo de tratar aquela célula como quebrável — o plano tem que achar outra rota',
        );
      case 'OSCILLATION':
        return base(
          'OSCILLATION',
          `entrando em círculo na sala ${e.roomId} (trilha de salas se repete)`,
          'reancoro a rota pelo mapa e inverte o lado preferido antes de continuar',
        );
      case 'POSITION_STALL':
        return base(
          'POSITION_STALL',
          `empurrando o mesmo ponto ${e.bx},${e.by} por tempo demais`,
          'marco a célula como perdida por enquanto e forço releitura do frame',
        );
      case 'RESPAWN':
        return base(
          'RESPAWN',
          'morri com itens na mão — a rota que me levou até aqui estava errada',
          'a sala entra na lista de perigos e o retorno a ela exige progresso novo',
        );
      default:
        return null;
    }
  }

  private apply(rec: CorrectionRecord, e: FaultEvidence): CorrectionEffect {
    const eff: CorrectionEffect = { record: rec };
    switch (rec.kind) {
      case 'LAVA_UNSIGHTED': {
        if (rec.lavaCalib) {
          rec.lavaCalibPrev = { ...this.lavaCalib_ };
          this.lavaCalib_ = { ...rec.lavaCalib };
          eff.lavaCalib = this.lavaCalib_;
          eff.rescanNow = true;
          this.dirtyRescan = true;
        }
        break;
      }
      case 'HAZARD_BLIND': {
        this.hazardPenAdd_ = Math.min(6, this.hazardPenAdd_ + 2);
        rec.hazardPenAdd = (rec.hazardPenAdd ?? 0) + 2;
        eff.hazardPenAdd = this.hazardPenAdd_;
        break;
      }
      case 'DOOR_COLOR_WRONG': {
        if (e.doorKey) {
          const color: DoorColor = e.doorOpen ? 'PINK' : 'UNKNOWN';
          rec.doorOverride = { doorKey: e.doorKey, color };
          this.doorOverrides.set(e.doorKey, color);
          eff.doorOverride = rec.doorOverride;
          this.doorSampleRadius_ = Math.max(3, this.doorSampleRadius_ - 1);
          rec.doorSampleRadius = this.doorSampleRadius_;
          eff.doorSampleRadius = this.doorSampleRadius_;
        }
        break;
      }
      case 'AMMO_WASTED': {
        if (e.bx !== undefined && e.by !== undefined) {
          rec.unbreakable = `${e.roomId}:${e.bx},${e.by}`;
          eff.unbreakable = rec.unbreakable;
        }
        break;
      }
      case 'RESPAWN': {
        this.hazardPenAdd_ = Math.min(6, this.hazardPenAdd_ + 1);
        rec.hazardPenAdd = (rec.hazardPenAdd ?? 0) + 1;
        eff.hazardPenAdd = this.hazardPenAdd_;
        break;
      }
      default:
        break;
    }
    return eff;
  }

  /** A mesma falha battendo de novo com a correção ligada: escala 1x, depois desiste. */
  private escalate(rec: CorrectionRecord, e: FaultEvidence): CorrectionEffect {
    rec.faultsWhileActive += 1;
    const eff: CorrectionEffect = { record: rec };
    if (rec.faultsWhileActive <= 1 && !rec.escalated) {
      rec.escalated = true;
      switch (rec.kind) {
        case 'LAVA_UNSIGHTED': {
          // relaxa mais um passo, DENTRO da janela, e aceita superfície mais estreita
          const cur = rec.lavaCalib ?? this.lavaCalib_;
          const next: MoltenCalib = {
            minRed: clamp(Math.min(cur.minRed, e.calib?.minRed ?? cur.minRed - 10), LAVA_CALIB_LIMITS.minRedMin, LAVA_CALIB_LIMITS.minRedMax),
            maxGreen: clamp(cur.maxGreen + 20, LAVA_CALIB_LIMITS.maxGreenMin, LAVA_CALIB_LIMITS.maxGreenMax),
            minRun: clamp(cur.minRun - 1, LAVA_CALIB_LIMITS.minRunMin, LAVA_CALIB_LIMITS.minRunMax),
          };
          rec.lavaCalib = next;
          rec.lavaCalibPrev = { ...this.lavaCalib_ };
          this.lavaCalib_ = next;
          eff.lavaCalib = next;
          eff.rescanNow = true;
          this.dirtyRescan = true;
          rec.action = `relaxei de novo o corte: r>${next.minRed}, g<${next.maxGreen}, corrida≥${next.minRun}`;
          break;
        }
        case 'HAZARD_BLIND': {
          this.hazardPenAdd_ = Math.min(6, this.hazardPenAdd_ + 2);
          rec.hazardPenAdd = (rec.hazardPenAdd ?? 0) + 2; // a escalada é da conta desta tese
          eff.hazardPenAdd = this.hazardPenAdd_;
          break;
        }
        default:
          break;
      }
      return eff;
    }
    // segunda repetição: minha tese estava errada — desfaz e recua
    rec.status = 'REVERTED';
    const undo: CorrectionEffect = this.revert(rec);
    undo.record = rec;
    const cell = e.bx !== undefined && e.by !== undefined ? `${e.roomId}:${e.bx},${e.by}` : null;
    undo.dangerCells = cell ? [cell] : [];
    undo.rescanNow = true;
    this.dirtyRescan = true;
    rec.action = `${rec.action} · REVERTIDA: a correção não resolveu, marcando o lugar como perigoso`;
    return undo;
  }

  private revert(rec: CorrectionRecord): CorrectionEffect {
    const eff: CorrectionEffect = {};
    if (rec.kind === 'LAVA_UNSIGHTED') {
      this.lavaCalib_ = { ...(rec.lavaCalibPrev ?? LAVA_CALIB_BASE) };
      eff.lavaCalib = { ...this.lavaCalib_ };
    }
    if (typeof rec.hazardPenAdd === 'number') {
      // desfaz TUDO que esta tese somou (aplicação + escaladas), sem ir abaixo de zero
      this.hazardPenAdd_ = Math.max(0, this.hazardPenAdd_ - rec.hazardPenAdd);
      rec.hazardPenAdd = undefined;
      eff.hazardPenAdd = this.hazardPenAdd_;
    }
    if (rec.doorOverride) {
      this.doorOverrides.delete(rec.doorOverride.doorKey);
      rec.doorOverride = undefined;
    }
    return eff;
  }

  /** Sem tese possível: só o recuo conservador, que nunca piora nada. */
  private fallback(e: FaultEvidence): CorrectionEffect {
    const cell = e.bx !== undefined && e.by !== undefined ? `${e.roomId}:${e.bx},${e.by}` : null;
    return { dangerCells: cell ? [cell] : [], rescanNow: true };
  }

  private prune(): void {
    const dead = this.records_.filter((r) => r.status === 'REVERTED');
    for (const d of dead.slice(0, Math.max(0, this.records_.length - 40))) {
      const i = this.records_.indexOf(d);
      if (i >= 0) this.records_.splice(i, 1);
    }
  }

  /** Estado serializável (o painel de debug e o save da sessão usam isto). */
  serialize(): Array<Record<string, unknown>> {
    return this.records_.map((r) => ({ ...r }));
  }

  restore(rows: unknown): void {
    if (!Array.isArray(rows)) return; // save corrompido/ausente: caderno vazio, agente segue
    for (const row of rows as Array<Partial<CorrectionRecord> & { lavaCalib?: MoltenCalib }>) {
      if (!row || typeof row.id !== 'number' || !row.kind) continue;
      const rec: CorrectionRecord = {
        id: row.id,
        kind: row.kind as FaultKind,
        scope: row.scope ?? 'sessão',
        diagnosis: row.diagnosis ?? '',
        action: row.action ?? '',
        appliedTick: row.appliedTick ?? 0,
        status: row.status === 'HELPED' ? 'HELPED' : 'ACTIVE',
        faultsWhileActive: row.faultsWhileActive ?? 0,
        lavaCalib: row.lavaCalib,
        lavaCalibPrev: row.lavaCalibPrev,
        hazardPenAdd: row.hazardPenAdd,
        doorSampleRadius: row.doorSampleRadius,
        escalated: row.escalated,
      };
      this.records_.push(rec);
      this.nextId_ = Math.max(this.nextId_, rec.id + 1);
      if (rec.kind === 'LAVA_UNSIGHTED' && rec.lavaCalib && rec.status === 'HELPED') {
        this.lavaCalib_ = { ...rec.lavaCalib };
      }
      if (typeof rec.hazardPenAdd === 'number' && rec.status === 'HELPED') {
        this.hazardPenAdd_ = Math.min(6, this.hazardPenAdd_ + rec.hazardPenAdd);
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
