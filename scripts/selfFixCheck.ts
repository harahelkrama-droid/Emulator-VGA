/**
 * Checagens da autocorreção (o laço "erro → diagnóstico → parâmetro novo → revisão"):
 *
 *   npm run check:selffix
 *
 * Duas metades: (A) a derivação da calibração de lava a partir do frame que machucou, e
 * (B) o ledger de correções com escalada, reversão, teto de correções ativas e persistência.
 * Tudo aqui é puro — o laço completo, com o agente reagindo no tick seguinte, está em
 * `npm run check:nav`, seção J.
 */
import {
  LAVA_CALIB_BASE,
  MOLTEN_CELL,
  MOLTEN_COLS,
  MOLTEN_ROWS,
  deriveMoltenCalib,
  isRedHotLavaPixel,
  moltenCellMean,
  senseMoltenLake,
  type MoltenCalib,
} from '../src/lib/mapStrategy';
import {
  CORRECTION_MAX_ACTIVE,
  CORRECTION_PROVE_TICKS,
  SelfCorrectionLedger,
} from '../src/lib/selfCorrection';

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

const W = 256;
const H = 224;
type RGB = [number, number, number];

function blank(c: RGB): { rgba: Uint8ClampedArray; put: (x: number, y: number, c: RGB) => void } {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const put = (x: number, y: number, col: RGB) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    rgba[i] = col[0];
    rgba[i + 1] = col[1];
    rgba[i + 2] = col[2];
    rgba[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, c);
  return { rgba, put };
}
function rect(
  put: (x: number, y: number, c: RGB) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: RGB,
): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, c);
}

// cores MEDIDAS no print do usuário (recorte 256x224), não a olho
const LAVA: RGB = [210, 43, 48]; // #d22b30 corpo do poço
const PLATFORM: RGB = [177, 16, 20]; // #b11014 laca quente da plataforma
const BG: RGB = [16, 16, 16];
const BUBBLE: RGB = [248, 200, 96]; // #f8c860 incandescente

/** sala do print: poço nas linhas 22-27 (cols 12-19), plataforma firme à esquerda */
function moltenRoom(lava: RGB = LAVA): Uint8ClampedArray {
  const { rgba, put } = blank(BG);
  rect(put, 0, 144, 95, 191, PLATFORM);
  rect(put, 96, 176, 159, 223, lava);
  rect(put, 160, 168, 255, 223, PLATFORM);
  rect(put, 112, 196, 114, 197, BUBBLE);
  rect(put, 140, 208, 142, 209, BUBBLE);
  return rgba as unknown as Uint8ClampedArray;
}

/* ============================================ A. derivar a calibração do próprio frame */

