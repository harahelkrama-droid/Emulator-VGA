/**
 * mapStrategy.ts — navegação de exploração com o mapa do jogo como referência.
 *
 * Módulo PURO (sem emulador, sem DOM, síncrono): recebe observações e devolve decisões.
 * O `LocalVisionAgent` é quem coleta as observações e aplica as decisões.
 *
 * Três responsabilidades, todas dirigidas pelo objetivo do projeto:
 *
 *   1. SABER SE ESTÁ PERDIDO  → detectLost()
 *      Não é "ficou parado": é andar sem descobrir sala nova, oscilar entre duas salas
 *      ou raspar na mesma parede. Cada causa tem uma recuperação diferente.
 *
 *   2. LER O MAPA DO JOGO     → readMapScreen()
 *      A tela de mapa do Super Metroid (START) pinta sala descoberta em rosa e sala ainda
 *      não mapeada em azul, com o ponto de Samus piscando em branco. Classificar esses
 *      pixels devolve (a) quanta área já foi revelada e (b) para onde está a massa de
 *      "desconhecido" em relação a Samus — que é exatamente a direção que a exploração
 *      deve favorecer. As cores da paleta variam por área, então "descoberto" é tratado
 *      como "qualquer coisa clara que não é o azul do mapa vazio".
 *
 *   3. DECIDIR O PRÓXIMO PASSO → planNextTarget() / buildChecklist()
 *      Checklist do objetivo (tanques, expansões de míssil/super/bomba, reservas,
 *      terminais de energia, chefes) + rota BFS no grafo de salas + BACKLOG: porta que não
 *      abre agora por falta de habilidade/munição não é descartada, é guardada com o motivo
 *      e reaberta quando o item chega. Cores de porta segundo o manual:
 *        azul = feixe ou bomba · vermelha = 5 mísseis · verde = 1 super míssil
 *        amarela = 1 power bomb · rosa = destravada · enferrujada = bloqueada
 */

/* ------------------------------------------------------------------ portas */

export type DoorColor = 'BLUE' | 'RED' | 'GREEN' | 'YELLOW' | 'PINK' | 'CORRODED' | 'UNKNOWN';
export type DoorNeed = 'NONE' | 'MISSILES' | 'SUPERS' | 'POWER_BOMBS' | 'BOMB_OR_BEAM' | 'BLOCKED' | 'UNKNOWN';

export interface DoorGate {
  color: DoorColor;
  need: DoorNeed;
  /** munição consumida por atravessar (o jogo gasta ao abrir a porta) */
  amount: number;
  /** rótulo curto para o HUD/explanação da decisão */
  label: string;
  /** só o item basta (munição se repõe em estação) ou precisa ter a munição AGORA? */
  needsAmmoNow: boolean;
}

/** Tabela do manual do Super Metroid, seção "Opening Hatches". */
export function gateForDoor(color: DoorColor, blockedByWall: boolean): DoorGate {
  // Uma porta vermelha/verde/amarela FECHADA é uma comporta a ser aberta (o leitor de WRAM
  // vê o bloco sólido e reporta blockedByWall), não uma parede: só confiamos em
  // blockedByWall quando a cor não diz nada de útil.
  if (blockedByWall && (color === 'UNKNOWN' || color === 'PINK' || color === 'CORRODED')) {
    return { color, need: 'BLOCKED', amount: 0, label: 'porta vedada (parede/bloco quebrável)', needsAmmoNow: false };
  }
  switch (color) {
    case 'RED':
      return { color, need: 'MISSILES', amount: 5, label: 'vermelha · 5 mísseis', needsAmmoNow: true };
    case 'GREEN':
      return { color, need: 'SUPERS', amount: 1, label: 'verde · 1 super míssil', needsAmmoNow: true };
    case 'YELLOW':
      return { color, need: 'POWER_BOMBS', amount: 1, label: 'amarela · 1 power bomb', needsAmmoNow: true };
    case 'BLUE':
      return { color, need: 'BOMB_OR_BEAM', amount: 0, label: 'azul · feixe ou bomba', needsAmmoNow: false };
    case 'PINK':
      return { color, need: 'NONE', amount: 0, label: 'aberta', needsAmmoNow: false };
    case 'CORRODED':
      return { color, need: 'BLOCKED', amount: 0, label: 'enferrujada · sem volta', needsAmmoNow: false };
    case 'UNKNOWN':
    default:
      return { color, need: 'UNKNOWN', amount: 0, label: 'cor desconhecida · testando', needsAmmoNow: false };
  }
}

export interface GateLoadout {
  hasMissileLauncher: boolean;
  hasSuperMissiles: boolean;
  hasPowerBombs: boolean;
  hasBombs: boolean;
  hasMorphBall: boolean;
  missiles: number;
  supers: number;
  powerBombs: number;
}

export interface GateCheck {
  /** dá para atravessar agora, neste tick? */
  openableNow: boolean;
  /** vai dar para atravessar quando a capacidade existir (munição se repõe)? */
  reachableEventually: boolean;
  /** o que falta, em uma frase; vazio quando nada falta */
  missing: string;
}

