/**
 * actionGuardian — a camada de verificação que faltava no agente.
 *
 * O playtest headless de 25 min (playtest/RELATORIO-IA-25min.md) mostrou que o agente não
 * perdia por ser ruim de pulo nem por ler mal o frame: ele perdia porque **nenhum dos seus
 * planos exige evidência de que funcionou**. Um alvo (bloco falso, porta, borda) era escolhido,
 * a ação era executada, o resultado não era medido, e a mesma ação voltava no tick seguinte —
 * para sempre. Pior: os dois contadores que existiriam para quebrar esse ciclo se anulavam
 * (o `tested` do caminho secreto era apagado a cada tick e o `stuckInRoomTicks` era zerado
 * pelo próprio escape que ele dispara).
 *
 * Este módulo é **puro** (sem DOM, sem emulador, sem WRAM): recebe números, devolve decisões.
 * Ele não substitui o `LocalVisionAgent`; ele veta. Toda jogada repetitiva do agente passa por
 * uma hipótese com orçamento, e todo travamento sobe por uma escada de escape que não apaga a
 * própria prova.
 *
 * Peças:
 *  - `HypothesisLedger`  → "você apostou que X; aconteceu? não? então chega."
 *  - `StuckSentinel`     → progresso **horizontal** manda; pular no lugar não é progresso.
 *  - `EscapeLadder`      → degraus de desvio (empurrar → inverter → atirar+pulo → ler mapa →
 *                          bloquear a sala), cada degrau só sai do lugar se o anterior falhou.
 *  - `JumpModulator`     → duração do aperto de pulo em função do vão (toque fino × pulo alto),
 *                          com corte antecipado quando a altura necessária já foi alcançada.
 *  - `SlotDriver`        → SELECT é um seletor rotativo: para de "dar uma piscada e torcer".
 *  - `PreyChaser`        → matou? a janela de coleta do parasita X vem antes de voltar a andar.
 *
 * Orçamento por tick: tudo O(1) amortizado com mapas limitados e poda determinística — o
 * `decide()` inteiro custa ~0,6 ms medidos e não é para crescer com o tamanho da sala.
 */

/* ------------------------------------------------------------------ utilidades */

export type Dir = 'LEFT' | 'RIGHT';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** chave estável "sala:algo" usada em todos os mapas (evita colisões entre salas) */
export const cellKey = (roomId: number, bx: number, by: number) => `${roomId}:${bx},${by}`;
export const targetKey = (roomId: number, kind: string, x: number, y: number) =>
  `${roomId}:${kind}@${Math.round(x / 16)},${Math.round(y / 16)}`;

/* ------------------------------------------------------- HypothesisLedger */

export type HypothesisKind =
  | 'SECRET_BLOCK' /** "este bloco é falso e abre passagem" */
  | 'DOOR_AMMO' /** "esta comporta abre com esta munição" */
  | 'LEDGE_REACH' /** "deste pulo eu alcanço esta borda" */
  | 'FLOOR_HAZARD' /** "este chão é lava" */
  | 'ITEM_ROUTE'; /** "por aqui tem item" */

export interface Hypothesis {
  key: string;
  kind: HypothesisKind;
  roomId: number;
  attempts: number;
  /** tentativas que produziram o efeito esperado (prova de que a hipótese é verdadeira) */
  confirmed: number;
  failures: number;
  /** orçamento de tentativas seguidas sem efeito */
  budget: number;
  status: 'ACTIVE' | 'DEAD';
  lastAttemptTick: number;
  note: string;
}

/**
 * Apostas do agente com prova de resultado.
 *
 * Regra de ouro: **uma hipótese nunca é recriada limpa**. O `open()` é idempotente — o que
 * existe é reafirmado, não resetado. É exatamente o anti-padrão que deixou o agente 22 minutos
 * atirando na mesma parede (`secretPaths.clear()` a cada tick).
 */
export class HypothesisLedger {
  private map = new Map<string, Hypothesis>();
  private order: string[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  get(key: string): Hypothesis | undefined {
    return this.map.get(key);
  }

  /** registra (sem zerar) uma aposta; devolve o estado corrente dela */
  open(key: string, kind: HypothesisKind, roomId: number, budget: number, note = ''): Hypothesis {
    const found = this.map.get(key);
    if (found) {
      if (note) found.note = note;
      return found;
    }
    const h: Hypothesis = {
      key,
      kind,
      roomId,
      attempts: 0,
      confirmed: 0,
      failures: 0,
      budget,
      status: 'ACTIVE',
      lastAttemptTick: -9999,
      note,
    };
    this.map.set(key, h);
    this.order.push(key);
    if (this.order.length > this.maxEntries) {
      // poda a hipótese mais antiga que já morreu (as vivas ficam: matar cedo é o bug que
      // estamos corrigindo, então a poda varre de trás para frente até achar uma candidata)
      for (let i = 0; i < this.order.length; i++) {
        const k = this.order[i];
        const h = this.map.get(k);
        if (!h || h.status === 'DEAD') {
          this.order.splice(i, 1);
          this.map.delete(k);
          break;
        }
      }
    }
    return h;
  }

  /** o agente decidiu executar a jogada: conta a tentativa */
  attempt(key: string, tick: number): Hypothesis {
    const h = this.map.get(key)!;
    h.attempts++;
    h.lastAttemptTick = tick;
    return h;
  }

  /** o tick seguinte trouxe o efeito esperado? `effect=true` recredita a aposta */
  settle(key: string, effect: boolean, tick: number): Hypothesis | undefined {
    const h = this.map.get(key);
    if (!h) return undefined;
    if (effect) {
      h.confirmed++;
      h.failures = 0;
      h.status = 'ACTIVE';
      return h;
    }
    h.failures++;
    if (h.failures >= h.budget) {
      h.status = 'DEAD';
    }
    // se ela estava DEAD e ganhou sobrevida por contexto novo (sala reaberta), fica viva de
    // novo só até estourar o orçamento dobrado — uma segunda chance, não a primeira outra vez
    if (h.status === 'DEAD' && tick - h.lastAttemptTick > h.budget * 600) {
      h.status = 'ACTIVE';
      h.failures = Math.floor(h.budget / 2);
      h.budget *= 2;
    }
    return h;
  }

  isDead(key: string): boolean {
    return this.map.get(key)?.status === 'DEAD';
  }

  deadForRoom(roomId: number): Hypothesis[] {
    const out: Hypothesis[] = [];
    for (const h of this.map.values()) if (h.roomId === roomId && h.status === 'DEAD') out.push(h);
    return out;
  }

  deadCount(): number {
    let n = 0;
    for (const h of this.map.values()) if (h.status === 'DEAD') n++;
    return n;
  }

  /** esquece a sala inteira (só quando a sala é reaberta por um item novo, por exemplo) */
  resetRoom(roomId: number): void {
    for (const [k, h] of [...this.map.entries()]) {
      if (h.roomId === roomId) {
        this.map.delete(k);
        const i = this.order.indexOf(k);
        if (i >= 0) this.order.splice(i, 1);
      }
    }
  }

  size(): number {
    return this.map.size;
  }

  snapshot(limit = 6): Array<{ key: string; kind: string; attempts: number; failures: number; status: string; note: string }> {
    const list = [...this.map.values()]
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, limit);
    return list.map((h) => ({
      key: h.key,
      kind: h.kind,
      attempts: h.attempts,
      failures: h.failures,
      status: h.status,
      note: h.note,
    }));
  }

