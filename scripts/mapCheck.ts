/**
 * Checagens do módulo de navegação/mapa (puro, sem emulador):
 *
 *   npm run check:map
 *
 * Cobre as três decisões que o agente passa a tomar com este módulo:
 * porta × item necessário, leitura da tela de mapa (START) e o que fazer quando está perdido.
 */
import {
  bfsRoute,
  buildChecklist,
  checkGate,
  classifyDoorColor,
  detectLost,
  directionForDoor,
  gateForDoor,
  missionComplete,
  openObjectives,
  lakeTopBlock,
  MOLTEN_CELL,
  MOLTEN_COLS,
  planNextTarget,
  readMapScreen,
  senseMoltenLake,
  reopenBacklog,
  describeChecklistForUi,
  XFUSION_TOTALS,
  XFUSION_SECTORS,
  type GateLoadout,
  type NavDoor,
  type NavGraph,
  type NavRoom,
} from '../src/lib/mapStrategy';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const FULL: GateLoadout = {
  hasMissileLauncher: true,
  hasSuperMissiles: true,
  hasPowerBombs: true,
  hasBombs: true,
  hasMorphBall: true,
  missiles: 30,
  supers: 4,
  powerBombs: 2,
};
const NO_AMMO: GateLoadout = { ...FULL, hasMissileLauncher: false, hasSuperMissiles: false, hasPowerBombs: false, missiles: 0, supers: 0, powerBombs: 0 };

/* ------------------------------------------------------------- pintura sintética */

const W = 256;
const H = 224;
type RGB = [number, number, number];

function blank(c: RGB = [16, 18, 24]): { rgba: Uint8ClampedArray; put: (x: number, y: number, c: RGB) => void } {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const put = (x: number, y: number, col: RGB) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    rgba[i] = col[0];
    rgba[i + 1] = col[1];
    rgba[i + 2] = col[2];
    rgba[i + 3] = 255;
  };
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) put(x, y, c);
  return { rgba, put };
}

function rect(put: (x: number, y: number, c: RGB) => void, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) put(x, y, c);
}

const ROSE: RGB = [210, 120, 190];
const MAP_BLUE: RGB = [40, 60, 170];
const DOOR_RED: RGB = [200, 30, 30];
const DOOR_GREEN: RGB = [40, 200, 60];
const DOOR_YELLOW: RGB = [220, 200, 40];
const WHITE: RGB = [255, 255, 255];

/* --------------------------------------------------------------- A. portas */

section('A. Porta × item necessário (manual: vermelho=5 mísseis, verde=super, amarela=power bomb)');
check('azul abre com feixe', checkGate(gateForDoor('BLUE', false), NO_AMMO).openableNow);
check(
  'vermelha com 4 mísseis NÃO abre agora, mas abre um dia',
  (() => {
    const c = checkGate(gateForDoor('RED', false), { ...FULL, missiles: 4 });
    return !c.openableNow && c.reachableEventually && c.missing.includes('faltam 1');
  })(),
);
check('vermelha com 5 abre (e custa 5)', (() => {
  const g = gateForDoor('RED', false);
  return g.amount === 5 && checkGate(g, { ...FULL, missiles: 5 }).openableNow;
})());
check('verde sem Super Missiles vai para o backlog', !checkGate(gateForDoor('GREEN', false), { ...FULL, hasSuperMissiles: false, supers: 0 }).reachableEventually);
check('amarela exige power bomb na hora', !checkGate(gateForDoor('YELLOW', false), { ...FULL, powerBombs: 0 }).openableNow);
check('desconhecida com parede = bloqueada (e a cor prevalece sobre blockedByWall)', (() => {
  const wall = gateForDoor('UNKNOWN', true);
  const hatch = gateForDoor('RED', true);
  return wall.need === 'BLOCKED' && hatch.need === 'MISSILES';
})());
check('classifica vermelho do recorte da porta', classifyDoorColor(...paint(DOOR_RED)) === 'RED');
check('classifica verde', classifyDoorColor(...paint(DOOR_GREEN)) === 'GREEN');
check('classifica amarelo', classifyDoorColor(...paint(DOOR_YELLOW)) === 'YELLOW');
check('fundo escuro → null (não inventa cor)', classifyDoorColor(...paint([16, 18, 24], 3)) === null);