/** Duas perguntas diferentes: "abre agora?" e "um dia abre?". Ver nota no topo do módulo. */
export function checkGate(gate: DoorGate, lo: GateLoadout): GateCheck {
  switch (gate.need) {
    case 'NONE':
    case 'UNKNOWN':
      return { openableNow: true, reachableEventually: true, missing: '' };
    case 'BOMB_OR_BEAM':
      return { openableNow: true, reachableEventually: true, missing: '' };
    case 'BLOCKED':
      return {
        openableNow: false,
        reachableEventually: lo.hasMorphBall && lo.hasBombs,
        missing:
          lo.hasMorphBall && lo.hasBombs
            ? 'precisa explodir o bloco (bombas)'
            : 'bloco quebrável · falta morph ball + bombas',
      };
    case 'MISSILES': {
      const has = lo.hasMissileLauncher;
      return {
        openableNow: has && lo.missiles >= gate.amount,
        reachableEventually: has,
        missing: has
          ? `faltam ${Math.max(0, gate.amount - lo.missiles)} míssel(is) para a porta vermelha`
          : 'porta vermelha exige Missile Launcher',
      };
    }
    case 'SUPERS': {
      const has = lo.hasSuperMissiles;
      return {
        openableNow: has && lo.supers >= gate.amount,
        reachableEventually: has,
        missing: has
          ? `falta(m) ${Math.max(0, gate.amount - lo.supers)} super míssil(is) para a porta verde`
          : 'porta verde exige Super Missiles',
      };
    }
    case 'POWER_BOMBS': {
      const has = lo.hasPowerBombs;
      return {
        openableNow: has && lo.powerBombs >= gate.amount,
        reachableEventually: has,
        missing: has
          ? `falta(m) ${Math.max(0, gate.amount - lo.powerBombs)} power bomb(s) para a porta amarela`
          : 'porta amarela exige Power Bombs',
      };
    }
    default:
      return { openableNow: true, reachableEventually: true, missing: '' };
  }
}

/**
 * Classifica a cor de uma região do frame (recorte ao redor da porta).
 * Retorna null quando a região é escura demais para afirmar — o agente trata null como
 * "não sei", nunca como "azul".
 */
export function classifyDoorColor(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius = 7,
): DoorColor | null {
  let n = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let bright = 0;
  for (let y = Math.max(0, Math.round(cy - radius)); y <= Math.min(height - 1, Math.round(cy + radius)); y += 1) {
    for (let x = Math.max(0, Math.round(cx - radius)); x <= Math.min(width - 1, Math.round(cx + radius)); x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const lum = (r + g + b) / 3;
      if (lum < 34) continue; // fundo/fenda escura não conta
      n += 1;
      red += r;
      green += g;
      blue += b;
      if (lum > 150) bright += 1;
    }
  }
  if (n < 12) return null;
  red /= n;
  green /= n;
  blue /= n;

  // rosa do manual ("área descoberta") e enferrujado marrom são tons quentes com azul alto/baixo
  if (red > 120 && blue > 90 && green < red * 0.8 && green < blue * 0.95) return 'PINK';
  if (red > 110 && green < 70 && blue < 80) return 'RED';
  if (green > 110 && red < 110 && blue < 110) return 'GREEN';
  if (red > 140 && green > 120 && blue < 90) return 'YELLOW';
  if (blue > 110 && red < 100) return 'BLUE';
  if (red > 70 && red > green && green >= blue && bright / n < 0.15) return 'CORRODED';
  return 'UNKNOWN';
}

/* -------------------------------------------------------------- estar perdido */

export type LostCause = 'OSCILLATION' | 'NO_PROGRESS' | 'STALL' | 'CORNER' | 'REENTERED_DOOR';

export interface LostInput {
  /** ticks desde a última sala nunca antes vista */
  ticksSinceNewRoom: number;
  /** ticks sem progresso mensurável (item, habilidade, dano em chefe, sala nova) */
  ticksSinceProgress: number;
  /** histórico recente de ids de sala, mais antigo primeiro */
  roomTrail: number[];
  /** ticks preso no mesmo lugar (sem deslocamento líquido) */
  positionStallTicks: number;
  /** há chefe vivo na sala (não adianta "consultar mapa" no meio da luta) */
  bossEngaged: boolean;
  /** em luta com mob */
  inCombat: boolean;
  /** cutscene/menu/consulta de mapa em andamento */
  busy: boolean;
}

export interface LostVerdict {
  lost: boolean;
  cause: LostCause | null;
  /** 0..3 — 2+ justifica interromper a heurística e consultar o mapa */
  severity: number;
  note: string;
}

const LOST_NEW_ROOM_TICKS = 900;
const LOST_PROGRESS_TICKS = 1200;
const LOST_STALL_TICKS = 240;