  clear(): void {
    this.map.clear();
    this.order = [];
  }
}

/* --------------------------------------------------------- StuckSentinel */

export interface SentinelInput {
  tick: number;
  roomId: number;
  x: number;
  y: number;
  /** teclas que o agente está segurando neste tick (para saber em que parede ele empurra) */
  keys: readonly string[];
  /** tem chão sob os pés? (leitura de bloco, não de frame) */
  grounded: boolean;
  /** mudou de sala? o chamador avisa; o sentinela não precisa adivinhar */
  roomChanged?: boolean;
  /** ganhou algo (item/habilidade/munição) — conta como progresso real */
  progressEvent?: boolean;
  /** em combate: ficar parado atirando é estratégia, não travamento */
  inCombat?: boolean;
  /** largura da sala em px (para saber se ela está espremida na parede direita) */
  roomWidthPx?: number;
}

export interface SentinelVerdict {
  /** ticks empurrando o mesmo lugar sem ganho horizontal — o número que faltava no `lost` */
  stallTicks: number;
  /** ticks na sala atual sem trocar de sala nem progredir */
  roomTicks: number;
  /** quantos pixels o último "progresso" vertical realmente rendeu (0 = pulo no lugar) */
  lastNetDx: number;
  /** para onde o agente estava empurrando quando parou de andar — inverter isso é o NUDGE */
  pushDir: Dir | null;
  /** lado da sala que ele está espremido (parede esquerda/direita) */
  pinnedEdge: 'LEFT' | 'RIGHT' | null;
  /**
   * Ida-e-volta: muitas inversões de sentido na mesma sala sem ganho LÍQUIDO. O critério de
   * "20 px" sozinho não pega pacing — atravessar a sala e voltar dá amplitude grande, a âncora
   * anda a cada margem, e o travamento nunca cresce. Foi assim que a sessão terminou 9.331 ticks
   * numa sala indo e voltando com o detector marcando stall = 48. O que separa pacing de
   * progresso é o SALDO, não a amplitude.
   */
  oscillating: boolean;
  /** verdade quando o pulo atual ainda não provou nada (não cortar o contador no ar) */
  airborne: boolean;
  /** 0..3 — severidade do travamento, usada pelo `EscapeLadder` */
  severity: number;
}

/**
 * Detetor de posição estagnada que **não se deixa enganar por movimento vertical**.
 *
 * O critério antigo (`|Δx| < 20 && |Δy| < 28`) zerava sozinho: uma Samus presa no fundo de um
 * poço pula, sobe 40 px, cai, e cada perna de voo re-ancorava a posição → travamento invisível
 * por 22 minutos. Aqui a âncora só anda quando há ganho **horizontal**, ou quando um ganho
 * vertical terminou num **chão diferente** (celula de apoio distinta) — que é o que "subir uma
 * plataforma" realmente significa.
 */
export class StuckSentinel {
  private anchorX = 0;
  private anchorY = 0;
  private anchorFloorCell = 0;
  private lastX = 0;
  private lastY = 0;
  private lastTick = 0;
  private stall = 0;
  private room = 0;
  private roomTicks = 0;
  private netDx = 0;
  private pushLeft = 0;
  private pushRight = 0;
  private prevGrounded = true;
  private lastPushSign = 0;
  private reversals = 0;
  private reversalTick = 0;
  private lagX = 0;
  private lagSampleTick = -9999;
  private oscillating = false;
  private oscXMin = 0;
  private oscXMax = 0;
  /** extensão horizontal percorrida desde a última âncora: pulo no lugar tem spread ~0 */
  private xMin = 0;
  private xMax = 0;
  /** extensão horizontal da SALA INTEIRA (só a troca de sala zera) — é o corredor do latch */
  private roomXMin = 0;
  private roomXMax = 0;
  private verdict: SentinelVerdict = {
    stallTicks: 0,
    roomTicks: 0,
    lastNetDx: 0,
    pushDir: null,
    pinnedEdge: null,
    airborne: false,
    oscillating: false,
    severity: 0,
  };

  /** quantos pixels de avanço horizontal valem resetar a âncora */
  readonly PROGRESS_DX = 20;
  /** quantos pixels de altura, pouso em chão novo, valem resetar a âncora */
  readonly PROGRESS_DY_LANDED = 24;

  reset(): void {
    this.stall = 0;
    this.roomTicks = 0;
    this.pushLeft = 0;
    this.pushRight = 0;
    this.netDx = 0;
    this.reversals = 0;
    this.reversalTick = 0;
    this.lastPushSign = 0;
    this.lagSampleTick = -9999;
    this.oscillating = false;
    this.anchorFloorCell = 0;
    // reset sem resetar o veredicto é a UI continuar mostrando "stuck=1314" depois de um novo
    // jogo — e a escada ler um travamento que já não existe
    this.verdict = {
      stallTicks: 0,
      roomTicks: 0,
      lastNetDx: 0,
      pushDir: null,
      pinnedEdge: null,
      airborne: false,
      oscillating: false,
      severity: 0,
    };
  }