section('A. deriveMoltenCalib: quem rotula é o WRAM, quem define o corte é o frame');
{
  const rgba = moltenRoom();
  const rep = deriveMoltenCalib(rgba, W, H, {
    hurt: [{ r: 24, c: 15 }, { r: 25, c: 16 }], // o poço
    safe: [{ r: 21, c: 4 }, { r: 22, c: 3 }], // a plataforma
  });
  check('as duas classes separam e o corte é derivado', !!rep, 'null');
  // à mão eu fixei r>185; a regra ancorada no escuro que doeu tem que cair perto
  check('reproduz a calibração humana do print (185 ± 18)', !!rep && Math.abs(rep.calib.minRed - 185) <= 18, `r>${rep?.calib.minRed}`);
  check('o diagnóstico carrega as cores medidas', !!rep && rep.hurtHex === '#d22b30' && rep.safeHex === '#b11014', `${rep?.hurtHex}/${rep?.safeHex}`);
  check('lava continua sendo lava sob o corte derivado', !!rep && isRedHotLavaPixel(210, 43, 48, rep.calib));
  check('plataforma continua sendo chão sob o corte derivado', !!rep && !isRedHotLavaPixel(177, 16, 20, rep.calib));
  const withDerived = senseMoltenLake(rgba, W, H, rep?.calib);
  check('e o detector com o corte derivado acha a mesma superfície (22)', withDerived?.surfaceRow === 22, `row=${withDerived?.surfaceRow}`);

  // paleta que nenhum tier conhece: corpo #aa2222 (r=170), abaixo do corte calibrado à mão,
  // sobre chão cinza-azulado — é o cenário da seção J do check:nav, só que sem o agente no meio.
  const darkRoom = (() => {
    const { rgba: buf, put } = blank([46, 50, 62]);
    rect(put, 96, 176, 159, 223, [170, 34, 34]);
    rect(put, 112, 196, 114, 197, BUBBLE);
    rect(put, 140, 208, 142, 209, BUBBLE);
    return buf as unknown as Uint8ClampedArray;
  })();
  check('sem correção, o lago escuro é INVISÍVEL (é o bug original)', senseMoltenLake(darkRoom, W, H) === null);
  const rep2 = deriveMoltenCalib(darkRoom, W, H, {
    hurt: [{ r: 24, c: 15 }],
    safe: [{ r: 24, c: 4 }],
  });
  const found = rep2 ? senseMoltenLake(darkRoom, W, H, rep2.calib) : null;
  check('com o corte derivado do frame, o mesmo lago aparece', !!found && found.tier === 'red-hot', `r>${rep2?.calib.minRed}`);
  check('o chão firme do lado NÃO virou lava', !!found && found.mask[24 * MOLTEN_COLS + 4] === 0);
  check('o corte derivado respeita o piso da janela', !!rep2 && rep2.calib.minRed >= 150);

  // recusas: sem separação não há o que aprender
  const flat = blank([96, 96, 104]).rgba as unknown as Uint8ClampedArray;
  check(
    'classes idênticas (dano de inimigo) → recusa, não chute',
    deriveMoltenCalib(flat, W, H, { hurt: [{ r: 24, c: 10 }], safe: [{ r: 24, c: 12 }] }) === null,
  );
  check('sem classe negativa → recusa', deriveMoltenCalib(rgba, W, H, { hurt: [{ r: 24, c: 15 }], safe: [] }) === null);
  check(
    'fora da banda do lago → recusa (célula vazia não é evidência)',
    deriveMoltenCalib(rgba, W, H, { hurt: [{ r: 2, c: 2 }], safe: [{ r: 21, c: 4 }] }) === null,
  );
  check(
    'corte nunca sai da janela limitada',
    (() => {
      // chão claríssimo vs lava quase branca: o ponto médio explodiria, o teto não deixa
      const { rgba: near, put } = blank([24, 24, 30]);
      rect(put, 96, 176, 159, 223, [246, 40, 40]);
      const r = deriveMoltenCalib(near as unknown as Uint8ClampedArray, W, H, {
        hurt: [{ r: 24, c: 15 }],
        safe: [{ r: 24, c: 1 }],
      });
      return r ? r.calib.minRed >= 150 && r.calib.minRed <= 214 : true;
    })(),
  );
  check(
    'a média da célula (moltenCellMean) é o mesmo estimador do detector',
    (() => {
      const m = moltenCellMean(rgba, W, H, 24, 15);
      return !!m && Math.abs(m[0] - LAVA[0]) < 1 && Math.abs(m[1] - LAVA[1]) < 1;
    })(),
  );
}

/* =============================================================== B. o caderno de correções */

