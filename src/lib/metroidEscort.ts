/**
 * Escolta de Metroid: a decisão de "seguir o bicho" em vez de "atirar no bicho".
 *
 * De onde isto veio (frames reais do usuário, 27/11): na sala azul da Tourian a IA ficou
 * ~20 s parado/perdendo tiro no Metroid Ômega enquanto ele esperava ao lado, e na sala de
 * lava carmim ela travou na beira. Nos dois casos o erro é o mesmo: o Metroid Grande/Ômega
 * NÃO é um inimigo a matar nem um evento a esperar — no Super Metroid ele é o ROTEIRO. É ele
 * que abre o caminho (quebra as comportas), então quem tem que andar atrás dele é a
 * Samus. Matar um Metroid exige Ice Beam + míssil; sem isso, atirar nele é só perder tempo.
 *
 * O módulo é puro (decide intenção, não teclas) para poder ser testado sem emulador:
 *   npm run check:escort
 */
export type EscortKind = 'OMEGA' | 'BIG' | 'LARVA';

export interface EscortEntity {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  kind: EscortKind;
}

export interface EscortDoor {
  key: string;
  side: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
  x: number;
  y: number;
  open: boolean;
}

export interface EscortInput {
  samusX: number;
  samusY: number;
  /** o Metroid no frame atual (null = não está na tela) */
  entity: EscortEntity | null;
  /** ticks desde a última vez em que ele foi visto na sala atual */
  ticksSinceSeen: number;
  /** para onde ele saiu quando sumiu (direção do batente por onde passou) */
  lastExitDir: 'LEFT' | 'RIGHT' | null;
  doors: EscortDoor[];
  /** ela tem como matar (Ice Beam + míssil): sem isso atirar é desperdício */
  canKill: boolean;
  /** o dreno do prólogo ainda tem propósito (a SA-X vem e o resgate acontece) */
  drainResolvesRescue: boolean;
  /** a sala tem item/chefe/Core-X pendente: aí a escolta não tem pressa */
  roomHasPendingBusiness: boolean;
  /** ticks desde qualquer progresso mensurável (o "fica ali por bobagem") */
  ticksSinceProgress: number;
  /** largura da sala em px, para saber se ele está encostando numa saída */
  roomWidthPx: number;
}

export type EscortAction = 'NONE' | 'FOLLOW' | 'CHASE_DOOR' | 'HOLD' | 'FIGHT';

export interface EscortPlan {
  action: EscortAction;
  dir: 'LEFT' | 'RIGHT' | null;
  vertical: 'UP' | 'DOWN' | null;
  /** manter distância de segurança (o dreno acontece por contato — não queremos mais que isso) */
  keepDistance: boolean;
  /** enquanto escolta, mob no caminho não é combate: é atraso */
  ignoreMobs: boolean;
  /** a porta pela qual ele saiu (só vem preenchida em CHASE_DOOR) */
  doorKey: string | null;
  reason: string;
}

/** Quanto tempo esperando o dreno vale antes de virar perda de tempo. */
export const ESCORT_DRAIN_PATIENCE_TICKS = 420;
/** Janela em que ainda faz sentido correr atrás dele depois que sumiu da tela. */
/**
 * Única fonte da verdade sobre "dá para matar este Metroid": no Super Metroid o bicho só morre
 * CONGELADO + míssil. Atirar nele sem isso é o desperdício de tempo que o relato do usuário
 * aponta — então tanto a escolta quanto o ramo do ômega perguntam a esta função.
 * (0x0002 = Ice Beam em `beamsMask`.)
 */
export function metroidKillReady(beamsMask: number, missiles: number): boolean {
  return (beamsMask & 0x0002) !== 0 && missiles > 0;
}

export const ESCORT_MEMORY_TICKS = 260;
/** Distância em que a gente para de se aproximar (contato drena; não é o objetivo). */
export const ESCORT_MIN_DIST = 56;
export const ESCORT_MAX_DIST = 150;

const sideDoor = (doors: EscortDoor[], dir: 'LEFT' | 'RIGHT'): EscortDoor | null => {
  const want = dir === 'LEFT' ? ['LEFT', 'UP', 'DOWN'] : ['RIGHT', 'UP', 'DOWN'];
  // o batente do lado por onde ele saiu; se aquele lado não tem porta, qualquer aberta serve
  const onSide = doors.find((d) => d.side === dir);
  if (onSide) return onSide;
  return doors.find((d) => want.includes(d.side) && d.open) ?? doors.find((d) => d.open) ?? null;
};