  /**
   * "a aposta anterior deixou de explicar o mundo": item coletado, reset de energia, caça a um
   * item novo, U-Search assumindo a subida. Zera o travamento **e a direção do empurrão**, sem
   * tocar no tempo de sala — é a diferença entre perdoar e esquecer: o `EscapeLadder` continua
   * podendo subir de degrau se nada melhorar.
   */
  forgive(): void {
    this.stall = 0;
    this.xMin = this.lastX;
    this.xMax = this.lastX;
    this.pushLeft = 0;
    this.pushRight = 0;
    this.anchorX = this.lastX;
    this.anchorY = this.lastY;
    this.anchorFloorCell = Math.floor(this.lastX / 16) * 256 + Math.floor(this.lastY / 16);
    // o veredicto é o que a UI e a escada leem: deixar o número velho depois de perdoar é
    // exatamente o tipo de "dois pontos de verdade" que produziu o bug original
    this.verdict = { ...this.verdict, stallTicks: 0, pushDir: null, pinnedEdge: null, severity: 0 };
  }

  /** chamado no começo de cada tick, ANTES de o plano escolher a direção */
  feed(i: SentinelInput): SentinelVerdict {
    const floorCell = Math.floor(i.x / 16) * 256 + Math.floor(i.y / 16);

    const freshRoom = i.roomChanged || i.roomId !== this.room;
    if (freshRoom) {
      this.room = i.roomId;
      this.roomTicks = 0;
      this.stall = 0;
      this.anchorX = i.x;
      this.anchorY = i.y;
      this.anchorFloorCell = floorCell;
      this.pushLeft = 0;
      this.pushRight = 0;
      this.roomXMin = i.x;
      this.roomXMax = i.x;
      this.oscillating = false;
      this.reversals = 0;
    } else {
      this.roomTicks++;
    }
    this.roomXMin = Math.min(this.roomXMin, i.x);
    this.roomXMax = Math.max(this.roomXMax, i.x);

    const dx = i.x - this.lastX;
    // IDA E VOLTA. Medir só "|Δx| < 20" não pega pacing — atravessar a sala e voltar move 150 px
    // por perna, a âncora anda a cada perna e o travamento nunca passa de 48 (a sessão final
    // ficou 9.331 ticks assim). O que distingue pacing de travessia não é a amplitude, é o SALDO
    // CONTRA UMA AMOSTRA ATRASADA: se ela inverte 8+ vezes e a posição de agora é a mesma de ~28
    // ticks atrás (uma perna e meia), ela está costurando o mesmo corredor.
    const step = i.grounded ? (dx < -4 ? -1 : dx > 4 ? 1 : 0) : 0;
    if (step !== 0) {
      if (this.lastPushSign !== 0 && step !== this.lastPushSign) {
        this.reversals = i.tick - this.reversalTick > 240 ? 1 : this.reversals + 1;
        this.reversalTick = i.tick;
      }
      this.lastPushSign = step;
    }
    if (i.tick - this.lagSampleTick >= 28) {
      this.lagX = i.x;
      this.lagSampleTick = i.tick;
    }
    // O LATCH é o que faz o detector funcionar: soltar a cada amostra que volta a coincidir com a
    // perna era exatamente como o pacing escapava (o travamento ia a 11 e zerava). Uma vez
    // costurando o mesmo corredor, ela só sai dele encontrando chão FORA do corredor.
    if (!this.oscillating) {
      if (this.reversals >= 8 && Math.abs(i.x - this.lagX) < 48) {
        this.oscillating = true;
        // o corredor é a extensão da SALA que ela já cobriu (não a âncora, não o spread desde o
        // último reset — os dois encolhem a cada progresso e o latch caía no tick seguinte)
        this.oscXMin = this.roomXMin;
        this.oscXMax = this.roomXMax;
      }
    } else if (i.x < this.oscXMin - 60 || i.x > this.oscXMax + 60 || i.progressEvent || freshRoom || i.tick - this.reversalTick > 240) {
      this.oscillating = false;
      this.reversals = 0;
    }
    const oscillating = this.oscillating;

    if (this.stall === 0) {
      this.xMin = i.x;
      this.xMax = i.x;
    } else {
      this.xMin = Math.min(this.xMin, i.x);
      this.xMax = Math.max(this.xMax, i.x);
    }
    const spread = this.xMax - this.xMin;
    const movedAnchorX = Math.abs(i.x - this.anchorX) >= this.PROGRESS_DX;
    // Pulo no lugar que troca de célula de chão era o buraco do detector antigo — e no playtest
    // refeito ele sobreviveu em outra forma: a Samus quicando na mesma coluna (spread de 8 px)
    // "pousava em chão novo" a cada 8 ticks e o travamento nunca passava de 81. Então: ganhar
    // altura só conta como progresso se ela saiu do lugar (spread ≥ 12 px) ou se a subida é
    // grande o bastante para ser uma escalada de verdade (≥ 40 px = mais que um pulo).
    const climbedForReal = Math.abs(i.y - this.anchorY) >= 40;
    const landedElsewhere =
      this.prevGrounded && !i.grounded
        ? false
        : i.grounded &&
          floorCell !== this.anchorFloorCell &&
          Math.abs(i.y - this.anchorY) >= this.PROGRESS_DY_LANDED &&
          (spread >= 12 || climbedForReal);

    if ((movedAnchorX || landedElsewhere || i.progressEvent) && !oscillating) {
      this.anchorX = i.x;
      this.anchorY = i.y;
      this.anchorFloorCell = floorCell;
      this.netDx = dx;
      this.stall = 0;
      if (!i.progressEvent) this.roomTicks = Math.min(this.roomTicks, 120);
    } else if (!freshRoom) {
      // NO AR TAMBÉM CONTA. A regra antiga ("só em solo parado") deixou uma janela de cegueira
      // de 100 %: sentada na soleira de uma porta, a heurística de chão deste hack lê "no ar" o
      // tempo todo, o relógio parou em 90 e ela passou 9.160 ticks ali sem que o travamento
      // existisse. O que o pulo "ainda não provou" é o POUSO — e o pouso em chão novo já é tratado
      // acima (landedElsewhere). Não provar nada não é progresso: o relógio anda.
      // Combate NÃO isenta: no playtest o "inimigo vivo na sala" era permanente, e a isenção
      // bastava para o travamento nunca chegar a 1 (era o `lost=true` que nunca disparava).
      // Quem decide não INTERVIR durante a briga é o `EscapeLadder`, não o medidor.
      this.stall++;
    }

    if (i.keys.includes('LEFT')) this.pushLeft++;
    if (i.keys.includes('RIGHT')) this.pushRight++;
    if (this.stall === 0) {
      this.pushLeft = 0;
      this.pushRight = 0;
    }

    const airborne = !i.grounded;
    // direção do EMPURRÃO medido (é isso que precisa ser invertido — não a preferência de rota)
    const pushDir: Dir | null =
      this.pushLeft === this.pushRight ? null : this.pushLeft > this.pushRight ? 'LEFT' : 'RIGHT';
    // presa na parede = encostada na borda da sala e empurrando para fora
    let pinnedEdge: 'LEFT' | 'RIGHT' | null = null;
    if (this.stall >= 12) {
      const nearLeft = i.x <= 56;
      const nearRight = (i.roomWidthPx ?? 0) > 0 && i.x >= (i.roomWidthPx as number) - 56;
      if (nearLeft && pushDir !== 'RIGHT') pinnedEdge = 'LEFT';
      else if (nearRight && pushDir !== 'LEFT') pinnedEdge = 'RIGHT';
    }

    const severity =
      this.stall >= 240 || oscillating ? 3 : this.stall >= 120 ? 2 : this.stall >= 48 ? 1 : 0;

    this.prevGrounded = i.grounded;
    this.lastX = i.x;
    this.lastY = i.y;
    this.lastTick = i.tick;

    this.verdict = {
      stallTicks: this.stall,
      roomTicks: this.roomTicks,
      lastNetDx: this.netDx,
      pushDir,
      pinnedEdge,
      airborne,
      oscillating,
      severity,
    };
    return this.verdict;
  }