function paint(c: RGB, r = 8): [Uint8ClampedArray, number, number, number, number] {
  const { rgba, put } = blank();
  rect(put, 120 - r, 100 - r, 120 + r, 100 + r, c);
  return [rgba, W, H, 120, 100];
}

/* --------------------------------------------------------- B. perdido / mapa */

section('B. "Estou perdido" e a tela de mapa como referência');
check(
  'oscilar entre 2 salas = perdido por oscilação',
  (() => {
    const v = detectLost({
      ticksSinceNewRoom: 200,
      ticksSinceProgress: 200,
      roomTrail: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2],
      positionStallTicks: 0,
      bossEngaged: false,
      inCombat: false,
      busy: false,
    });
    return v.lost && v.cause === 'OSCILLATION';
  })(),
);
check(
  'andar sempre em sala nova não é perdido',
  !detectLost({
    ticksSinceNewRoom: 10,
    ticksSinceProgress: 10,
    roomTrail: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    positionStallTicks: 0,
    bossEngaged: false,
    inCombat: false,
    busy: false,
  }).lost,
);
check(
  'preso no mesmo lugar = STALL',
  (() => {
    const v = detectLost({
      ticksSinceNewRoom: 0,
      ticksSinceProgress: 10,
      roomTrail: [5, 5, 5, 5, 5, 5, 5, 5],
      positionStallTicks: 400,
      bossEngaged: false,
      inCombat: false,
      busy: false,
    });
    return v.lost && v.cause === 'STALL';
  })(),
);
check(
  'em luta de chefe nunca interrompe para ler mapa',
  (() => {
    const v = detectLost({
      ticksSinceNewRoom: 9999,
      ticksSinceProgress: 9999,
      roomTrail: [1, 1, 1, 1, 1, 1, 1, 1],
      positionStallTicks: 9999,
      bossEngaged: true,
      inCombat: true,
      busy: false,
    });
    return !v.lost && v.note.includes('ocupado');
  })(),
);

check(
  'mapa com desconhecido à ESQUERDA de Samus → hint LEFT',
  (() => {
    const { rgba, put } = blank();
    rect(put, 150, 60, 250, 180, ROSE); // área mapeada à direita
    rect(put, 8, 60, 90, 180, MAP_BLUE); // vazio à esquerda
    rect(put, 168, 110, 170, 112, WHITE); // ponto de Samus
    const r = readMapScreen(rgba, W, H);
    return r.ok && r.hint?.dir === 'LEFT' && r.coveragePct > 0 && r.coveragePct < 100;
  })(),
);
check(
  'mapa com desconhecido ACIMA (faixa larga) → hint UP',
  (() => {
    const { rgba, put } = blank();
    rect(put, 8, 46, 248, 70, MAP_BLUE);
    rect(put, 8, 90, 248, 180, ROSE);
    rect(put, 126, 100, 128, 102, WHITE);
    return readMapScreen(rgba, W, H).hint?.dir === 'UP';
  })(),
);
check('tela de jogo normal (escura) não é lida como mapa', (() => {
  const { rgba } = blank();
  return !readMapScreen(rgba, W, H).ok;
})());
check('mapa todo mapeado → cobertura 100% e sem hint', (() => {
  const { rgba, put } = blank();
  rect(put, 8, 60, 248, 180, ROSE);
  rect(put, 120, 110, 122, 112, WHITE);
  const r = readMapScreen(rgba, W, H);
  return r.ok && r.coveragePct >= 99 && r.hint === null;
})());

/* ---------------------------------------------------------- C. rota e alvo */

section('C. Rota no grafo, backlog e reabertura com o item certo');

function navRoom(id: number, over: Partial<NavRoom> = {}): NavRoom {
  return { id, areaIndex: 1, visited: true, itemsPending: 0, terminalsPending: 0, danger: 0, doors: [], ...over };
}
function navDoor(key: string, color: NavDoor['color'], targetRoomId?: number, blockedByWall = false): NavDoor {
  return { key, color, targetRoomId, blockedByWall };
}