section('B. SelfCorrectionLedger: tese, escalada, reversão e teto');
{
  const L = new SelfCorrectionLedger();
  const calib: MoltenCalib = { minRed: 168, maxGreen: 92, minRun: 8 };
  const eff = L.observe({ kind: 'LAVA_UNSIGHTED', tick: 100, roomId: 16, bx: 13, by: 9, calib, hurtHex: '#aa2222', safeHex: '#606068', gap: 74 });
  check('correção criada a partir do erro', eff.record?.kind === 'LAVA_UNSIGHTED' && eff.record.status === 'ACTIVE');
  check('a calibração é adotada no agente', L.lavaCalib.minRed === 168);
  check('e o ledger manda reler o frame na hora', eff.rescanNow === true && L.needsRescan);
  check('o texto do diagnóstico traz as cores medidas', /#aa2222/.test(eff.record?.diagnosis ?? '') && /r>185 → r>168/.test(eff.record?.action ?? ''));

  // mesma falha com a correção ligada → escala uma vez
  const e2 = L.observe({ kind: 'LAVA_UNSIGHTED', tick: 200, roomId: 16, bx: 13, by: 9, calib: { ...calib, minRed: 158 } });
  const rec = e2.record!;
  check('repetiu: escala em vez de duplicar a tese', L.records.length === 1 && rec.escalated === true, `${L.records.length} registros`);
  check('a escalada relaxa DENTRO da janela', rec.lavaCalib!.minRun === 7 && rec.lavaCalib!.maxGreen <= 170, `run=${rec.lavaCalib!.minRun}`);

  // terceira → reverte e volta para onde estava
  const e3 = L.observe({ kind: 'LAVA_UNSIGHTED', tick: 300, roomId: 16, bx: 13, by: 9, calib: { ...calib, minRed: 150 } });
  check('terceira: a tese é REVERTIDA', e3.record?.status === 'REVERTED');
  check('e o parâmetro volta para a calibração anterior', L.lavaCalib.minRed === 168, `r>${L.lavaCalib.minRed}`);
  check('revertida ⇒ recuo conservador: a célula vira perigo', (e3.dangerCells?.length ?? 0) === 1, JSON.stringify(e3.dangerCells));
  const before = L.records.length;
  L.observe({ kind: 'LAVA_UNSIGHTED', tick: 400, roomId: 16, bx: 13, by: 9, calib });
  check('tese enterrada no escopo não volta a ser tentativa', L.records.length === before);

  // sem evidência separável não se inventa nada
  const L2 = new SelfCorrectionLedger();
  const fb = L2.observe({ kind: 'LAVA_UNSIGHTED', tick: 10, roomId: 3, bx: 2, by: 4, calib: null });
  check('sem separação: nenhum parâmetro muda', L2.lavaCalib.minRed === LAVA_CALIB_BASE.minRed && L2.records.length === 0);
  check('mas o lugar é marcado e o frame é relido', (fb.dangerCells?.length ?? 0) === 1 && fb.rescanNow === true);

  // prova por tempo
  const L3 = new SelfCorrectionLedger();
  L3.observe({ kind: 'HAZARD_BLIND', tick: 0, roomId: 7, bx: 1, by: 5, hpLost: 30 });
  check('dano onde eu dizia seguro sobe o custo do perigo', L3.hazardPenAdd === 2, `+${L3.hazardPenAdd}`);
  check('revisão antes da hora não declara sucesso', L3.review(CORRECTION_PROVE_TICKS - 1, true) === null);
  check('depois, sem repetir a falha, vira conhecimento', L3.review(CORRECTION_PROVE_TICKS + 1, true) !== null && L3.records[0]!.status === 'HELPED');
  const L4 = new SelfCorrectionLedger();
  for (let i = 0; i < 5; i++) L4.observe({ kind: 'HAZARD_BLIND', tick: i * 5, roomId: 20 + i, bx: 1, by: 5, hpLost: 30 });
  check('penalidade tem teto (não cresce para sempre)', L4.hazardPenAdd === 6, `+${L4.hazardPenAdd}`);
  const L5 = new SelfCorrectionLedger();
  L5.observe({ kind: 'HAZARD_BLIND', tick: 0, roomId: 7, bx: 1, by: 5, hpLost: 30 });
  L5.observe({ kind: 'HAZARD_BLIND', tick: 5, roomId: 7, bx: 1, by: 5, hpLost: 30 });
  L5.observe({ kind: 'HAZARD_BLIND', tick: 9, roomId: 7, bx: 1, by: 5, hpLost: 30 });
  check('na 3ª vez no MESMO lugar a tese é revista, não empilhada', L5.records[0]!.status === 'REVERTED' && L5.hazardPenAdd === 0, `pen=+${L5.hazardPenAdd} ${L5.records[0]!.status}`);
}

section('C. Correções de porta e munição');
{
  const L = new SelfCorrectionLedger();
  const eff = L.observe({
    kind: 'DOOR_COLOR_WRONG',
    tick: 50,
    roomId: 9,
    bx: 0,
    by: 8,
    doorKey: '9:LEFT@0:8',
    colorSampled: 'RED',
    doorOpen: true,
  });
  check('a cor guardada é corrigida pela verdade do WRAM', eff.doorOverride?.color === 'PINK');
  check('e o raio de amostragem encolhe (menos pulga no batente)', L.doorSampleRadius === 6, `r=${L.doorSampleRadius}`);
  check('override fica disponível para o laço de navegação', L.doorOverrideFor('9:LEFT@0:8') === 'PINK');
  for (let i = 0; i < 6; i++) {
    L.observe({ kind: 'DOOR_COLOR_WRONG', tick: 60 + i * 700, roomId: 9 + i, doorKey: `${9 + i}:LEFT@0:8`, colorSampled: 'RED', doorOpen: true });
  }
  check('o raio tem piso (3px é o menor recorte honesto)', L.doorSampleRadius === 3, `r=${L.doorSampleRadius}`);

  const L2 = new SelfCorrectionLedger();
  const wasted = L2.observe({ kind: 'AMMO_WASTED', tick: 10, roomId: 4, bx: 6, by: 3, doorKey: '4:UP@6:3', attempts: 3 });
  check('3 tiros sem efeito ⇒ célula não é mais tratada como quebrável', wasted.unbreakable === '4:6,3', wasted.unbreakable ?? '');

  const L3 = new SelfCorrectionLedger();
  for (let r = 0; r < 12; r++) L3.observe({ kind: 'OSCILLATION', tick: r, roomId: 100 + r });
  check('teto de correções ativas (6): o resto cai no recuo', L3.records.filter((x) => x.status === 'ACTIVE').length === CORRECTION_MAX_ACTIVE, `${L3.records.length} registros`);
}

section('D. Persistência (aprender uma vez e não esquecer)');
{
  const L = new SelfCorrectionLedger();
  L.observe({
    kind: 'LAVA_UNSIGHTED',
    tick: 10,
    roomId: 16,
    bx: 13,
    by: 9,
    calib: { minRed: 168, maxGreen: 92, minRun: 8 },
    hurtHex: '#aa2222',
    safeHex: '#2e323e',
    gap: 124,
  });
  L.review(CORRECTION_PROVE_TICKS + 50, true);
  const rows = L.serialize();
  const L2 = new SelfCorrectionLedger();
  L2.restore(rows);
  check('a calibração provada sobrevive ao restore', L2.lavaCalib.minRed === 168, `r>${L2.lavaCalib.minRed}`);
  check('o histórico também', L2.records.length === 1 && L2.records[0]!.status === 'HELPED');
  check('a UI lê o caderno com o diagnóstico intacto', L2.describeForUi()[0]?.diagnosis.includes('#aa2222') === true, JSON.stringify(L2.describeForUi()[0] ?? null));
  check('e o registro persistido vem com a ação que mudou', /r>185 → r>168/.test(L2.describeForUi()[0]?.action ?? ''));
  const L3 = new SelfCorrectionLedger();
  L3.restore([]);
  L3.restore(null);
  L3.restore({ lixo: true });
  check('restore de lixo não quebra o agente', L3.records.length === 0 && L3.lavaCalib.minRed === LAVA_CALIB_BASE.minRed);
}

console.log(
  failures.length === 0
    ? `\n\x1b[1m\x1b[32mAUTOCORREÇÃO OK\x1b[0m  · ${passed} verificações\n`
    : `\n\x1b[1m\x1b[31m${failures.length} FALHA(S)\x1b[0m  · ${passed + failures.length} verificações\n\nFalhas:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