  get current(): SentinelVerdict {
    return this.verdict;
  }

  get lastSeenTick(): number {
    return this.lastTick;
  }
}

/* ----------------------------------------------------------- EscapeLadder */

export type EscapeRung =
  | 'NONE'
  | 'NUDGE' /** pulo curto + avanço: solta de beirada e de "um pixel curto" */
  | 'REVERSE_PUSH' /** inverte a direção do EMPURRÃO (não a preferência de rota) */
  | 'SWEEP' /** anda varrendo com tiro carregado, o jeito humano de achar vão */
  | 'MAP_READ' /** abre o mapa do jogo e pede rota ao planejador */
  | 'BLOCK_ROOM'; /** marca a sala como bloqueada no grafo e vai para outra rota */

export interface EscapePlan {
  rung: EscapeRung;
  /** direção para onde andar neste degrau (null = a mesma; o chamador decide) */
  dir: Dir | null;
  jump: boolean;
  /** ticks de duração do degrau */
  durationTicks: number;
  /** true enquanto o degrau está valendo (o chamador não deve limpar o contador!) */
  engaged: boolean;
  /** por que (vai direto para o painel do player) */
  reason: string;
  /** degrau atual 0..4 (para o painel) */
  step: number;
}

const NONE_PLAN: EscapePlan = {
  rung: 'NONE',
  dir: null,
  jump: false,
  durationTicks: 0,
  engaged: false,
  reason: '',
  step: 0,
};

/**
 * Escada de desvio. Diferença em relação ao `checkForcedEscape` antigo:
 *  1. ele **não zera o contador de travamento** ao terminar o degrau (era isso que permitia o
 *     ciclo de 160 ticks para sempre);
 *  2. ele **inverte o empurrão medido**, não a preferência de navegação;
 *  3. cada degrau tem duração e o próximo é mais caro — no topo a sala é bloqueada no grafo,
 *     então "ficar ali para sempre" deixa de ser um estado possível.
 */
export class EscapeLadder {
  private rung: EscapeRung = 'NONE';
  private until = 0;
  private step = 0;
  private lastStallSeen = 0;

  constructor(private readonly budgetTicks: number[] = [14, 20, 26, 10, 16]) {}

  reset(): void {
    this.rung = 'NONE';
    this.until = 0;
    this.step = 0;
    this.lastStallSeen = 0;
  }

  get active(): boolean {
    return this.rung !== 'NONE';
  }

  get currentRung(): EscapeRung {
    return this.rung;
  }