check(
  'rota BFS escolhe a porta que leva ao item',
  (() => {
    const rooms = new Map<number, NavRoom>([
      [0x10, navRoom(0x10, { doors: [navDoor('LEFT', 'PINK', 0x09), navDoor('RIGHT', 'PINK', 0x11)] })],
      [0x11, navRoom(0x11, { visited: false, doors: [navDoor('LEFT', 'PINK', 0x10)] })],
      [0x09, navRoom(0x09, { doors: [navDoor('RIGHT', 'PINK', 0x10)] })],
    ]);
    const graph: NavGraph = { current: 0x10, rooms };
    const p = planNextTarget({ graph, loadout: FULL, hint: null, bossRooms: new Map(), everythingDone: false, backlogKeys: new Set() });
    return p.target !== null && p.target.route[0] !== 'LEFT';
  })(),
);
check(
  'porta vermelha sem 5 mísseis → backlog com o motivo e outro alvo escolhido',
  (() => {
    const rooms = new Map<number, NavRoom>([
      [0x10, navRoom(0x10, { doors: [navDoor('LEFT', 'PINK', 0x11), navDoor('RIGHT', 'RED', 0x12)] })],
      [0x11, navRoom(0x11, { itemsPending: 1, doors: [navDoor('RIGHT', 'PINK', 0x10)] })],
      [0x12, navRoom(0x12, { visited: false, itemsPending: 3, doors: [navDoor('LEFT', 'RED', 0x10)] })],
    ]);
    const p = planNextTarget({
      graph: { current: 0x10, rooms },
      loadout: { ...FULL, missiles: 2 },
      hint: null,
      bossRooms: new Map(),
      everythingDone: false,
      backlogKeys: new Set(),
    });
    return (
      p.backlog.length === 1
      && p.backlog[0]!.doorKey === 'RIGHT'
      && p.backlog[0]!.need === 'MISSILES'
      && p.target !== null
      && p.target.roomId === 0x11
    );
  })(),
);
check(
  'item/energia tem prioridade sobre chefe não vencido (missão principal)',
  (() => {
    const rooms = new Map<number, NavRoom>([
      [0x10, navRoom(0x10, { doors: [navDoor('LEFT', 'PINK', 0x11), navDoor('RIGHT', 'PINK', 0x12)] })],
      [0x11, navRoom(0x11, { itemsPending: 1, doors: [navDoor('RIGHT', 'PINK', 0x10)] })],
      [0x12, navRoom(0x12, { bossName: 'Kraid', doors: [navDoor('LEFT', 'PINK', 0x10)] })],
    ]);
    const p = planNextTarget({
      graph: { current: 0x10, rooms },
      loadout: FULL,
      hint: null,
      bossRooms: new Map([[0x12, { name: 'Kraid', defeated: false }]]),
      everythingDone: false,
      backlogKeys: new Set(),
    });
    // Missão principal: coletar itens e ativar energia antes de enfrentar chefes comuns
    return p.target?.kind === 'ITEM' && p.target.roomId === 0x11;
  })(),
);
check(
  'sala com perigo registrado custa mais caro (desvia antes de morrer de novo)',
  (() => {
    const mk = (danger: number) => {
      const rooms = new Map<number, NavRoom>([
        [0x10, navRoom(0x10, { doors: [navDoor('LEFT', 'PINK', 0x11), navDoor('RIGHT', 'PINK', 0x12)] })],
        [0x11, navRoom(0x11, { itemsPending: 1, danger, doors: [navDoor('RIGHT', 'PINK', 0x10)] })],
        [0x12, navRoom(0x12, { itemsPending: 1, doors: [navDoor('LEFT', 'PINK', 0x10)] })],
      ]);
      return planNextTarget({ graph: { current: 0x10, rooms }, loadout: FULL, hint: null, bossRooms: new Map(), everythingDone: false, backlogKeys: new Set() }).target?.roomId;
    };
    return mk(0) === 0x11 && mk(3) === 0x12;
  })(),
);
check('hint do mapa favorece a porta do mesmo lado', (() => {
  const mk = (hint: { dir: 'LEFT' | 'RIGHT'; score: number } | null) => {
    const rooms = new Map<number, NavRoom>([
      [0x10, navRoom(0x10, { doors: [navDoor('LEFT', 'PINK'), navDoor('RIGHT', 'PINK')] })],
    ]);
    return planNextTarget({ graph: { current: 0x10, rooms }, loadout: FULL, hint, bossRooms: new Map(), everythingDone: false, backlogKeys: new Set() }).target?.firstDoor;
  };
  return mk({ dir: 'LEFT', score: 1 }) === 'LEFT' && mk({ dir: 'RIGHT', score: 1 }) === 'RIGHT';
})());
check('bfsRoute só passa por porta que abre agora', (() => {
  const rooms = new Map<number, NavRoom>([
    [1, navRoom(1, { doors: [navDoor('RIGHT', 'YELLOW', 2)] })],
    [2, navRoom(2, { doors: [navDoor('LEFT', 'YELLOW', 1)] })],
  ]);
  const g: NavGraph = { current: 1, rooms };
  const withBomb = bfsRoute(g, 1, 2, FULL);
  const noBomb = bfsRoute(g, 1, 2, { ...FULL, hasPowerBombs: false, powerBombs: 0 });
  return withBomb?.join('>') === 'RIGHT' && noBomb === null;
})());
check('checklist completo → modo "voltar" com rota de verdade', (() => {
  const rooms = new Map<number, NavRoom>([
    [0x01, navRoom(0x01, { doors: [navDoor('RIGHT', 'PINK', 0x02)] })],
    [0x02, navRoom(0x02, { doors: [navDoor('LEFT', 'PINK', 0x01), navDoor('RIGHT', 'PINK', 0x03)] })],
    [0x03, navRoom(0x03, { doors: [navDoor('LEFT', 'PINK', 0x02)] })],
  ]);
  const p = planNextTarget({
    graph: { current: 0x03, rooms },
    loadout: FULL,
    hint: null,
    bossRooms: new Map(),
    everythingDone: true,
    backlogKeys: new Set(),
    startRoomId: 0x01,
  });
  return p.target?.kind === 'SHIP' && p.target.roomId === 0x01 && p.target.route.length === 2;
})());
check('reopenBacklog libera só o que o item destrava', (() => {
  const b = [
    { roomId: 0x12, doorKey: 'RIGHT', need: 'MISSILES' as const, missing: '', unlockBy: 'AMMO' as const, note: '' },
    { roomId: 0x13, doorKey: 'UP', need: 'POWER_BOMBS' as const, missing: '', unlockBy: 'AMMO' as const, note: '' },
  ];
  const r = reopenBacklog(b, { MISSILES: true });
  return r.reopened.length === 1 && r.reopened[0]!.doorKey === 'RIGHT' && r.keep.length === 1;
})());
check('directionForDoor mapeia os quatro lados', directionForDoor('UP_DOOR') === 'UP' && directionForDoor('LEFT') === 'LEFT' && directionForDoor('DOWN') === 'DOWN' && directionForDoor('RIGHT') === 'RIGHT');