/** Conta ids repetidos na cauda da trilha: oscilar entre {A,B} aparece como 2 únicos em 12. */
function oscillation(trail: number[]): { cycles: number; unique: number } {
  const win = trail.slice(-12);
  if (win.length < 8) return { cycles: 0, unique: win.length };
  const unique = new Set(win).size;
  const cycles = Math.round(win.length / Math.max(1, unique));
  // 12 visitas todas à mesma sala NÃO é oscilação: é falta de progresso (STALL)
  return { cycles: unique === 1 ? 0 : cycles, unique };
}

export function detectLost(i: LostInput): LostVerdict {
  if (i.busy || i.bossEngaged) {
    return { lost: false, cause: null, severity: 0, note: 'ocupado · não interrompe para ler o mapa' };
  }
  const osc = oscillation(i.roomTrail);
  const repeatedRooms = osc.unique <= 2 && osc.cycles >= 4;
  const noNewRoom = i.ticksSinceNewRoom >= LOST_NEW_ROOM_TICKS;
  const noProgress = i.ticksSinceProgress >= LOST_PROGRESS_TICKS;
  const stalled = i.positionStallTicks >= LOST_STALL_TICKS;

  let severity = 0;
  let cause: LostCause | null = null;
  let note = '';
  if (repeatedRooms) {
    severity += 2;
    cause = 'OSCILLATION';
    note = `oscilando entre ${osc.unique} sala(s) em ${i.roomTrail.slice(-12).length} visitas`;
  }
  if (stalled) {
    severity += repeatedRooms ? 1 : 2;
    cause = cause ?? (i.inCombat ? 'CORNER' : 'STALL');
    note = note || `sem deslocamento por ${i.positionStallTicks} ticks`;
  }
  if (noNewRoom) {
    severity += 1;
    cause = cause ?? 'NO_PROGRESS';
    note = note || `${Math.round(i.ticksSinceNewRoom / 10)}s sem descobrir sala nova`;
  }
  if (noProgress && !noNewRoom) {
    severity += 1;
    cause = cause ?? 'NO_PROGRESS';
    note = note || 'nada de novo (item/habilidade/chefe) há muito tempo';
  }
  if (i.inCombat && !repeatedRooms && !stalled) {
    severity = Math.min(3, severity + 1);
    cause = cause ?? 'REENTERED_DOOR';
  }
  severity = Math.min(3, severity);
  return { lost: severity >= 2, cause: severity >= 2 ? cause : null, severity, note: note || 'progresso normal' };
}

/* ------------------------------------------------------------- leitura do mapa */

export type MapHintDir = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';

export interface MapReading {
  ok: boolean;
  /** % de salas reveladas que já estão "descobertas" (rosa) — cobertura do que o mapa mostra */
  coveragePct: number;
  /** pixels de área azul (ainda não mapeada) e rosa (mapeada) */
  bluePx: number;
  pinkPx: number;
  /** posição do cursor/ponto de Samus na tela, se o classificador achou */
  samus: { x: number; y: number } | null;
  /** para onde está a maior massa de "desconhecido" a partir de Samus */
  hint: { dir: MapHintDir; score: number; label: string } | null;
  note: string;
}

/** Margens da área útil do mapa (o cabeçalho e a barra de status não são sala). */
const MAP_TOP = 0.2;
const MAP_BOTTOM = 0.86;

function isMapBlue(r: number, g: number, b: number, lum: number): boolean {
  return lum > 24 && lum < 190 && b > r + 22 && b > g + 12;
}

function isMapLight(r: number, g: number, b: number, lum: number): boolean {
  // "descoberto": qualquer coisa clara que não seja o azul do vazio
  return lum >= 96 && !isMapBlue(r, g, b, lum);
}