  /**
   * @param severity 0..3 do sentinela
   * @param stallTicks travamento atual (monótono dentro da sala)
   * @param roomChanged acaba de trocar de sala? (única coisa que zera a escada)
   */
  next(
    tick: number,
    v: SentinelVerdict,
    roomChanged: boolean,
    opts: { inCombat: boolean; canReadMap: boolean },
  ): EscapePlan {
    if (roomChanged) {
      this.reset();
      return NONE_PLAN;
    }

    const stillStalled = v.stallTicks >= this.lastStallSeen - 4;
    if (this.rung !== 'NONE' && tick > this.until) {
      // degrau venceu sem produzir efeito: sobe. Se produziu, o sentinela zerou o stall e a
      // escada desce sozinha no próximo bloco.
      //
      // O topo é CICLO, não absorvente. Prender em BLOCK_ROOM (o comportamento antigo) foi um bug
      // com efeito prático: o degrau MAP_READ do meio da escada é a única coisa que chama o mapa
      // do jogo quando ela está perdida, e a escada nunca mais passava por ele — na simulação o
      // START atrasava 100+ ticks (tick 438, porta de entrada do teste é 420), no jogo real a
      // sala ficava bloqueada para sempre. Como o `canReadMap` do menu pode FALHAR na primeira
      // subida (ainda não faz 5 s de Save), o ciclo é o que dá a segunda chance.
      this.step = stillStalled ? (this.step >= 4 ? 1 : this.step + 1) : 0;
      this.rung = 'NONE';
    }
    if (v.stallTicks < 24) {
      this.step = 0;
      this.rung = 'NONE';
      this.lastStallSeen = v.stallTicks;
      return NONE_PLAN;
    }

    // sobe degraus enquanto o travamento continua crescendo
    // os degraus abrem cedo de propósito. No playtest o poço de 783 ticks (sala 0x8CA9) subiu a
    // escada inteira e SAIU dela — mas só depois de ~13 s por degrau, porque metade dos ticks foi
    // perdoada por pouso em chão novo e por combate. Com 40/70/120/200/320 a sala é bloqueada em
    // ~37 s de travamento real, que é o "piso" que o relatório cobrou.
    const wantStep = clamp(
      v.stallTicks >= 320 ? 4 : v.stallTicks >= 200 ? 3 : v.stallTicks >= 120 ? 2 : v.stallTicks >= 70 ? 1 : 0,
      0,
      4,
    );
    this.step = Math.max(this.step, wantStep);

    const rungs: EscapeRung[] = ['NUDGE', 'REVERSE_PUSH', 'SWEEP', 'MAP_READ', 'BLOCK_ROOM'];
    const rung = rungs[this.step];
    if (rung === 'MAP_READ' && !opts.canReadMap && this.step < 4) this.step += 1;
    const chosen: EscapeRung = rungs[this.step];

    if (this.rung === 'NONE') {
      this.rung = chosen;
      this.until = tick + this.budgetTicks[this.step];
    }

    this.lastStallSeen = v.stallTicks;

    const opposite = v.pushDir === 'LEFT' ? 'RIGHT' : v.pushDir === 'RIGHT' ? 'LEFT' : null;
    let dir: Dir | null = null;
    if (this.rung === 'REVERSE_PUSH' || this.rung === 'BLOCK_ROOM') dir = opposite ?? 'RIGHT';
    if (this.rung === 'SWEEP') dir = opposite ?? 'RIGHT';

    if (opts.inCombat) {
      // a briga manda: medimos, não interrompemos (empurrão/inversão no meio de um Core-X é
      // como perder a luta). A escada volta a agir no tick seguinte, se ainda estiver travada.
      this.lastStallSeen = v.stallTicks;
      return { ...NONE_PLAN, reason: 'travada em combate · o combate manda primeiro' };
    }

    return {
      rung: this.rung,
      dir,
      jump: this.rung === 'NUDGE' || this.rung === 'REVERSE_PUSH' || this.rung === 'SWEEP',
      durationTicks: Math.max(0, this.until - tick),
      engaged: true,
      step: this.step,
      reason:
        this.rung === 'NUDGE'
          ? `Escape · impulso (${v.stallTicks} ticks parada)`
          : this.rung === 'REVERSE_PUSH'
            ? `Escape · invertendo o empurrão para ${dir}`
            : this.rung === 'SWEEP'
              ? 'Escape · varrendo com tiro para achar vão'
              : this.rung === 'MAP_READ'
                ? 'Escape · abrindo o mapa do jogo'
                : 'Escape · sala bloqueada no grafo, mudando de rota',
    };
  }

  get snapshot(): { rung: EscapeRung; step: number; ticksLeft: number } {
    return { rung: this.rung, step: this.step, ticksLeft: Math.max(0, this.until - this.lastStallSeen) };
  }
}

/* ---------------------------------------------------------- JumpModulator */

export interface JumpShape {
  /** frames de jogo para segurar o botão (a altura do pulo é integrada por frame, não por tick) */
  holdFrames: number;
  /** `time` do AIAction: é isto que faz o app soltar o botão na hora certa */
  holdMs: number;
  /** ticks de decisão que o aperto cobre (para o `nextJump(holdTicks)` antigo) */
  holdTicks: number;
  /** deve cortar o aperto agora? (altura já alcançada) */
  release: boolean;
  /** vão vertical que ela precisa vencer, em px (positivo = para cima) */
  gapPx: number;
  why: string;
}

/**
 * Pulos com altura variável.
 *
 * O `nextJump(want, 3)` antigo devolvia "segure 3 ticks" sem saber o vão — e como um tick de
 * decisão do app vale 90–160 ms (5,5 a 9,5 frames), o mais fino que ela conseguia fazer era um
 * pulo quase cheio: errava borda de 8 px por cima e nunca emendava o segundo toque fino. A
 * correção tem dois lados: (1) o vão define os **frames** de aperto; (2) o `time` da ação é
 * encurtado para que o próximo tick venha antes do fim do aperto, ou seja, o loop passa a ter
 * resolução de pulo (o EmulatorPlayer precisa parar de estourar `time` para 90 ms — ver
 * `FRAME_MS` lá).
 *
 * Física de referência do Super Metroid: pulo normal ~52 px de ápice, ~22 frames até o ápice
 * apertando o botão inteiro; soltar antes corta a subida (é o único "freio" que existe).
 */
export class JumpModulator {
  private takeoffY = 0;
  private inAir = false;
  /** frames por tick — o chamador informa a cadência real (60 / fpsEfetivo) */
  readonly FRAME_MS = 1000 / 60;

  reset(): void {
    this.inAir = false;
    this.takeoffY = 0;
  }

  /**
   * @param targetY  y da borda alvo (menor = mais alto)
   * @param samusY   y atual
   * @param grounded tem chão?
   * @param msPerDecision orçamento do próximo tick (vira `AIAction.time`)
   */
  plan(targetY: number, samusY: number, grounded: boolean, msPerDecision = 125): JumpShape {
    if (grounded) {
      this.inAir = true;
      this.takeoffY = samusY;
    }
    const gapPx = Math.max(0, samusY - targetY);
    // o que o vão PIDIA na decolagem: comparar `risenPx` com o vão RESTANTE faria o corte
    // antecipado disparar no primeiro tick do pulo (ainda faltando metade da altura)
    const neededPx = Math.max(0, this.takeoffY - targetY);
    const risenPx = Math.max(0, this.takeoffY - samusY);

    // frames de aperto ≈ frames até o ápice necessários (com folga de 2 para a quina)
    let holdFrames: number;
    let why: string;
    if (gapPx <= 6) {
      holdFrames = 3;
      why = 'vão mínimo · toque para contornar quina';
    } else if (gapPx <= 24) {
      holdFrames = 6;
      why = `vão de ${Math.round(gapPx)} px · pulo curto`;
    } else if (gapPx <= 64) {
      holdFrames = 14;
      why = `vão de ${Math.round(gapPx)} px · pulo médio`;
    } else if (gapPx <= 110) {
      holdFrames = 22;
      why = `vão de ${Math.round(gapPx)} px · pulo cheio`;
    } else {
      holdFrames = 26;
      why = `vão de ${Math.round(gapPx)} px · pulo cheio (acima do pulo simples: encadeie na parede/plataforma)`;
    }

    const holdMs = Math.max(1, Math.round(holdFrames * this.FRAME_MS));
    const holdTicks = clamp(Math.ceil(holdMs / Math.max(1, msPerDecision)), 1, 6);
    const release = this.inAir && !grounded && risenPx >= neededPx - 4;
    const reason = release ? `altura de ${Math.round(risenPx)}px atingida · soltando o pulo` : why;

    return { holdFrames, holdMs, holdTicks, release, gapPx, why: reason };
  }