/* ------------------------------------------------------- D. checklist do objetivo */

section('D. Checklist do objetivo (tanques, expansões, chefes, terminais)');
const partial = buildChecklist({
  maxHealth: 399,
  maxReserve: 200,
  maxMissiles: 100,
  maxSupers: 25,
  maxPowerBombs: 5,
  abilities: { MORPH_BALL: true, BOMBS: true, VARIA: true, SPACE_JUMP: true },
  bossesDefeated: 3,
  bossesKnown: 11,
  terminalsDone: 1,
  terminalsKnown: 4,
  roomsUnvisited: 6,
});
const get = (id: string) => partial.find((c) => c.id === id)!;
check('46/230 de mísseis = 20 expansões', get('missiles').have === 20 && get('missiles').total === 46);
check('3 de 14 tanques de energia', get('energy-tanks').have === 3);
check('2 de 4 reservas', get('reserve-tanks').have === 2);
check('chefes 3/11 é o item mais urgente', openObjectives(partial)[0]!.id === 'bosses');
check('gravidade/spazer aparecem como pendentes', get('ability-gravity').done === false && get('ability-spazer').done === false);
check('missão incompleta enquanto faltar coisa aberta', !missionComplete(partial));
check('resumo do HUD cita os três primeiros', describeChecklistForUi(partial).includes('Chefes derrotados 3/11'));
const doneList = buildChecklist({
  maxHealth: 1499,
  maxReserve: 400,
  maxMissiles: 230,
  maxSupers: 50,
  maxPowerBombs: 50,
  abilities: {
    MORPH_BALL: true, BOMBS: true, HI_JUMP: true, SPACE_JUMP: true, SPRING_BALL: true, VARIA: true, GRAVITY: true,
    SCREW: true, GRAPPLE: true, XRAY: true, CHARGE: true, ICE: true, WAVE: true, SPAZER: true,
  },
  bossesDefeated: 11,
  bossesKnown: 11,
  terminalsDone: 4,
  terminalsKnown: 4,
  roomsUnvisited: 0,
});
check('100% = missionComplete e HUD diz "voltar e fechar"', missionComplete(doneList) && describeChecklistForUi(doneList).includes('checklist completo'));