export function readMapScreen(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): MapReading {
  const empty: MapReading = {
    ok: false,
    coveragePct: 0,
    bluePx: 0,
    pinkPx: 0,
    samus: null,
    hint: null,
    note: 'sem frame para ler o mapa',
  };
  if (!rgba || rgba.length === 0 || width <= 0 || height <= 0) return empty;

  const y0 = Math.floor(height * MAP_TOP);
  const y1 = Math.floor(height * MAP_BOTTOM);
  let blue = 0;
  let pink = 0;
  let ink = 0;
  let blueCx = 0;
  let blueCy = 0;
  // grade grossa de tinta: texto de cabeçalho concentra tudo em poucas células
  const gridCols = 8;
  const gridRows = 6;
  const inkGrid = new Float32Array(gridCols * gridRows);

  // amostragem 2×2 para caber no orçamento de um tick
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const lum = (r + g + b) / 3;
      if (lum < 24) continue;
      const gx = Math.min(gridCols - 1, Math.floor((x / width) * gridCols));
      const gy = Math.min(gridRows - 1, Math.floor(((y - y0) / Math.max(1, y1 - y0)) * gridRows));
      inkGrid[gy * gridCols + gx] += 1;
      ink += 1;
      if (isMapBlue(r, g, b, lum)) {
        blue += 1;
        blueCx += x;
        blueCy += y;
      } else if (isMapLight(r, g, b, lum)) {
        pink += 1;
      }
    }
  }

  const seen = blue + pink;
  if (seen < 60) {
    return { ...empty, note: 'tela atual não parece o mapa (pouca tinta)' };
  }
  const coveragePct = Math.round((pink / seen) * 100);

  // ponto de Samus: o pixel mais claro isolado (pisca em branco)
  let sx = 0;
  let sy = 0;
  let sLum = -1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const lum = (r + g + b) / 3;
      if (lum < 215) continue;
      if (lum > sLum) {
        sLum = lum;
        sx = x;
        sy = y;
      }
    }
  }
  const samus = sLum >= 215 ? { x: sx, y: sy } : null;

  let gridMax = 0;
  for (let k = 0; k < inkGrid.length; k += 1) gridMax = Math.max(gridMax, inkGrid[k]);
  if (gridMax > ink * 0.55 && pink < 240) {
    return { ...empty, note: 'tela com texto concentrado · não é o mapa' };
  }

  let hint: MapReading['hint'] = null;
  if (blue >= 24) {
    const ax = blueCx / blue;
    const ay = blueCy / blue;
    const ox = (samus?.x ?? width / 2) - ax; // >0 ⇒ desconhecido à esquerda
    const oy = (samus?.y ?? (y0 + y1) / 2) - ay; // >0 ⇒ desconhecido acima
    const horiz = Math.abs(ox);
    const vert = Math.abs(oy);
    const dir: MapHintDir = horiz >= vert ? (ox > 0 ? 'LEFT' : 'RIGHT') : oy > 0 ? 'UP' : 'DOWN';
    const dominant = Math.max(horiz, vert) / Math.max(1, horiz + vert);
    const strength = Math.min(1, blue / Math.max(1, blue + pink) + 0.25) * dominant;
    if (strength > 0.12) {
      hint = {
        dir,
        score: Math.round(strength * 100) / 100,
        label: `desconhecido a ${
          dir === 'LEFT' ? 'esquerda' : dir === 'RIGHT' ? 'direita' : dir === 'UP' ? 'acima' : 'abaixo'
        } de Samus (${coveragePct}% do mapa coberto)`,
      };
    }
  }

  return {
    ok: true,
    coveragePct,
    bluePx: blue * 4,
    pinkPx: pink * 4,
    samus,
    hint,
    note: hint ? `mapa lido · ${hint.label}` : `mapa lido · sem área desconhecida visível (${coveragePct}% coberto)`,
  };
}

/* ------------------------------------------------------------------- checklist */

/** Totais do Super Metroid vanilla para 100% (46×5=230 mísseis, 10×5 super, 10×5 bombas). */
export const COMPLETION_TOTALS = {
  missileExpansions: 46,
  superExpansions: 10,
  bombExpansions: 10,
  energyTanks: 14,
  reserveTanks: 4,
} as const;

export const CORE_ABILITIES = [
  { bit: 'MORPH_BALL', label: 'Morph Ball' },
  { bit: 'BOMBS', label: 'Bombs' },
  { bit: 'HI_JUMP', label: 'Hi-Jump Boots' },
  { bit: 'SPACE_JUMP', label: 'Space Jump' },
  { bit: 'SPRING_BALL', label: 'Spring Ball' },
  { bit: 'VARIA', label: 'Varia Suit' },
  { bit: 'GRAVITY', label: 'Gravity Suit' },
  { bit: 'SCREW', label: 'Screw Attack' },
  { bit: 'GRAPPLE', label: 'Grappling Beam' },
  { bit: 'XRAY', label: 'X-Ray Scope' },
  { bit: 'CHARGE', label: 'Charge Beam' },
  { bit: 'ICE', label: 'Ice Beam' },
  { bit: 'WAVE', label: 'Wave Beam' },
  { bit: 'SPAZER', label: 'Spazer' },
] as const;

export type CoreAbilityBit = (typeof CORE_ABILITIES)[number]['bit'];

export interface ChecklistProgress {
  maxHealth: number;
  maxReserve: number;
  maxMissiles: number;
  maxSupers: number;
  maxPowerBombs: number;
  /** habilidades presentes (bit → true) */
  abilities: Partial<Record<CoreAbilityBit, boolean>>;
  /** chefes vencidos (vínculo sala→estratégia do codex) */
  bossesDefeated: number;
  bossesKnown: number;
  /** painéis/terminais de energia já acionados */
  terminalsDone: number;
  terminalsKnown: number;
  /** salas conhecidas no grafo ainda não entraram */
  roomsUnvisited: number;
}

export interface ChecklistItem {
  id: string;
  kind: 'TANK' | 'RESERVE' | 'MISSILE' | 'SUPER' | 'BOMB' | 'ABILITY' | 'BOSS' | 'TERMINAL' | 'MAP';
  label: string;
  have: number;
  total: number;
  done: boolean;
  note: string;
  /** peso relativo na prioridade de exploração */
  weight: number;
}

function tanks(maxHealth: number): number {
  return Math.max(0, Math.floor((maxHealth - 99) / 100));
}

