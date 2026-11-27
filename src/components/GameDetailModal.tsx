import { X, Play } from 'lucide-react';
import type { GameItem } from '../types/emulator';

interface GameDetailModalProps {
  game: GameItem | null;
  onClose: () => void;
  onPlay: (game: GameItem) => void;
}

function getSystemLabel(file: string): string {
  return /\.gba$/i.test(file) ? 'Game Boy Advance' : 'Super Nintendo';
}

export function GameDetailModal({ game, onClose, onPlay }: GameDetailModalProps) {
  if (!game) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[#24314a] bg-[#111827] shadow-2xl">
        <div className="flex justify-end px-4 pt-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar detalhes"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-[#94a3bf] transition-colors hover:bg-[#172033] hover:text-[#eef3fb]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-6 px-6 pb-6 pt-1 md:grid-cols-[1fr_1.15fr] md:items-start">
          <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl border border-[#24314a] bg-[#090e1a]">
            {game.cover ? (
              <>
                <img
                  src={game.cover}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full scale-110 object-cover opacity-35 blur-lg"
                />
                <img
                  src={game.cover}
                  alt={`Capa de ${game.title}`}
                  referrerPolicy="no-referrer"
                  className="relative z-10 max-h-full max-w-full object-contain"
                />
              </>
            ) : (
              <span className="text-sm font-medium text-[#94a3bf]">ROM Local</span>
            )}
          </div>

          <div className="flex flex-col">
            <div className="text-xs font-semibold tracking-wide text-[#6ee7b7]">
              {getSystemLabel(game.file)}
            </div>
            <h2 id="detail-modal-title" className="mt-1.5 text-2xl font-bold tracking-tight text-[#eef3fb]">
              {game.title}
            </h2>
            <p className="mt-2.5 text-sm leading-relaxed text-[#94a3bf]">
              {game.description || 'Pronto para jogar no celular, notebook ou PC com saves locais e IA sem API.'}
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onPlay(game)}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#6ee7b7] px-5 py-2.5 text-sm font-bold text-[#07151a] transition-transform hover:brightness-105 active:scale-[0.98]"
              >
                <Play className="h-4 w-4 fill-current" />
                Jogar agora
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-[44px] items-center rounded-xl border border-[#24314a] bg-[#172033] px-4 py-2.5 text-sm font-semibold text-[#eef3fb] transition-colors hover:border-[#3c5078]"
              >
                Voltar à biblioteca
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