/* ------------------------------------ D2. perfil X-Fusion: totais conferidos no zerado 100% */
section('D2. Perfil X-Fusion: 47 mísseis e 7 Reserve-X (vídeo GebirgeBR 7I3R3Rfv-3k)');
const xfSameInput = buildChecklist({
  maxHealth: 1499,
  maxReserve: 400,
  maxMissiles: 230,
  maxSupers: 50,
  maxPowerBombs: 50,
  abilities: {
    MORPH_BALL: true, BOMBS: true, HI_JUMP: true, SPACE_JUMP: true, SPRING_BALL: true, VARIA: true, GRAVITY: true,
    SCREW: true, GRAPPLE: true, XRAY: true, CHARGE: true, ICE: true, WAVE: true, SPAZER: true,
  },
  bossesDefeated: 11,
  bossesKnown: 11,
  terminalsDone: 4,
  terminalsKnown: 4,
  roomsUnvisited: 0
}, XFUSION_TOTALS);
check('o "100% vanilla" NÃO é 100% no hack (47/7 faltam)', !missionComplete(xfSameInput));
check('a sobra é míssil + reserva, exatamente 1+3', (() => {
  const open = openObjectives(xfSameInput);
  return open.length === 2 && open.some((c) => c.id === 'missiles' && c.have === 46 && c.total === 47) && open.some((c) => c.id === 'reserve-tanks' && c.total === 7);
})(), JSON.stringify(openObjectives(xfSameInput).map((c) => `${c.id}:${c.have}/${c.total}`)));
const xfFull = buildChecklist({
  maxHealth: 1499, maxReserve: 700, maxMissiles: 235, maxSupers: 50, maxPowerBombs: 50,
  abilities: {
    MORPH_BALL: true, BOMBS: true, HI_JUMP: true, SPACE_JUMP: true, SPRING_BALL: true, VARIA: true, GRAVITY: true,
    SCREW: true, GRAPPLE: true, XRAY: true, CHARGE: true, ICE: true, WAVE: true, SPAZER: true,
  },
  bossesDefeated: 11, bossesKnown: 11, terminalsDone: 4, terminalsKnown: 4, roomsUnvisited: 0,
}, XFUSION_TOTALS);
check('com os totais do hack, 47/7 fecha o checklist', missionComplete(xfFull));
check('o hack tem 7 setores nomeados (SRX … NOC)', XFUSION_SECTORS.length === 7 && XFUSION_SECTORS[0] === 'SRX' && XFUSION_SECTORS[6] === 'NOC');

/* -------------------------------------------- E. lava carmim do X-Fusion (frame real) */

section('E. senseMoltenLake: dois tiers — laranja clássico e carmim do X-Fusion');

// cores MEDIDAS no print do usuário (recorte 256x224 do frame do jogo), não a olho
const LAVA_XF: RGB = [210, 43, 48]; // #d22b30 — corpo do poço
const LAVA_XF_FLAT: RGB = [208, 16, 16]; // #d01010 — painel liso sem bolhas
const PLATFORM_XF: RGB = [177, 16, 20]; // #b11014 — laca quente da plataforma
const BG_DARK: RGB = [16, 16, 16]; // #101010
const BUBBLE: RGB = [248, 200, 96]; // #f8c860 — núcleo incandescente