export function buildChecklist(p: ChecklistProgress): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const et = tanks(p.maxHealth);
  items.push({
    id: 'energy-tanks',
    kind: 'TANK',
    label: 'Tanques de energia',
    have: et,
    total: COMPLETION_TOTALS.energyTanks,
    done: et >= COMPLETION_TOTALS.energyTanks,
    note: `vida máxima ${p.maxHealth} (99 + 100×tanques)`,
    // energia é o que sustenta tudo o resto: sem tanque não se passa de Phantoon/Mother Brain
    weight: 10,
  });
  const rt = Math.max(0, Math.floor(p.maxReserve / 100));
  items.push({
    id: 'reserve-tanks',
    kind: 'RESERVE',
    label: 'Tanques de reserva',
    have: rt,
    total: COMPLETION_TOTALS.reserveTanks,
    done: p.maxReserve <= 0 ? true : rt >= COMPLETION_TOTALS.reserveTanks,
    note: p.maxReserve <= 0 ? 'nenhum reservatório (opcional, mas conta no 100%)' : `reserva ${p.maxReserve}`,
    weight: 4,
  });
  const pushCap = (
    id: string,
    kind: ChecklistItem['kind'],
    label: string,
    cap: number,
    total: number,
    weight: number,
  ) => {
    const have = Math.floor(cap / 5);
    items.push({
      id,
      kind,
      label,
      have,
      total,
      done: have >= total,
      note: `capacidade atual ${cap}`,
      weight,
    });
  };
  pushCap('missiles', 'MISSILE', 'Expansões de míssil', p.maxMissiles, COMPLETION_TOTALS.missileExpansions, 8);
  pushCap('supers', 'SUPER', 'Expansões de super míssil', p.maxSupers, COMPLETION_TOTALS.superExpansions, 8);
  pushCap('bombs', 'BOMB', 'Expansões de power bomb', p.maxPowerBombs, COMPLETION_TOTALS.bombExpansions, 7);

  for (const ab of CORE_ABILITIES) {
    const have = p.abilities[ab.bit] === true;
    items.push({
      id: `ability-${ab.bit.toLowerCase()}`,
      kind: 'ABILITY',
      label: ab.label,
      have: have ? 1 : 0,
      total: 1,
      done: have,
      note: have ? 'equipada' : 'procurar no mapa',
      // sem a habilidade, metade do mapa é muro: destravá-la destrava rota
      weight: have
        ? 0
        : ab.bit === 'MORPH_BALL' || ab.bit === 'BOMBS' || ab.bit === 'VARIA'
          ? 9
          : 6,
    });
  }

  items.push({
    id: 'bosses',
    kind: 'BOSS',
    label: 'Chefes derrotados',
    have: p.bossesDefeated,
    total: Math.max(p.bossesKnown, p.bossesDefeated),
    done: p.bossesKnown > 0 && p.bossesDefeated >= p.bossesKnown,
    note: p.bossesKnown === 0 ? 'nenhum chefe encontrado ainda no grafo' : `${p.bossesDefeated} de ${p.bossesKnown} encontrados`,
    weight: p.bossesKnown > p.bossesDefeated ? 11 : 0,
  });
  items.push({
    id: 'terminals',
    kind: 'TERMINAL',
    label: 'Terminais / energia reativada',
    have: p.terminalsDone,
    total: Math.max(p.terminalsKnown, p.terminalsDone),
    done: p.terminalsKnown > 0 && p.terminalsDone >= p.terminalsKnown,
    note: p.terminalsKnown === 0 ? 'nenhum painel visto' : `${p.terminalsDone} de ${p.terminalsKnown} painéis acionados`,
    // é isto que o pedido chama de "reativar todas as energias": cada painel economiza backtracking
    weight: p.terminalsKnown > p.terminalsDone ? 6 : 0,
  });
  items.push({
    id: 'map',
    kind: 'MAP',
    label: 'Salas por visitar',
    have: 0,
    total: p.roomsUnvisited,
    done: p.roomsUnvisited === 0,
    note: p.roomsUnvisited === 0 ? 'nada conhecido pendente no grafo' : `${p.roomsUnvisited} sala(s) conhecida(s) ainda não entrada(s)`,
    weight: p.roomsUnvisited > 0 ? 5 : 0,
  });
  return items;
}

/** Objetivo completo? (o "depois volta" do pedido: só volta quando não falta mais nada aberto) */
export function missionComplete(list: ChecklistItem[]): boolean {
  return list.every((it) => it.done || it.total === 0);
}

export function openObjectives(list: ChecklistItem[]): ChecklistItem[] {
  return list
    .filter((it) => !it.done && it.total > 0)
    .sort((a, b) => b.weight - a.weight || b.total - b.have - (a.total - a.have));
}

export function describeChecklistForUi(list: ChecklistItem[]): string {
  const open = openObjectives(list);
  if (open.length === 0) return 'checklist completo · hora de voltar e fechar o jogo';
  return open.slice(0, 3).map((it) => `${it.label} ${it.have}/${it.total}`).join(' · ');
}

/* ------------------------------------------------------------- grafo e rota */

