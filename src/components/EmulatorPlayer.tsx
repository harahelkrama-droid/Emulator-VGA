import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Cpu, Database, Gamepad2, Maximize2, Power, RotateCcw, Save, Shield, Timer, X } from 'lucide-react';
import {
  captureGameFrame,
  getEmulatorGameManager,
  isEmulatorReady,
  mountEmulator,
  releaseAllGameInputs,
  restartEmulatorGame,
  setHeldGameInputs,
} from '../lib/emulatorBridge';
import { askGemini, askOllama } from '../lib/externalAI';
import { LocalVisionAgent } from '../lib/localVisionAI';
import { clearAIKnowledge, getSaveSummary, readAIKnowledge, readSaveSlot, upsertAIKnowledge, writeSaveSlot } from '../lib/saveDb';
import { readMetroidWram } from '../lib/snesWram';
import type {
  AIAction,
  AIEngine,
  AIKey,
  AIProfile,
  AIStatusSnapshot,
  EncounterKnowledgeRecord,
  GameItem,
  SaveSlotSummary,
} from '../types/emulator';
import { TouchControls } from './TouchControls';

interface EmulatorPlayerProps {
  game: GameItem;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

const DIFFICULTY_OPTIONS = [
  'Super / Super Fácil',
  'Easy / Fácil',
  'Normal',
  'Hard / Difícil',
  'Omega',
];

const ENGINE_STORAGE = 'retroplay_ai_engine_v2';
const PROFILE_STORAGE = 'retroplay_ai_profile_v2';
const GEMINI_KEY_STORAGE = 'retroplay_gemini_api_key';

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function EmulatorPlayer({ game, onClose, onNotify }: EmulatorPlayerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const screenWrapRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewTempCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewImgDataRef = useRef<ImageData | null>(null);
  const agentRef = useRef<LocalVisionAgent>(new LocalVisionAgent());
  const aiLoopStopRef = useRef<{ active: boolean; controller: AbortController | null }>({
    active: false,
    controller: null,
  });

  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPortraitViewport, setIsPortraitViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight > window.innerWidth : false,
  );
  const [footMessage, setFootMessage] = useState('Inicializando núcleo do emulador…');
  const [slots, setSlots] = useState<[SaveSlotSummary, SaveSlotSummary]>([
    { slot: 1, savedAt: null, byteLength: 0 },
    { slot: 2, savedAt: null, byteLength: 0 },
  ]);
  const [pendingOverwriteSlot, setPendingOverwriteSlot] = useState<1 | 2 | null>(null);
  const [showTouchPad, setShowTouchPad] = useState(false);