export function decideEscort(i: EscortInput): EscortPlan {
  const idle: EscortPlan = {
    action: 'NONE',
    dir: null,
    vertical: null,
    keepDistance: false,
    ignoreMobs: false,
    doorKey: null,
    reason: '',
  };

  if (!i.entity) {
    if (i.ticksSinceSeen > ESCORT_MEMORY_TICKS) return idle;
    const dir = i.lastExitDir;
    if (!dir) return idle;
    const door = sideDoor(i.doors, dir);
    return {
      action: 'CHASE_DOOR',
      dir,
      vertical: null,
      keepDistance: false,
      ignoreMobs: true,
      doorKey: door?.key ?? null,
      reason: `Metroid saiu por ${dir === 'LEFT' ? 'esquerda' : 'direita'} · seguindo por ${
        door ? door.key : 'qualquer saída'
      }`,
    };
  }

  const ent = i.entity;
  const dx = ent.x - i.samusX;
  const dist = Math.abs(dx);
  const fleeing = Math.abs(ent.vx) > 0.25 && Math.sign(ent.vx) === Math.sign(dx || ent.vx);
  const atEdge = ent.x < 34 || ent.x > i.roomWidthPx - 34;

  // 1) prólogo: deixar drenar só vale enquanto o resgate da SA-X pode acontecer, e só por um
  //    tempo. Foi exatamente aqui que a IA travou na sala azul — o "HOLD" eterno esperando uma
  //    cura que não existe fora do prólogo.
  if (i.drainResolvesRescue && !i.roomHasPendingBusiness) {
    if (i.ticksSinceProgress < ESCORT_DRAIN_PATIENCE_TICKS) {
      return {
        action: 'HOLD',
        dir: dist > ESCORT_MIN_DIST ? (dx >= 0 ? 'RIGHT' : 'LEFT') : null,
        vertical: null,
        keepDistance: false,
        ignoreMobs: true,
        doorKey: null,
        reason: 'dreno do prólogo · ficando perto até o resgate (paciência limitada)',
      };
    }
  }

  // 2) ele está saindo da sala (fugindo e encostado num batente) ou passando por cima: corre
  //    atrás pela mesma porta, sem parar para atirar em nada
  if (fleeing && atEdge) {
    const dir: 'LEFT' | 'RIGHT' = ent.x < 34 ? 'LEFT' : 'RIGHT';
    const door = sideDoor(i.doors, dir);
    return {
      action: 'CHASE_DOOR',
      dir,
      vertical: null,
      keepDistance: false,
      ignoreMobs: true,
      doorKey: door?.key ?? null,
      reason: 'Metroid indo para a saída · escoltando em vez de atirar',
    };
  }

  // 3) só lutamos se dá para matar E ele está no caminho (entre a Samus e a saída/objetivo).
  //    Sem Ice Beam, atirar em Metroid é o "perder tempo por bobagem" do relato.
  if (i.canKill && dist < 96) {
    return {
      action: 'FIGHT',
      dir: dx >= 0 ? 'RIGHT' : 'LEFT',
      vertical: ent.y < i.samusY - 12 ? 'UP' : ent.y > i.samusY + 12 ? 'DOWN' : null,
      keepDistance: false,
      ignoreMobs: true,
      doorKey: null,
      reason: 'Metroid bloqueando o caminho e matável (gelo + míssil)',
    };
  }

  // 4) escolta: fica na zona de 56..150 px dele — perto o bastante para não perder o rastro,
  //    longe o bastante para não tomar dreno demais. Alinha a altura dele para não ficar
  //    preso na plataforma errada.
  let dir: 'LEFT' | 'RIGHT' | null = null;
  if (dist > ESCORT_MAX_DIST) dir = dx >= 0 ? 'RIGHT' : 'LEFT';
  else if (dist < ESCORT_MIN_DIST) dir = dx >= 0 ? 'LEFT' : 'RIGHT';
  return {
    action: 'FOLLOW',
    dir,
    vertical: ent.y < i.samusY - 14 ? 'UP' : ent.y > i.samusY + 14 ? 'DOWN' : null,
    keepDistance: true,
    ignoreMobs: true,
    doorKey: null,
    reason:
      dist > ESCORT_MAX_DIST
        ? 'escoltando o Metroid · alcançando'
        : dist < ESCORT_MIN_DIST
          ? 'escoltando o Metroid · abrindo distância (sem encher de dreno)'
          : 'escoltando o Metroid · no ritmo dele',
  };
}