  /** chamada quando o pouso acontece */
  land(grounded: boolean): void {
    if (grounded) this.inAir = false;
  }
}

/* -------------------------------------------------------------- SlotDriver */

export type HudSlot = 0 | 1 | 2 | 3;

export interface SlotStep {
  /** precisa dar outro toque em SELECT neste tick? */
  tapSelect: boolean;
  /** precisa voltar ao feixe (Y/cancel)? */
  restoreBeam: boolean;
  /** desistiu de achar o slot (HUD customizado): não fica pingando */
  gaveUp: boolean;
  /** slot pretendido */
  want: HudSlot;
  why: string;
}

/**
 * O SELECT do Super Metroid é um **seletor rotativo** do item especial, não um botão "usar
 * míssil". O agente antigo dava um toque e atirava torcendo; em porta verde (super míssil)
 * isso nunca funciona. Aqui o driver sabe quantas casas existem, conta toques e desiste com
 * vergonha quando o HUD não bate (que é o que acontece em hack com HUD customizado).
 */
export class SlotDriver {
  private taps = 0;
  private gaveUp = false;
  private wantSlot: HudSlot | null = null;
  /**
   * "slot recém-girado ainda está armado": a janela em que o toque de SELECT acabou de acontecer
   * e o HUD vai bater no item pedido nos próximos ticks. Sem isto, o ramo de "voltar ao feixe
   * principal" desfaz a seleção no tick seguinte e o tiro sai com o feixe — foi exatamente o loop
   * `UP+SELECT` / `RIGHT+Y` que a simulação de navegação mostrou.
   */
  private armedUntil = -1;
  /** orçado: itens especiais que o jogador realmente tem (míssil, super, power bomb) */
  private ownedSlots = 1;

  reset(): void {
    this.taps = 0;
    this.gaveUp = false;
    this.wantSlot = null;
    this.armedUntil = -1;
  }

  /** o item pedido fica armado por `ticks` decisões a partir de `tick` */
  arm(tick: number, ticks: number): void {
    this.armedUntil = Math.max(this.armedUntil, tick + Math.max(1, ticks));
  }

  /** true enquanto um pedido de slot está no ar — ninguém mais pode "devolver ao feixe" */
  armed(tick: number): boolean {
    return tick <= this.armedUntil;
  }

  /** o cadastro de munição muda durante o jogo; o número de casas do SELECT muda junto */
  setOwnedAmmo(hasMissiles: boolean, hasSupers: boolean, hasPowerBombs: boolean): void {
    const owned = (hasMissiles ? 1 : 0) + (hasSupers ? 1 : 0) + (hasPowerBombs ? 1 : 0);
    if (owned + 1 !== this.ownedSlots) {
      this.ownedSlots = owned + 1;
      this.gaveUp = false;
      this.taps = 0;
    }
  }

  plan(tick: number, current: HudSlot, want: HudSlot, hasSpecial: boolean): SlotStep {
    if (this.gaveUp && this.wantSlot === want) {
      return { tapSelect: false, restoreBeam: false, gaveUp: true, want, why: 'slot indisponível · seguindo com o item atual' };
    }
    if (want === 0) {
      this.reset();
      return {
        tapSelect: false,
        restoreBeam: current !== 0,
        gaveUp: false,
        want,
        why: current !== 0 ? `voltando ao feixe (slot ${current} → 0)` : 'feixe já selecionado',
      };
    }
    if (!hasSpecial) {
      this.wantSlot = want;
      this.gaveUp = true;
      return { tapSelect: false, restoreBeam: false, gaveUp: true, want, why: 'sem munição para esse slot · não desperdiça' };
    }
    if (current === want) {
      // chegou: segura armado por mais algumas decisões para o disparo sair com o item certo
      this.arm(tick, 3);
      this.taps = 0;
      this.gaveUp = false;
      this.wantSlot = want;
      return { tapSelect: false, restoreBeam: false, gaveUp: false, want, why: `slot ${want} selecionado` };
    }
    if (this.wantSlot !== want) {
      this.wantSlot = want;
      this.taps = 0;
      this.gaveUp = false;
    }
    this.taps++;
    if (this.taps > this.ownedSlots + 1) {
      this.gaveUp = true;
      this.taps = 0;
      return { tapSelect: false, restoreBeam: false, gaveUp: true, want, why: `deu a volta no SELECT sem achar o slot ${want}` };
    }
    this.arm(tick, 4);
    return {
      tapSelect: true,
      restoreBeam: false,
      gaveUp: false,
      want,
      why: `girando SELECT para o slot ${want} (atual ${current}, toque ${this.taps}/${this.ownedSlots + 1})`,
    };
  }

  get state(): { taps: number; gaveUp: boolean; ownedSlots: number } {
    return { taps: this.taps, gaveUp: this.gaveUp, ownedSlots: this.ownedSlots };
  }
}

/* --------------------------------------------------------------- PreyChaser */

export interface PreyCandidate {
  slot: number;
  x: number;
  y: number;
  hp: number;
  xRadius: number;
  yRadius: number;
  /** veio de um abate no tick atual/último? */
  fromKill?: boolean;
}

export type PreyIntent =
  | { kind: 'NONE' }
  /** matar: alinhar a mira e atirar no alvo travado */
  | { kind: 'ENGAGE'; slot: number; aim: 'UP' | 'DOWN' | null; dir: Dir }
  /** o parasita X está solto: encostar é o que coleta (atirar destrói) */
  | { kind: 'ABSORB'; slot: number; dir: Dir; aim: 'UP' | 'DOWN' | null }
  | { kind: 'SWEEP_LOOT'; x: number; y: number; dir: Dir };

