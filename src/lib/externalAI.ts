import type { AIAction, AIKey, AIPhase, AIProfile } from '../types/emulator';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL = 'qwen2.5vl:3b';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const VALID_KEYS: AIKey[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT', 'NONE'];

const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    k: { type: 'STRING', enum: VALID_KEYS },
    t: { type: 'INTEGER' },
    p: { type: 'STRING', enum: ['menu', 'run', 'win', 'missing', 'unsure'] },
    q: { type: 'STRING' },
  },
  required: ['k', 't', 'p'],
};

function buildPrompt(profile: AIProfile, difficulty: string, approvedCaution: boolean): string {
  const profileGuide =
    profile === 'rpg'
      ? 'Perfil RPG/Pokémon: avance diálogo com o botão A (tecla Z); navegue opções com as setas.'
      : 'Perfil Ação/Metroid: controle Samus com setas=direção, A=Z, B=X (pulo), X=A, Y=S (tiro), L=Q, R=E.';
  const caution = approvedCaution
    ? 'Continue com cautela escolhendo a ação mais segura.'
    : 'Se estiver em dúvida do menu/vitória, marque p=unsure.';

  return (
    `Observe este jogo GBA/SNES. ${profileGuide} Nível alvo: ${difficulty}. ` +
    `Em menus de dificuldade em inglês, Super=Super Fácil, Easy=Fácil, Normal=Normal, Hard=Difícil. ` +
    `${caution} Responda apenas JSON curto: {"k":"RIGHT","t":250,"p":"run"}. t=100..500 ms.`
  );
}

function parseAction(rawText: string): AIAction {
  const match = String(rawText || '').match(/\{[^{}]*\}/);
  if (!match) throw new Error('Resposta inválida da IA externa.');
  const parsed = JSON.parse(match[0]) as { k?: string; t?: number; p?: string; q?: string };
  const key = String(parsed.k || 'NONE').toUpperCase() as AIKey;
  if (!VALID_KEYS.includes(key)) throw new Error(`Tecla inválida: ${key}`);
  const phase = (['menu', 'run', 'win', 'missing', 'unsure'].includes(String(parsed.p))
    ? parsed.p
    : 'unsure') as AIPhase;
  return {
    key,
    time: Math.max(100, Math.min(500, Number(parsed.t) || 220)),
    phase,
    question: parsed.q ? String(parsed.q).slice(0, 180) : undefined,
    sceneLabel: phase === 'menu' ? 'Menu (IA Externa)' : 'Jogando (IA Externa)',
  };
}

export async function askOllama(
  base64Jpeg: string,
  profile: AIProfile,
  difficulty: string,
  approvedCaution: boolean,
  signal: AbortSignal,
): Promise<AIAction> {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    mode: 'cors',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      keep_alive: '10m',
      options: { num_predict: 45, temperature: 0.2, num_ctx: 2048, num_batch: 128, num_thread: 4 },
      messages: [{ role: 'user', content: buildPrompt(profile, difficulty, approvedCaution), images: [base64Jpeg] }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.error || data.error || `Ollama HTTP ${res.status}`);
  return parseAction(data.message?.content || '');
}

export async function askGemini(
  apiKey: string,
  base64Jpeg: string,
  profile: AIProfile,
  difficulty: string,
  approvedCaution: boolean,
  signal: AbortSignal,
): Promise<AIAction> {
  if (!apiKey.trim()) throw new Error('Informe sua chave Gemini para usar o motor em nuvem.');
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildPrompt(profile, difficulty, approvedCaution) },
            { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 45,
        responseMimeType: 'application/json',
        responseSchema: AI_SCHEMA,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
  const text = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
  return parseAction(text);
}