  // IA State
  const [aiActive, setAiActive] = useState(false);
  const [aiEngine, setAiEngine] = useState<AIEngine>(() => {
    const saved = localStorage.getItem(ENGINE_STORAGE) as AIEngine | null;
    return saved === 'ollama' || saved === 'gemini' || saved === 'local-vision' ? saved : 'local-vision';
  });
  const [aiProfile, setAiProfile] = useState<AIProfile>(() => {
    const saved = localStorage.getItem(PROFILE_STORAGE) as AIProfile | null;
    if (saved === 'rpg' || saved === 'action') return saved;
    return /pok[eé]mon|rpg|zelda|final fantasy/i.test(game.title) ? 'rpg' : 'action';
  });
  const [targetDiff, setTargetDiff] = useState<string>(DIFFICULTY_OPTIONS[0]);
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem(GEMINI_KEY_STORAGE) || '');
  const [aiStatusText, setAiStatusText] = useState('Pronta (Sem API)');
  const [aiLastKeys, setAiLastKeys] = useState<string>('—');
  const [aiLatencyMs, setAiLatencyMs] = useState<string>('—');
  const [aiSceneLabel, setAiSceneLabel] = useState<string>('Aguardando início');
  const [aiReason, setAiReason] = useState<string>(
    'Ao ativar, o jogo entra em tela cheia e a IA joga em tempo real coletando itens e fugindo da SA-X até o confronto final.',
  );
  const [snapshot, setSnapshot] = useState<AIStatusSnapshot | null>(null);
  const [knowledgeLog, setKnowledgeLog] = useState<EncounterKnowledgeRecord[]>([]);
  const [showArmorDetails, setShowArmorDetails] = useState(true);
  const [aiCautionApproved, setAiCautionApproved] = useState(false);
  const [aiPromptQuestion, setAiPromptQuestion] = useState<string | null>(null);

  const fileName = `${game.title}.${game.file.split('.').pop()?.toLowerCase() === 'gba' ? 'gba' : 'sfc'}`;
  const isGba = /\.gba$/i.test(game.file);

  const refreshSlots = async () => {
    try {
      const summary = await getSaveSummary(game.file);
      setSlots(summary);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    const syncLayout = () => {
      const activeFs = Boolean(document.fullscreenElement);
      setIsFullscreen(activeFs);
      setIsPortraitViewport(window.innerHeight > window.innerWidth);
      if (!activeFs) {
        try {
          (screen.orientation as { unlock?: () => void } | undefined)?.unlock?.();
        } catch {
          // Ignore unlock errors
        }
      }
    };
    document.addEventListener('fullscreenchange', syncLayout);
    window.addEventListener('resize', syncLayout);
    window.addEventListener('orientationchange', syncLayout);
    return () => {
      document.removeEventListener('fullscreenchange', syncLayout);
      window.removeEventListener('resize', syncLayout);
      window.removeEventListener('orientationchange', syncLayout);
    };
  }, []);

  const enterFullscreen = async () => {
    const el = screenWrapRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      try {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        }
      } catch {
        // Fallback em navegadores que bloqueiam fullscreen programático
      }
    }
    try {
      const orientation = screen.orientation as { lock?: (mode: string) => Promise<void> } | undefined;
      if (orientation && typeof orientation.lock === 'function') {
        await orientation.lock('landscape');
      }
    } catch {
      // Caso o dispositivo não suporte lock() nativo, a classe CSS rotaciona para paisagem automaticamente
    }
    setIsPortraitViewport(window.innerHeight > window.innerWidth);
  };

  const exitFullscreen = async () => {
    try {
      (screen.orientation as { unlock?: () => void } | undefined)?.unlock?.();
    } catch {
      // Ignore
    }
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      // Ignore
    }
  };

  const stopAI = () => {
    aiLoopStopRef.current.active = false;
    if (aiLoopStopRef.current.controller) {
      aiLoopStopRef.current.controller.abort();
      aiLoopStopRef.current.controller = null;
    }
    releaseAllGameInputs();
    setAiActive(false);
    setAiStatusText(aiEngine === 'local-vision' ? 'Pronta (Sem API)' : 'Pausada');
  };

  useEffect(() => {
    setReady(false);
    setFootMessage('Inicializando núcleo do emulador…');
    refreshSlots();
    void readAIKnowledge(game.file).then(setKnowledgeLog);

    if (!mountRef.current) return;
    const cleanup = mountEmulator({
      mountElement: mountRef.current,
      gameUrl: game.isLocalBlob ? game.file : encodeURI(game.file),
      fileName,
      onReady: () => {
        setReady(true);
        setFootMessage('Pronto · Setas, Z(A), X(B), A(X), S(Y), Enter(Start), V(Select)');
      },
      onError: (msg) => {
        setReady(false);
        setFootMessage(msg);
        onNotify(msg);
      },
    });

    return () => {
      stopAI();
      cleanup();
    };
  }, [game.file]);

  const performSaveSlot = async (slot: 1 | 2, force = false) => {
    if (!isEmulatorReady()) {
      onNotify('Aguarde o emulador terminar de iniciar.');
      return;
    }
    const existing = await readSaveSlot(game.file, slot);
    if (existing && !force) {
      setPendingOverwriteSlot(slot);
      return;
    }
    setPendingOverwriteSlot(null);
    const gm = getEmulatorGameManager();
    if (!gm || typeof gm.getState !== 'function') {
      onNotify('Núcleo sem suporte a save state.');
      return;
    }
    const resolvedState = await Promise.resolve(gm.getState());
    if (!resolvedState) {
      onNotify('Nenhum dado retornado para salvar.');
      return;
    }
    const bytes = resolvedState instanceof Uint8Array ? resolvedState : new Uint8Array(resolvedState);
    await writeSaveSlot(game.file, slot, bytes);
    await refreshSlots();
    onNotify(`Slot ${slot} salvo neste navegador.`);
  };

  const performLoadSlot = async (slot: 1 | 2) => {
    if (!isEmulatorReady()) {
      onNotify('Aguarde o emulador terminar de iniciar.');
      return;
    }
    const saved = await readSaveSlot(game.file, slot);
    if (!saved) {
      onNotify(`O slot ${slot} está vazio.`);
      return;
    }
    const gm = getEmulatorGameManager();
    if (!gm || typeof gm.loadState !== 'function') {
      onNotify('Núcleo sem suporte para carregar save state.');
      return;
    }
    const bytes = saved.state instanceof Uint8Array ? saved.state : new Uint8Array(saved.state);
    await gm.loadState(bytes);
    onNotify(`Slot ${slot} carregado.`);
  };

  const drawPreviewFrame = (rgba: Uint8ClampedArray, w: number, h: number) => {
    const pv = previewCanvasRef.current;
    if (!pv) return;
    const ctx = pv.getContext('2d');
    if (!ctx) return;
    if (!previewTempCanvasRef.current) {
      previewTempCanvasRef.current = document.createElement('canvas');
    }
    const temp = previewTempCanvasRef.current;
    if (temp.width !== w || temp.height !== h) {
      temp.width = w;
      temp.height = h;
      previewImgDataRef.current = null;
    }
    const tctx = temp.getContext('2d');
    if (!tctx) return;
    if (!previewImgDataRef.current) {
      previewImgDataRef.current = tctx.createImageData(w, h);
    }
    previewImgDataRef.current.data.set(rgba);
    tctx.putImageData(previewImgDataRef.current, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, 0, 0, pv.width, pv.height);
  };

  const startAILoop = async (cautionAlreadyApproved = aiCautionApproved, openFullscreen = true) => {
    if (!ready) {
      onNotify('Aguarde o jogo iniciar antes de ativar a IA.');
      return;
    }
    setShowTouchPad(false);
    if (openFullscreen) {
      void enterFullscreen();
    }
    setAiPromptQuestion(null);
    agentRef.current.reset();
    aiLoopStopRef.current.active = true;
    setAiActive(true);

    while (aiLoopStopRef.current.active) {
      try {
        const startedAt = performance.now();
        const wram = aiEngine === 'local-vision' ? await readMetroidWram() : null;
        const maxCacheAgeMs =
          aiEngine === 'local-vision'
            ? wram?.valid
              ? wram.enemies.length > 0 || wram.countdownActive
                ? 260
                : document.fullscreenElement && wram.gameState === 8
                  ? 3000
                  : 800
              : 220
            : 0;
        const frame = await captureGameFrame({
          skipJpeg: aiEngine === 'local-vision',
          maxCacheAgeMs,
        });
        if (frame.fresh !== false) {
          drawPreviewFrame(frame.rgba, frame.width, frame.height);
        }

        let action: AIAction;
        if (aiEngine === 'local-vision') {
          action = agentRef.current.decide(frame, aiProfile, targetDiff, wram);
        } else {
          const ctrl = new AbortController();
          aiLoopStopRef.current.controller = ctrl;
          if (aiEngine === 'ollama') {
            action = await askOllama(frame.base64Jpeg, aiProfile, targetDiff, cautionAlreadyApproved, ctrl.signal);
          } else {
            action = await askGemini(
              geminiKey,
              frame.base64Jpeg,
              aiProfile,
              targetDiff,
              cautionAlreadyApproved,
              ctrl.signal,
            );
          }
          aiLoopStopRef.current.controller = null;
        }

        if (!aiLoopStopRef.current.active) break;

        const keysToHold: AIKey[] = action.keys && action.keys.length > 0 ? action.keys : [action.key];
        const elapsed = Math.round(performance.now() - startedAt);
        setAiLatencyMs(`${elapsed} ms`);
        setAiLastKeys(keysToHold.join('+') || 'NONE');
        setAiSceneLabel(action.sceneLabel || (action.phase === 'menu' ? 'Menu' : 'Jogando'));
        setAiReason(action.reason || `Executando ${keysToHold.join('+')}`);
        setAiStatusText(aiEngine === 'local-vision' ? 'Jogando (Local Sem API)' : `Ativa (${aiEngine})`);
        if (action.snapshot) {
          setSnapshot(action.snapshot);
        }
        if (action.learnedKnowledge && action.learnedKnowledge.length > 0) {
          for (const entry of action.learnedKnowledge) {
            try {
              const updated = await upsertAIKnowledge(game.file, entry);
              setKnowledgeLog(updated);
            } catch {
              // Ignora erro pontual de gravação
            }
          }
        }

        if (action.phase === 'unsure' || action.phase === 'missing') {
          stopAI();
          setAiPromptQuestion(action.question || 'A IA pediu confirmação para continuar nesta tela.');
          break;
        }

        if (aiEngine === 'local-vision') {
          // Loop contínuo em tempo real (~125ms) mantendo teclas pressionadas entre quadros sem soltar no vácuo
          setHeldGameInputs(keysToHold);
          await sleep(Math.min(160, Math.max(90, action.time)));
        } else {
          setHeldGameInputs(keysToHold);
          await sleep(action.time);
          releaseAllGameInputs();
          await sleep(160);
        }
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') break;
        if (aiEngine === 'gemini' && !navigator.onLine) {
          setAiEngine('local-vision');
          onNotify('Sem internet: alternado para IA Local sem API.');
          continue;
        }
        setAiStatusText(`Erro: ${error.message.slice(0, 48)}`);
        setAiReason(error.message);
        releaseAllGameInputs();
        aiLoopStopRef.current.active = false;
        setAiActive(false);
        break;
      }
    }
    releaseAllGameInputs();
  };

  const handleEngineChange = (next: AIEngine) => {
    stopAI();
    setAiEngine(next);
    localStorage.setItem(ENGINE_STORAGE, next);
    setAiStatusText(next === 'local-vision' ? 'Pronta (Sem API)' : 'Pronta');
  };

  const handleProfileChange = (next: AIProfile) => {
    setAiProfile(next);
    localStorage.setItem(PROFILE_STORAGE, next);
    agentRef.current.reset();
  };

  const handleFullscreenToggle = () => {
    if (document.fullscreenElement) {
      void exitFullscreen();
    } else {
      void enterFullscreen();
    }
  };

  const handleRestartGame = () => {
    if (!ready) return;
    stopAI();
    agentRef.current.reset();
    setSnapshot(null);
    const restarted = restartEmulatorGame();
    if (restarted) {
      onNotify('Jogo e energia reiniciados para o estado inicial.');
    } else {
      onNotify('Núcleo sem reinício rápido; recarregue o jogo para zerar a energia.');
    }
  };

  return (
    <section
      id="active-player"
      className="mt-8 overflow-hidden rounded-2xl border border-[#24314a] bg-[#111827] shadow-xl"
    >
      {/* Cabeçalho do Player */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#24314a] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-[#eef3fb]">{game.title}</h2>
          <p className="text-xs text-[#94a3bf]">
            {isGba ? 'Game Boy Advance' : 'Super Nintendo'} · {ready ? 'Núcleo ativo' : 'Carregando núcleo'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTouchPad((v) => !v)}
            className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold whitespace-nowrap transition-colors ${
              showTouchPad
                ? 'border-[#6ee7b7]/60 bg-[#6ee7b7]/15 text-[#6ee7b7]'
                : 'border-[#24314a] bg-[#172033] text-[#eef3fb] hover:border-[#3c5078]'
            }`}
          >
            <Gamepad2 className="h-4 w-4" />
            Controle Touch
          </button>

          <button
            type="button"
            onClick={handleFullscreenToggle}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#24314a] bg-[#172033] px-3 text-xs font-semibold text-[#eef3fb] whitespace-nowrap transition-colors hover:border-[#3c5078]"
          >
            <Maximize2 className="h-4 w-4" />
            Tela cheia
          </button>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#24314a] bg-[#172033] px-3 text-xs font-semibold text-[#eef3fb] whitespace-nowrap transition-colors hover:border-[#3c5078]"
          >
            <X className="h-4 w-4" />
            Fechar
          </button>
        </div>
      </div>

      {/* Palco 4:3 centralizado em paisagem limpa sem botões flutuantes em Tela Cheia */}
      <div className="flex justify-center bg-[#050811] p-2 sm:p-4">
        <div
          ref={screenWrapRef}
          onDoubleClick={() => {
            if (isFullscreen) void exitFullscreen();
          }}
          className={`relative flex items-center justify-center overflow-hidden bg-black ${
            isFullscreen || aiActive ? 'fs-clean-controls' : ''
          } ${
            isFullscreen
              ? 'h-screen w-screen'
              : 'aspect-[4/3] max-h-[58dvh] w-full max-w-[880px] rounded-lg sm:max-h-[70vh]'
          }`}
        >
          <div
            id="emulator-mount"
            ref={mountRef}
            className={
              isFullscreen
                ? isPortraitViewport
                  ? 'fs-landscape-rotated shrink-0'
                  : 'h-full w-full max-w-[133.33vh]'
                : ''
            }
          />
        </div>
      </div>

      {showTouchPad && !aiActive && !isFullscreen && <TouchControls />}

      {/* Barra de controles */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#24314a] px-4 py-2.5 text-xs text-[#94a3bf] sm:px-5">
        <span>{footMessage}</span>
        <span className="font-mono-data text-[11px]">{isGba ? 'GBA' : 'SNES'}</span>
      </div>

      {/* Save States + Botão Ativar IA em Tela Cheia */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#24314a] px-4 py-3.5 sm:px-5">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[#eef3fb]">
            <Save className="h-4 w-4 text-[#6ee7b7]" />
            Save States locais
          </div>
          <p className="mt-0.5 text-xs text-[#94a3bf]">
            Slot 1 {slots[0].savedAt ? 'salvo' : 'vazio'} · Slot 2 {slots[1].savedAt ? 'salvo' : 'vazio'} · neste navegador
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {([1, 2] as const).map((slot) => (
            <button
              key={`save-${slot}`}
              type="button"
              disabled={!ready}
              onClick={() => performSaveSlot(slot)}
              className="min-h-[40px] rounded-lg border border-[#24314a] bg-[#172033] px-3 text-xs font-semibold text-[#eef3fb] whitespace-nowrap transition-colors hover:border-[#3c5078] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Salvar {slot}
            </button>
          ))}
          {([1, 2] as const).map((slot) => (
            <button
              key={`load-${slot}`}
              type="button"
              disabled={!ready || !slots[slot - 1].savedAt}
              onClick={() => performLoadSlot(slot)}
              className="min-h-[40px] rounded-lg border border-[#24314a] bg-[#172033] px-3 text-xs font-semibold text-[#eef3fb] whitespace-nowrap transition-colors hover:border-[#3c5078] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Carregar {slot}
            </button>
          ))}
          <button
            type="button"
            disabled={!ready}
            onClick={() => (aiActive ? stopAI() : startAILoop(aiCautionApproved, true))}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-4 text-xs font-bold whitespace-nowrap transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
              aiActive
                ? 'bg-[#f59e0b] text-[#111827]'
                : 'bg-[#6ee7b7] text-[#07151a] hover:brightness-105'
            }`}
          >
            <Cpu className="h-4 w-4" />
            {aiActive ? 'Pausar IA' : 'Jogar com IA (Tela cheia)'}
          </button>
        </div>
      </div>

      {/* Confirmações inline */}
      {pendingOverwriteSlot !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#24314a] bg-[#172033] px-4 py-3 text-xs sm:px-5">
          <span className="text-[#eef3fb]">
            O Slot {pendingOverwriteSlot} já possui um save salvo. Deseja substituir?
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => performSaveSlot(pendingOverwriteSlot, true)}
              className="min-h-[36px] rounded-lg bg-[#6ee7b7] px-3 font-bold text-[#07151a]"
            >
              Confirmar
            </button>
            <button
              type="button"
              onClick={() => setPendingOverwriteSlot(null)}
              className="min-h-[36px] rounded-lg border border-[#24314a] bg-[#111827] px-3 font-semibold text-[#eef3fb]"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {aiPromptQuestion && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#24314a] bg-[#172033] px-4 py-3 text-xs sm:px-5">
          <span className="text-[#eef3fb]">{aiPromptQuestion}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setAiCautionApproved(true);
                startAILoop(true, true);
              }}
              className="min-h-[36px] rounded-lg bg-[#6ee7b7] px-3 font-bold text-[#07151a]"
            >
              Continuar mesmo assim
            </button>
            <button
              type="button"
              onClick={() => setAiPromptQuestion(null)}
              className="min-h-[36px] rounded-lg border border-[#24314a] bg-[#111827] px-3 font-semibold text-[#eef3fb]"
            >
              Manter pausada
            </button>
          </div>
        </div>
      )}

      {/* Painel de Telemetria Real & Habilidades da IA */}
      <div className="border-t border-[#24314a] bg-[#0c1322] px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3.5">
            <canvas
              ref={previewCanvasRef}
              width={96}
              height={64}
              aria-label="Quadro real analisado pela IA"
              className="h-16 w-24 shrink-0 rounded-lg border border-[#24314a] bg-black [image-rendering:pixelated]"
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                <span className="font-semibold text-[#eef3fb]">{aiStatusText}</span>
                <span className="text-[#94a3bf]">·</span>
                <span className="text-[#94a3bf]">
                  Estado: <strong className="text-[#eef3fb]">{aiSceneLabel}</strong>
                </span>
                <span className="text-[#94a3bf]">·</span>
                <span className="font-mono-data text-[#94a3bf]">
                  Ação: <strong className="text-[#6ee7b7]">{aiLastKeys}</strong>
                </span>
                <span className="text-[#94a3bf]">·</span>
                <span className="font-mono-data text-[#94a3bf]">{aiLatencyMs}</span>
              </div>
              <p className="text-xs text-[#94a3bf]">{aiReason}</p>

              {snapshot && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] text-[#94a3bf]">
                  <span>
                    Comportamento:{' '}
                    <strong className="text-[#6ee7b7]">{snapshot.behaviorLabel}</strong>
                  </span>
                  {snapshot.maxHealth ? (
                    <span className="font-mono-data text-[#eef3fb]">
                      Energia {snapshot.health}/{snapshot.maxHealth}
                      {snapshot.reserveMax ? ` · Reserva ${snapshot.reserveEnergy ?? 0}/${snapshot.reserveMax}` : ''}
                      {' · '}Mísseis {snapshot.missiles ?? 0} · Super {snapshot.supers ?? 0}
                    </span>
                  ) : null}
                  {snapshot.detectedEntityLabel && (
                    <span className="font-semibold text-[#fbbf24]">
                      · Alvo ativo: {snapshot.detectedEntityLabel}
                    </span>
                  )}
                  {snapshot.countdownActive && (
                    <span className="inline-flex items-center gap-1 font-mono-data font-semibold text-[#f87171]">
                      · <Timer className="h-3 w-3" />
                      {String(Math.floor((snapshot.countdownSeconds ?? 0) / 60)).padStart(2, '0')}:
                      {String((snapshot.countdownSeconds ?? 0) % 60).padStart(2, '0')}
                    </span>
                  )}
                  {typeof snapshot.ignoredBackgroundCount === 'number' && snapshot.ignoredBackgroundCount > 0 && (
                    <span className="font-mono-data text-[#94a3bf]">
                      · Cenário estático filtrado: {snapshot.ignoredBackgroundCount}
                    </span>
                  )}
                  {snapshot.pendingBacktracks > 0 && (
                    <span className="text-[#fbbf24]">
                      · {snapshot.pendingBacktracks} rota(s) aguardando habilidade
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <label className="flex flex-col gap-1 text-[#94a3bf]">
              <span>Motor de IA</span>
              <select
                value={aiEngine}
                onChange={(e) => handleEngineChange(e.target.value as AIEngine)}
                className="min-h-[40px] rounded-lg border border-[#24314a] bg-[#111827] px-2.5 text-xs font-medium text-[#eef3fb]"
              >
                <option value="local-vision">IA Local Integrada (Sem API · Celular e PC)</option>
                <option value="ollama">Ollama qwen2.5vl:3b (PC local)</option>
                <option value="gemini">Gemini 2.5 Flash (API opcional)</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[#94a3bf]">
              <span>Perfil do jogo</span>
              <select
                value={aiProfile}
                onChange={(e) => handleProfileChange(e.target.value as AIProfile)}
                className="min-h-[40px] rounded-lg border border-[#24314a] bg-[#111827] px-2.5 text-xs font-medium text-[#eef3fb]"
              >
                <option value="action">Ação / Metroid</option>
                <option value="rpg">RPG / Pokémon</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[#94a3bf]">
              <span>Dificuldade alvo</span>
              <select
                value={targetDiff}
                onChange={(e) => setTargetDiff(e.target.value)}
                className="min-h-[40px] rounded-lg border border-[#24314a] bg-[#111827] px-2.5 text-xs font-medium text-[#eef3fb]"
              >
                {DIFFICULTY_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => {
                agentRef.current.reset();
                setSnapshot(null);
                onNotify('Memória de rotas, filtros de cenário e IA reiniciados.');
              }}
              className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#24314a] bg-[#172033] px-3 font-semibold text-[#eef3fb] whitespace-nowrap hover:border-[#3c5078]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Resetar IA
            </button>

            <button
              type="button"
              disabled={!ready}
              onClick={handleRestartGame}
              className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#24314a] bg-[#172033] px-3 font-semibold text-[#eef3fb] whitespace-nowrap hover:border-[#3c5078] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Power className="h-3.5 w-3.5" />
              Resetar Energia / Jogo
            </button>
          </div>
        </div>

        {snapshot?.armorAnalysis && (
          <div className="mt-4 border-t border-[#24314a] pt-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#94a3bf]">
                <span className="inline-flex items-center gap-1.5 font-semibold text-[#eef3fb]">
                  <Shield className="h-3.5 w-3.5 text-[#6ee7b7]" />
                  Análise de Armadura e Peças
                </span>
                <span>·</span>
                <span>
                  Traje: <strong className="text-[#eef3fb]">{snapshot.armorAnalysis.suitTier}</strong>
                </span>
                <span>·</span>
                <span className="font-mono-data">
                  Redução: <strong className="text-[#6ee7b7]">{snapshot.armorAnalysis.damageReductionPct}%</strong>
                </span>
                <span>·</span>
                <span className="font-mono-data">
                  Energia efetiva: <strong className="text-[#eef3fb]">{snapshot.armorAnalysis.effectiveHp}</strong>
                </span>
                <span>·</span>
                <span className="font-mono-data">
                  Peças: <strong className="text-[#eef3fb]">{snapshot.armorAnalysis.collectedCount}/{snapshot.armorAnalysis.totalPieces}</strong>
                </span>
                <span>·</span>
                <span className="font-mono-data">
                  Prontidão SA-X: <strong className="text-[#6ee7b7]">{snapshot.armorAnalysis.saxReadinessPct}%</strong>
                </span>
              </div>

              <button
                type="button"
                onClick={() => setShowArmorDetails((v) => !v)}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-[#24314a] bg-[#111827] px-2.5 text-[11px] font-semibold text-[#eef3fb] whitespace-nowrap hover:border-[#3c5078]"
              >
                {showArmorDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {showArmorDetails ? 'Ocultar peças' : 'Analisar peças'}
              </button>
            </div>

            {showArmorDetails && (
              <div className="mt-3 space-y-2.5 text-[11px]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[#94a3bf]">
                  <span>
                    Proteção térmica:{' '}
                    <strong className={snapshot.armorAnalysis.thermalProtected ? 'text-[#6ee7b7]' : 'text-[#eef3fb]'}>
                      {snapshot.armorAnalysis.thermalProtected ? 'Ativa' : 'Sem proteção'}
                    </strong>
                  </span>
                  <span>
                    Mobilidade em líquidos:{' '}
                    <strong className={snapshot.armorAnalysis.liquidMobility ? 'text-[#6ee7b7]' : 'text-[#eef3fb]'}>
                      {snapshot.armorAnalysis.liquidMobility ? 'Ativa' : 'Restrita'}
                    </strong>
                  </span>
                  <span className="font-mono-data">
                    Tanques de Energia: <strong className="text-[#eef3fb]">{snapshot.armorAnalysis.energyTanks}</strong>
                  </span>
                  <span className="font-mono-data">
                    Reserva: <strong className="text-[#eef3fb]">{snapshot.armorAnalysis.reserveEnergy}/{snapshot.armorAnalysis.reserveMax}</strong> ({snapshot.armorAnalysis.reserveMode})
                  </span>
                  {snapshot.armorAnalysis.unequippedCollected.length > 0 && (
                    <span className="text-[#fbbf24]">
                      Desativadas no menu: {snapshot.armorAnalysis.unequippedCollected.join(', ')}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4 lg:grid-cols-4">
                  {snapshot.armorAnalysis.pieces.map((piece) => {
                    const statusLabel = piece.equipped
                      ? 'Equipada'
                      : piece.collected
                        ? 'Desativada'
                        : 'Faltando';
                    return (
                      <div
                        key={piece.id}
                        title={piece.note}
                        className="flex items-center justify-between gap-2 border-b border-[#24314a]/60 py-1"
                      >
                        <span className={`truncate ${piece.collected ? 'font-semibold text-[#eef3fb]' : 'text-[#94a3bf]'}`}>
                          {piece.name}
                        </span>
                        <span
                          className={`inline-flex shrink-0 items-center gap-1 font-mono-data text-[10px] ${
                            piece.equipped
                              ? 'text-[#6ee7b7]'
                              : piece.collected
                                ? 'text-[#fbbf24]'
                                : 'text-[#94a3bf]/70'
                          }`}
                        >
                          {piece.equipped && <Check className="h-3 w-3" />}
                          {statusLabel}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 border-t border-[#24314a] pt-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#eef3fb]">
              <Database className="h-3.5 w-3.5 text-[#6ee7b7]" />
              Banco de Conhecimento · Chefes e Poderes ({knowledgeLog.length})
            </span>
            {knowledgeLog.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  await clearAIKnowledge(game.file);
                  setKnowledgeLog([]);
                  onNotify('Banco de conhecimento da IA limpo para este jogo.');
                }}
                className="min-h-[32px] rounded-lg border border-[#24314a] bg-[#111827] px-2.5 text-[11px] font-semibold text-[#94a3bf] whitespace-nowrap hover:border-[#3c5078] hover:text-[#eef3fb]"
              >
                Limpar banco
              </button>
            )}
          </div>
          {knowledgeLog.length === 0 ? (
            <p className="mt-1.5 text-[11px] text-[#94a3bf]">
              Cada Core-X, habilidade ou peça de armadura coletada é identificada e salva aqui automaticamente no navegador.
            </p>
          ) : (
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {knowledgeLog.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-[#24314a] bg-[#111827] px-3 py-2 text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate text-[#6ee7b7]">{item.powerName}</strong>
                    <span className="font-mono-data shrink-0 text-[10px] text-[#94a3bf]">
                      {item.defeatedCount}x · 0x{item.roomId.toString(16).toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[#eef3fb]">{item.powerEffect}</p>
                  <p className="mt-0.5 truncate text-[10px] text-[#94a3bf]">Origem: {item.entityLabel}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {aiEngine === 'gemini' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#24314a] pt-3">
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="Cole sua chave API Gemini (opcional)"
              className="min-h-[40px] w-full max-w-xs rounded-lg border border-[#24314a] bg-[#111827] px-3 text-xs text-[#eef3fb]"
            />
            <button
              type="button"
              onClick={() => {
                localStorage.setItem(GEMINI_KEY_STORAGE, geminiKey.trim());
                onNotify('Chave salva neste navegador.');
              }}
              className="min-h-[40px] rounded-lg border border-[#24314a] bg-[#172033] px-3 text-xs font-semibold text-[#eef3fb]"
            >
              Salvar chave
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