/**
 * Prioridade de alvo e a janela de coleta do parasita X.
 *
 * No *X-Fusion* (como em Fusion) o inimigo abatido libera um X azul flutuante: atirar nele é
 * jogar cura fora. O agente antigo não tinha esse conceito — por isso o playtest inteiro não
 * coletou nada. Regras:
 *  - **lock-on**: um alvo por vez (`slot`), enquanto ele existir ou até 90 ticks, sem ficar
 *    trocando de alvo a cada tick (o "alvo que pisca" fazia ela atirar em nada);
 *  - **mira alinhada**: se o alvo está a mais de meia altura de Samus, mira para cima/baixo —
 *    tiro horizontal em inimigovoando é tiro perdido;
 *  - **janela de loot**: ao detectar abate (contagem de inimigos caiu), os próximos 120 ticks
 *    são de coleta quando há algo a recuperar (vida abaixo de 98% ou munição abaixo do teto);
 *  - **absorver > matar**: entidade pequena, lenta e sem dano próprio aparente = X solto:
 *    anda até ela em vez de atirar.
 */
export class PreyChaser {
  private lockedSlot: number | null = null;
  private lockedUntil = 0;
  private lastAlive = 0;
  private lootUntil = 0;
  private lootX = 0;
  private lootY = 0;
  /** corpo do abate: onde procurar o X que saiu dele */
  private killSpot: { x: number; y: number; tick: number } | null = null;

  readonly LOCK_TICKS = 90;
  /**
   * Janela curta de propósito: "procurar o X que o abate soltou" só faz sentido logo depois do
   * abate. 120 ticks viravam 5 segundos andando de um lado para o outro atrás de um X que o
   * jogo já tinha absorvido — foi o que a simulação de chefe pegou (a Samus saiu do canto de
   * segurança no meio do Spore.exe).
   */
  readonly LOOT_WINDOW = 55;

  reset(): void {
    this.lockedSlot = null;
    this.lockedUntil = 0;
    this.lootUntil = 0;
    this.killSpot = null;
    this.lastAlive = 0;
  }

  private static isDrifter(p: PreyCandidate): boolean {
    // X solto: hitbox pequena, quase sem "vida" declarada e flutuando perto de Samus
    return p.xRadius <= 10 && p.yRadius <= 10 && (p.hp <= 1 || p.fromKill === true);
  }

  private static aimFor(samusY: number, y: number): 'UP' | 'DOWN' | null {
    if (y < samusY - 18) return 'UP';
    if (y > samusY + 26) return 'DOWN';
    return null;
  }

  /**
   * @param alive lista de alvos hostis reconhecidos no tick
   * @param samusX/Y posição
   * @param wantFight o contexto permite lutar agora? (chefes/SA-X têm roteiro próprio)
   */
  decide(
    tick: number,
    candidates: PreyCandidate[],
    samus: { x: number; y: number },
    ctx: { wantFight: boolean; needHeal: boolean; needAmmo: boolean; maxHealth: number },
  ): PreyIntent {
    const alive = candidates.length;
    // " Houve um abate" = o alvo TRAVADO saiu de cena (hp 0 ou sumiu da lista), não "a lista
    // encolheu" — inimigos comuns somem da nossa visão por outros motivos (fora do recorte,
    // ignorado como estático) e abrir a janela de loot por isso manda a IA caçar nada.
    const locked = this.lockedSlot != null ? candidates.find((c) => c.slot === this.lockedSlot) : undefined;
    if (this.lockedSlot != null && (!locked || locked.hp <= 0) && tick <= this.lockedUntil + 30) {
      const spot = this.killSpot ?? { x: samus.x, y: samus.y };
      this.lootX = spot.x;
      this.lootY = spot.y;
      this.lootUntil = tick + this.LOOT_WINDOW;
      this.lockedSlot = null;
      this.lockedUntil = 0;
    }
    if (locked) this.killSpot = { x: locked.x, y: locked.y, tick };
    this.lastAlive = alive;

    // sem licença de brigar, o predador não existe: quem manda no corpo é o roteiro do chefe
    // (a coleta de X depois do abate é feita pelo próprio caminho de recompensa do codex)
    if (!ctx.wantFight) {
      this.lockedSlot = null;
      this.lootUntil = 0;
      return { kind: 'NONE' };
    }

    // 1) X solto na tela: encostar, nunca atirar
    const drifter = candidates.find((c) => PreyChaser.isDrifter(c) && Math.abs(c.y - samus.y) < 96);
    if (drifter) {
      return {
        kind: 'ABSORB',
        slot: drifter.slot,
        dir: drifter.x >= samus.x ? 'RIGHT' : 'LEFT',
        aim: PreyChaser.aimFor(samus.y, drifter.y),
      };
    }

    // 2) janela de loot aberta e HÁ o que recuperar (vida ou munição baixas): varre o ponto
    if (tick < this.lootUntil && (ctx.needHeal || ctx.needAmmo)) {
      const near = Math.abs(this.lootX - samus.x) < 24 && Math.abs(this.lootY - samus.y) < 24;
      if (!near) {
        return {
          kind: 'SWEEP_LOOT',
          x: this.lootX,
          y: this.lootY,
          dir: this.lootX >= samus.x ? 'RIGHT' : 'LEFT',
        };
      }
      // chegou no ponto e nada flutuando: dá mais duas varridas e desiste
      if (alive === 0) this.lootUntil = Math.min(this.lootUntil, tick + 30);
    }

    if (!ctx.wantFight || alive === 0) {
      this.lockedSlot = null;
      return { kind: 'NONE' };
    }

    // 3) lock-on no alvo mais próximo que ainda existe; se não existe mais, re-escolhe
    let target = this.lockedSlot != null ? candidates.find((c) => c.slot === this.lockedSlot) : undefined;
    if (!target || tick > this.lockedUntil) {
      target = candidates
        .map((c) => ({ c, d: Math.abs(c.x - samus.x) + Math.abs(c.y - samus.y) * 0.6 }))
        .sort((a, b) => a.d - b.d)[0]?.c;
      if (target) {
        this.lockedSlot = target.slot;
        this.lockedUntil = tick + this.LOCK_TICKS;
      }
    }
    if (!target) return { kind: 'NONE' };

    // onde o alvo está AGORA é o onde o X vai sair: guardar isso é o que permite a varredura
    // apontar para o corpo (e não para onde a Samus já estava)
    this.killSpot = { x: target.x, y: target.y, tick };

    return {
      kind: 'ENGAGE',
      slot: target.slot,
      aim: PreyChaser.aimFor(samus.y, target.y),
      dir: target.x >= samus.x ? 'RIGHT' : 'LEFT',
    };
  }