export interface NavDoor {
  key: string;
  color: DoorColor;
  /** a sala do outro lado já é conhecida? */
  targetRoomId?: number;
  blockedByWall: boolean;
  /** amostras de cor insuficientes para afirmar */
  unknownColor?: boolean;
}

export interface NavRoom {
  id: number;
  areaIndex: number;
  visited: boolean;
  /** itens vistos e ainda não coletados */
  itemsPending: number;
  bossName?: string;
  bossDefeated?: boolean;
  /** painéis/terminais não acionados */
  terminalsPending: number;
  doors: NavDoor[];
  /** custo de perigo (dano sofrido ali antes) */
  danger: number;
}

export interface NavGraph {
  current: number;
  rooms: Map<number, NavRoom>;
}

export interface NavBacklogEntry {
  roomId: number;
  doorKey: string;
  need: DoorNeed;
  missing: string;
  /** o que libera: bit de habilidade (se aplicável) ou 'AMMO' */
  unlockBy: CoreAbilityBit | 'AMMO';
  note: string;
}

export interface NavTarget {
  kind: 'ITEM' | 'BOSS' | 'TERMINAL' | 'FRONTIER' | 'RETARGET' | 'SHIP';
  roomId: number;
  /** sequência de portas a atravessar a partir da sala atual */
  route: string[];
  firstDoor: string | null;
  label: string;
  reason: string;
  score: number;
}

export interface PlanInput {
  graph: NavGraph;
  loadout: GateLoadout;
  /** viés vindo da leitura da tela de mapa */
  hint: { dir: MapHintDir; score: number } | null;
  /** sala→chefe do codex, para priorizar sala de chefe não vencida */
  bossRooms: Map<number, { name: string; defeated: boolean }>;
  /** se true, o objetivo é voltar pelo caminho mais seguro (nada pendente) */
  everythingDone: boolean;
  /** salas já registradas como "esperar habilidade" */
  backlogKeys: Set<string>;
  /** primeira sala descoberta da sessão (onde a nave/rota inicial ficou) */
  startRoomId?: number;
}

export interface PlanResult {
  target: NavTarget | null;
  backlog: NavBacklogEntry[];
  note: string;
}

export function directionForDoor(key: string): 'LEFT' | 'RIGHT' | 'UP' | 'DOWN' {
  const k = key.toUpperCase();
  if (k.includes('LEFT')) return 'LEFT';
  if (k.includes('UP')) return 'UP';
  if (k.includes('DOWN')) return 'DOWN';
  return 'RIGHT';
}

/**
 * Melhor porta desconhecida de uma sala: a que aponta para onde o mapa diz que há
 * "desconhecido" ganha, as opostas perdem. Sem leitura de mapa, ordem natural.
 */