/** poço do print: lava nas linhas 22-27 (cols 12-19), plataforma firme à esquerda (18-23) */
function moltenRoom(withBubbles = true, lava: RGB = LAVA_XF): Uint8ClampedArray {
  const { rgba, put } = blank(BG_DARK);
  rect(put, 0, 144, 95, 191, PLATFORM_XF); // plataforma esquerda, onde a Samus está
  rect(put, 96, 176, 159, 223, lava); // poço central
  rect(put, 160, 168, 255, 223, PLATFORM_XF); // ombro direito
  if (withBubbles) {
    rect(put, 112, 196, 114, 197, BUBBLE); // duas bolhas: #f8-#e89a6a, 3x2px cada
    rect(put, 140, 208, 142, 209, BUBBLE);
  }
  return rgba;
}

const redHot = senseMoltenLake(moltenRoom(), W, H);
check('lago carmim do X-Fusion é detectado (tier red-hot)', redHot?.tier === 'red-hot');
check('superfície na linha medida do print (22)', redHot?.surfaceRow === 22, `=${redHot?.surfaceRow}`);
check('dentro do poço (25,14) é lava', redHot ? redHot.mask[25 * MOLTEN_COLS + 14] === 1 : false);
check('plataforma (23,4) CONTINUA firme — não virou lava', redHot ? redHot.mask[23 * MOLTEN_COLS + 4] === 0 : false);
check(
  'lakeTopBlock converte pra bloco do mundo (16px)',
  !!redHot && lakeTopBlock(redHot, 0) === Math.floor((22 * MOLTEN_CELL) / 16) && lakeTopBlock(redHot, 64) === Math.floor((64 + 22 * MOLTEN_CELL) / 16),
);
check(
  'sem bolhas incandescentes NÃO liga (sala vermelha sem lava)',
  senseMoltenLake(moltenRoom(false), W, H) === null,
);
check(
  'painel vermelho liso de 2 linhas não vira lago (exige continuidade)',
  (() => {
    const { rgba, put } = blank(BG_DARK);
    rect(put, 64, 176, 200, 191, LAVA_XF_FLAT); // faixa de 2 linhas
    rect(put, 100, 180, 102, 181, BUBBLE);
    rect(put, 150, 180, 152, 181, BUBBLE);
    return senseMoltenLake(rgba, W, H) === null;
  })(),
);
check(
  'laranja clássico do SM tem prioridade (tier orange)',
  (() => {
    const { rgba, put } = blank(BG_DARK);
    rect(put, 64, 168, 200, 223, [248, 120, 40]); // #f87828
    return senseMoltenLake(rgba, W, H)?.tier === 'orange';
  })(),
);
check(
  'anel de fire flea ao redor da porta não a troca por vermelha (rosa continua rosa)',
  (() => {
    const { rgba, put } = blank(BG_DARK);
    rect(put, 112, 92, 128, 108, ROSE);
    rect(put, 108, 88, 111, 91, BUBBLE); // pulgas nos 4 cantos
    rect(put, 129, 88, 132, 91, BUBBLE);
    rect(put, 108, 109, 111, 112, BUBBLE);
    rect(put, 129, 109, 132, 112, BUBBLE);
    return classifyDoorColor(rgba, W, H, 120, 100) === 'PINK';
  })(),
);

const t0 = Date.now();
for (let k = 0; k < 2000; k++) {
  const rooms = new Map<number, NavRoom>();
  for (let r = 0; r < 30; r++) {
    rooms.set(r, navRoom(r, {
      itemsPending: r % 7 === 0 ? 1 : 0,
      doors: [navDoor('LEFT', 'PINK', r > 0 ? r - 1 : undefined), navDoor('RIGHT', r % 5 === 0 ? 'GREEN' : 'PINK', r < 29 ? r + 1 : undefined)],
    }));
  }
  planNextTarget({ graph: { current: 14, rooms }, loadout: FULL, hint: { dir: 'RIGHT', score: 0.8 }, bossRooms: new Map(), everythingDone: false, backlogKeys: new Set() });
}
const perPlan = (Date.now() - t0) / 2000;
check(`plano de rota em ${perPlan.toFixed(3)} ms (< 2 ms) num grafo de 30 salas`, perPlan < 2);

console.log(
  failures.length === 0
    ? `\n\x1b[1m\x1b[32mTODOS OS TESTES DE MAPA PASSARAM\x1b[0m  · ${passed} verificações\n`
    : `\n\x1b[1m\x1b[31m${failures.length} FALHA(S)\x1b[0m  · ${passed + failures.length} verificações\n\nFalhas:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