  get state(): { lockedSlot: number | null; lootTicksLeft: number } {
    return { lockedSlot: this.lockedSlot, lootTicksLeft: this.lootUntil };
  }
}

/* ------------------------------------------------------ DoorAttemptBudget */

/**
 * Orçamento da tentativa de porta. Ficar na soleira atirando e girando slot **não** é progresso,
 * e foi assim que a sessão de 25 min terminou: 9.160 ticks (79 % do tempo) em `0x8CB3 x=216`
 * com `Abrindo porta (RIGHT)`, com o sentinela mudo porque o chão daquela soleira é lido como
 * "no ar". Um humano atira, gira o slot, espera o scroll e — se nada acontece — trata a porta
 * como trancada e procura outra. É isto que esta classe decide; quem executa é o agente.
 *
 * Dois detalhes que já pegaram regressão:
 *  - o disparo é `>=` com trava por porta, não `=== N`: se a leitura de "near door" piscar (ela
 *    sai 5 px da janela e volta), um `=== 120` nunca chega a bater e o orçamento vira enfeite;
 *  - ausência curta é **janela de tolerância** (não zera, não conta), ausência longa zera. As
 *    duas versões ingênuas — "decai sempre" e "zera sempre" — foram testadas e reprovariam: a
 *    primeira dá anistia a cada piscada (o prazo nunca vence), a segunda perdoa o pacing.
 */
export class DoorAttemptBudget {
  private key = '';
  private ticks = 0;
  private awayRun = 0;
  private fired = false;

  /**
   * @param grace  ausências de até `grace` ticks consecutivos são *janela de tolerância* (o
   *   sensor "perto da porta" pisca quando ela anda na soleira), não uma saída. Depois disso é
   *   saída de verdade: a conta é zerada, porque ela foi fazer outra coisa.
   */
  constructor(private readonly budget = 120, private readonly grace = 8) {}

  /**
   * @param doorKey  porta-alvo da sala, ou `null` quando ela não está na soleira de nenhuma
   * @returns `true` no tick em que se deve desistir da porta (uma vez só por porta)
   */
  feed(_tick: number, roomId: number, doorKey: string | null): boolean {
    // a IDENTIDADE é a porta; a ausência é um estado dela. Trocar isso por "key = '' quando está
    // fora" faz cada piscada trocar de identidade e o reset apagar a conta — foi exatamente o que
    // o teste pegou (a janela de tolerância nunca existia).
    if (doorKey) {
      const key = `${roomId}:${doorKey}`;
      if (key !== this.key) {
        this.key = key;
        this.ticks = 0;
        this.awayRun = 0;
        this.fired = false;
      }
    }
    if (!doorKey) {
      this.awayRun++;
      if (this.awayRun > this.grace) {
        this.ticks = 0;
        this.fired = false;
      }
      return false;
    }
    this.awayRun = 0;
    this.ticks++;
    if (this.ticks >= this.budget && !this.fired) {
      this.fired = true;
      return true;
    }
    return false;
  }

  /** troca de sala / novo jogo */
  reset(): void {
    this.key = '';
    this.ticks = 0;
    this.awayRun = 0;
    this.fired = false;
  }

  get state(): { doorKey: string; ticks: number; budget: number } {
    return { doorKey: this.key, ticks: this.ticks, budget: this.budget };
  }

  get gaveUp(): boolean {
    return this.fired;
  }
}

/* -------------------------------------------------------------- facade */

export interface GuardianSnapshot {
  stallTicks: number;
  roomTicks: number;
  severity: number;
  pushDir: Dir | null;
  pinnedEdge: 'LEFT' | 'RIGHT' | null;
  escape: { rung: EscapeRung; step: number };
  hypotheses: Array<{ key: string; kind: string; attempts: number; failures: number; status: string; note: string }>;
  deadCount: number;
  slot: { taps: number; gaveUp: boolean; ownedSlots: number };
  lock: { lockedSlot: number | null };
  /** tentativa de porta: em que porta ela está e há quantos ticks (`budget` = limite) */
  doorAttempt: { doorKey: string; ticks: number; budget: number };
  jump: { holdTicks: number; holdFrames: number; gapPx: number };
}

/**
 * Fachada única usada pelo `LocalVisionAgent`: um objeto por sessão de jogo, custando algumas
 * centenas de bytes e nenhum aloque no laço quente além dos retornos de estado.
 */
export class ActionGuardian {
  readonly hypotheses = new HypothesisLedger();
  readonly sentinel = new StuckSentinel();
  readonly ladder = new EscapeLadder();
  readonly jump = new JumpModulator();
  readonly slots = new SlotDriver();
  readonly prey = new PreyChaser();
  readonly doorBudget = new DoorAttemptBudget();
  private lastJump: JumpShape = { holdTicks: 3, holdFrames: 24, holdMs: 400, release: false, gapPx: 0, why: '' };

  reset(): void {
    this.hypotheses.clear();
    this.sentinel.reset();
    this.ladder.reset();
    this.jump.reset();
    this.slots.reset();
    this.prey.reset();
    this.doorBudget.reset();
  }

  /** esquece apostas mortas de uma sala quando um item novo a reabre */
  reopenRoom(roomId: number): void {
    this.hypotheses.resetRoom(roomId);
  }

  snapshot(): GuardianSnapshot {
    const v = this.sentinel.current;
    const deadCount = this.hypotheses.deadCount();
    return {
      stallTicks: v.stallTicks,
      roomTicks: v.roomTicks,
      severity: v.severity,
      pushDir: v.pushDir,
      pinnedEdge: v.pinnedEdge,
      escape: { rung: this.ladder.currentRung, step: this.ladder.snapshot.step },
      hypotheses: this.hypotheses.snapshot(6),
      deadCount,
      slot: this.slots.state,
      lock: this.prey.state,
      doorAttempt: this.doorBudget.state,
      jump: {
        holdTicks: this.lastJump.holdTicks,
        holdFrames: this.lastJump.holdFrames,
        gapPx: Math.round(this.lastJump.gapPx),
      },
    };
  }

  /** atalho usado pelos call-sites de pulo */
  jumpHold(targetY: number, samusY: number, grounded: boolean, msPerDecision = 125): JumpShape {
    this.lastJump = this.jump.plan(targetY, samusY, grounded, msPerDecision);
    return this.lastJump;
  }
}