function pickUnknownDoor(
  room: NavRoom,
  lo: GateLoadout,
  hint: { dir: MapHintDir; score: number } | null,
): NavDoor | null {
  const open = room.doors.filter((d) => d.targetRoomId === undefined && !d.blockedByWall);
  if (open.length === 0) return null;
  if (!hint) return open[0]!;
  let best: NavDoor | null = null;
  let bestScore = -Infinity;
  for (const d of open) {
    const dir = directionForDoor(d.key);
    let sc = 0;
    if (dir === hint.dir) sc += 12 * hint.score;
    else if (
      (dir === 'LEFT' && hint.dir === 'RIGHT')
      || (dir === 'RIGHT' && hint.dir === 'LEFT')
      || (dir === 'UP' && hint.dir === 'DOWN')
      || (dir === 'DOWN' && hint.dir === 'UP')
    ) {
      sc -= 6 * hint.score;
    }
    // porta que dá para abrir agora tem vantagem; a que só falta munição ainda é candidata
    const chk = edgeOpenable(room, d, lo);
    if (chk.openableNow) sc += 4;
    else if (!chk.reachableEventually) sc -= 20;
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  return best;
}

function edgeOpenable(room: NavRoom, door: NavDoor, lo: GateLoadout): GateCheck {
  const gate = gateForDoor(door.color, door.blockedByWall);
  return checkGate(gate, lo);
}

/** BFS no grafo de salas usando só arestas que dá para atravessar agora. */
export function bfsRoute(graph: NavGraph, from: number, to: number, lo: GateLoadout): string[] | null {
  if (from === to) return [];
  const queue: Array<{ id: number; path: string[] }> = [{ id: from, path: [] }];
  const seen = new Set<number>([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const room = graph.rooms.get(cur.id);
    if (!room) continue;
    if (cur.path.length > 14) continue; // mapa grande: corta busca sem valor
    for (const door of room.doors) {
      const next = door.targetRoomId;
      if (next === undefined || seen.has(next)) continue;
      if (!edgeOpenable(room, door, lo).openableNow) continue;
      const path = [...cur.path, door.key];
      if (next === to) return path;
      seen.add(next);
      queue.push({ id: next, path });
    }
  }
  return null;
}

interface RoomScore {
  score: number;
  kind: NavTarget['kind'];
  label: string;
  reason: string;
}

/**
 * Escolhe o próximo alvo de exploração.
 *
 * Ordem de valor (a do pedido): item/coleta → terminal de energia → chefe → fronteira
 * desconhecida, sempre só por rotas atravessáveis. O que não dá para abrir agora vira
 * backlog com o motivo e o item que destrava.
 */
export function planNextTarget(input: PlanInput): PlanResult {
  const { graph, loadout, hint, bossRooms, everythingDone } = input;
  const here = graph.rooms.get(graph.current);
  const backlog: NavBacklogEntry[] = [];
  if (!here) return { target: null, backlog, note: 'sala atual sem registro no grafo' };

  const scoreRoom = (room: NavRoom, route: string[], isCurrent = false): RoomScore | null => {
    const dist = route.length;
    let score = -dist * 3 - room.danger * 2;
    let kind: NavTarget['kind'] = 'FRONTIER';
    let label = `sala 0x${room.id.toString(16)}`;
    const reasons: string[] = [];

    if (room.itemsPending > 0) {
      score += 34 + 6 * room.itemsPending;
      kind = 'ITEM';
      label = `${room.itemsPending} item(ns) · ${label}`;
      reasons.push('coleta pendente');
    }
    const boss = bossRooms.get(room.id);
    if (boss && !boss.defeated) {
      score += 44;
      kind = 'BOSS';
      label = `chefe ${boss.name} · ${label}`;
      reasons.push('chefe declarado pelo codex');
    } else if (room.bossName && !room.bossDefeated) {
      score += 44;
      kind = 'BOSS';
      label = `chefe ${room.bossName} · ${label}`;
      reasons.push('chefe visto na sala');
    }
    if (room.terminalsPending > 0) {
      score += 22;
      if (kind === 'FRONTIER') kind = 'TERMINAL';
      reasons.push('reativar energia');
    }
    if (!room.visited && !isCurrent) {
      score += 16;
      reasons.push('sala nova');
    }
    // fronteira: portas ainda sem sala do outro lado
    let unknownDoors = 0;
    for (const d of room.doors) {
      if (d.targetRoomId === undefined && !d.blockedByWall) {
        unknownDoors += 1;
        if (hint) {
          const dir = directionForDoor(d.key);
          if (dir === hint.dir) score += 12 * hint.score;
          else if (
            (dir === 'LEFT' && hint.dir === 'RIGHT')
            || (dir === 'RIGHT' && hint.dir === 'LEFT')
            || (dir === 'UP' && hint.dir === 'DOWN')
            || (dir === 'DOWN' && hint.dir === 'UP')
          ) {
            score -= 6 * hint.score;
          }
        }
      }
    }
    if (unknownDoors > 0) {
      score += 10 + 4 * unknownDoors;
      reasons.push(`${unknownDoors} porta(s) sem mapa`);
    } else if (reasons.length === 0 || (isCurrent && room.itemsPending === 0 && room.terminalsPending === 0 && !(room.bossName && !room.bossDefeated))) {
      // sala atual sem nada a fazer aqui: não serve de alvo (senão o plano diz "fique onde está")
      return null;
    }
    return { score, kind, label, reason: reasons.join(' · ') };
  };

  // 1) alvos conhecidos no grafo
  let best: { room: NavRoom; route: string[]; s: RoomScore } | null = null;
  for (const room of graph.rooms.values()) {
    if (room.id === graph.current) {
      const s = scoreRoom(room, [], true);
      if (s && (!best || s.score > best.s.score)) best = { room, route: [], s };
      continue;
    }
    const route = bfsRoute(graph, graph.current, room.id, loadout);
    if (!route) {
      // sem rota atravessável: registra o gargalo (primeira porta que não abre no caminho)
      const gate = blockedDoorToward(graph, graph.current, room.id, loadout);
      if (gate) backlog.push(gate);
      continue;
    }
    const s = scoreRoom(room, route);
    if (!s) continue;
    if (!best || s.score > best.s.score) best = { room, route, s };
  }

  if (everythingDone) {
    // "e depois volta": o plano precisa de um destino, senão o modo SHIP só muda o rótulo.
    // Casa = primeira sala da sessão (nave/rota de Tourian); se a rota não é mais conhecida,
    // seguimos para a fronteira mais próxima em vez de ficar parado.
    const home = input.startRoomId ?? graph.current;
    const route = home !== graph.current ? (bfsRoute(graph, graph.current, home, loadout) ?? []) : [];
    const localDoor = route.length === 0 ? pickUnknownDoor(here, loadout, hint) : null;
    const door = route[0] ?? localDoor?.key ?? null;
    return {
      target: {
        kind: 'SHIP',
        roomId: route.length > 0 ? home : graph.current,
        route: route.length > 0 ? route : door ? [door] : [],
        firstDoor: door,
        label: route.length > 0 ? `voltar à sala 0x${home.toString(16)}` : 'nada pendente aqui',
        reason: route.length > 0
          ? 'checklist completo · voltar pelo caminho conhecido'
          : 'checklist completo · sem rota para casa: testar a porta que falta',
        score: 100,
      },
      backlog,
      note: 'checklist completo · modo retorno',
    };
  }

  if (best) {
    const wasBacklog = input.backlogKeys.has(`${best.room.id}`);
    // alvo na sala atual: o "primeiro passo" é a porta mais promissora daqui
    const localDoor = best.route.length === 0 ? pickUnknownDoor(best.room, loadout, hint) : null;
    return {
      target: {
        kind: best.s.kind,
        roomId: best.room.id,
        route: best.route.length === 0 && localDoor ? [localDoor.key] : best.route,
        firstDoor: (best.route[0] ?? localDoor?.key) ?? null,
        label: best.s.label,
        reason: wasBacklog ? `backlog reaberto · ${best.s.reason}` : best.s.reason,
        score: Math.round(best.s.score * 10) / 10,
      },
      backlog,
      note: `alvo ${best.s.kind} · ${best.route.length} porta(s) · ${best.s.reason}`,
    };
  }

  // 2) nada pontual: a porta desconhecida que o mapa recomenda já é progresso
  const frontierDoor = pickUnknownDoor(here, loadout, hint);
  if (frontierDoor) {
    return {
      target: {
        kind: 'FRONTIER',
        roomId: here.id,
        route: [frontierDoor.key],
        firstDoor: frontierDoor.key,
        label: `porta ${frontierDoor.key} sem mapa`,
        reason: hint ? `fronteira · ${hint.dir} favorecida pelo mapa` : 'fronteira sem alvo conhecido',
        score: 8,
      },
      backlog,
      note: 'sem alvo conhecido · testando porta desconhecida',
    };
  }

  return { target: null, backlog, note: 'nada pendente no grafo · continue andando para descobrir salas' };
}

/** Acha a primeira porta do caminho até `to` que não dá para abrir agora. */
function blockedDoorToward(graph: NavGraph, from: number, to: number, lo: GateLoadout): NavBacklogEntry | null {
  const queue: Array<{ id: number; path: Array<{ key: string; roomId: number; door: NavDoor }> }> = [
    { id: from, path: [] },
  ];
  const seen = new Set<number>([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const room = graph.rooms.get(cur.id);
    if (!room) continue;
    if (cur.path.length > 14) continue;
    for (const door of room.doors) {
      const next = door.targetRoomId;
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const step = { key: door.key, roomId: room.id, door };
      if (next === to) {
        for (const st of [...cur.path, step]) {
          const fromRoom = graph.rooms.get(st.roomId);
          if (!fromRoom) continue;
          const chk = edgeOpenable(fromRoom, st.door, lo);
          if (!chk.openableNow && chk.reachableEventually) {
            const gate = gateForDoor(st.door.color, st.door.blockedByWall);
            const need = gate.need;
            return {
              roomId: st.roomId,
              doorKey: st.key,
              need,
              missing: chk.missing,
              unlockBy:
                need === 'MISSILES' || need === 'SUPERS' || need === 'POWER_BOMBS'
                  ? 'AMMO'
                  : need === 'BLOCKED'
                    ? 'BOMBS'
                    : 'MORPH_BALL',
              note: `porta ${gate.label} · sala 0x${st.roomId.toString(16)}`,
            };
          }
        }
        return null;
      }
      queue.push({ id: next, path: [...cur.path, step] });
    }
  }
  return null;
}

/** Quais itens recém-adquiridos reabrem entradas do backlog. */
export function reopenBacklog(
  backlog: NavBacklogEntry[],
  acquired: Partial<Record<DoorNeed | CoreAbilityBit, boolean>>,
): { keep: NavBacklogEntry[]; reopened: NavBacklogEntry[] } {
  const keep: NavBacklogEntry[] = [];
  const reopened: NavBacklogEntry[] = [];
  for (const e of backlog) {
    const ready =
      (e.need === 'MISSILES' && acquired.MISSILES === true)
      || (e.need === 'SUPERS' && acquired.SUPERS === true)
      || (e.need === 'POWER_BOMBS' && acquired.POWER_BOMBS === true)
      || (e.need === 'BLOCKED' && acquired.BOMBS === true)
      || (e.unlockBy !== 'AMMO' && acquired[e.unlockBy as CoreAbilityBit] === true);
    if (ready) reopened.push(e);
    else keep.push(e);
  }
  return { keep, reopened };
}

export function describeNavForUi(
  t: NavTarget | null,
  backlog: NavBacklogEntry[],
  reading: MapReading | null,
): string {
  const parts: string[] = [];
  if (t) parts.push(`${t.kind} · ${t.label}${t.route.length > 0 ? ` · rota ${t.route.join('→')}` : ''}`);
  else parts.push('sem alvo no grafo');
  if (backlog.length > 0) parts.push(`aguardando ${backlog.length} porta(s): ${backlog[0]!.missing}`);
  if (reading?.ok) parts.push(`mapa ${reading.coveragePct}% coberto`);
  return parts.join(' · ');
}
