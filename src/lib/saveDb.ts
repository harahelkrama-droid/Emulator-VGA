import type { EncounterKnowledgeRecord, SaveSlotSummary } from '../types/emulator';

const DB_NAME = 'RetroPlaySaves';
const DB_VERSION = 2;
const STORE_NAME = 'states';
const KNOWLEDGE_STORE = 'ai_knowledge';

interface StoredStateRecord {
  id: string;
  game: string;
  slot: 1 | 2;
  state: Uint8Array;
  updated: number;
}

function openSaveDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!req.result.objectStoreNames.contains(KNOWLEDGE_STORE)) {
        req.result.createObjectStore(KNOWLEDGE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponível.'));
  });
}

function makeSlotId(gameKey: string, slot: 1 | 2): string {
  return `${gameKey}::slot-${slot}`;
}

export async function readSaveSlot(gameKey: string, slot: 1 | 2): Promise<StoredStateRecord | null> {
  const db = await openSaveDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(makeSlotId(gameKey, slot));
    req.onsuccess = () => resolve((req.result as StoredStateRecord | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Falha ao ler slot.'));
  });
}

export async function getSaveSummary(gameKey: string): Promise<[SaveSlotSummary, SaveSlotSummary]> {
  const [s1, s2] = await Promise.all([readSaveSlot(gameKey, 1), readSaveSlot(gameKey, 2)]);
  return [
    { slot: 1, savedAt: s1?.updated ?? null, byteLength: s1?.state?.byteLength ?? 0 },
    { slot: 2, savedAt: s2?.updated ?? null, byteLength: s2?.state?.byteLength ?? 0 },
  ];
}

export async function writeSaveSlot(gameKey: string, slot: 1 | 2, bytes: Uint8Array): Promise<void> {
  const db = await openSaveDB();
  const payload: StoredStateRecord = {
    id: makeSlotId(gameKey, slot),
    game: gameKey,
    slot,
    state: bytes.slice(),
    updated: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Falha ao gravar save state.'));
  });
}

export async function readAIKnowledge(gameKey: string): Promise<EncounterKnowledgeRecord[]> {
  try {
    const db = await openSaveDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(KNOWLEDGE_STORE, 'readonly');
      const req = tx.objectStore(KNOWLEDGE_STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result as EncounterKnowledgeRecord[] | undefined) ?? [];
        resolve(
          rows
            .filter((r) => r.game === gameKey)
            .sort((a, b) => b.observedAt - a.observedAt),
        );
      };
      req.onerror = () => reject(req.error ?? new Error('Falha ao ler banco da IA.'));
    });
  } catch {
    return [];
  }
}

export async function upsertAIKnowledge(
  gameKey: string,
  entry: Omit<EncounterKnowledgeRecord, 'id' | 'game' | 'defeatedCount' | 'observedAt'>,
): Promise<EncounterKnowledgeRecord[]> {
  const db = await openSaveDB();
  const id = `${gameKey}::power::${entry.powerId}`;
  const existing = await new Promise<EncounterKnowledgeRecord | null>((resolve) => {
    const tx = db.transaction(KNOWLEDGE_STORE, 'readonly');
    const req = tx.objectStore(KNOWLEDGE_STORE).get(id);
    req.onsuccess = () => resolve((req.result as EncounterKnowledgeRecord | undefined) ?? null);
    req.onerror = () => resolve(null);
  });

  const keepCoreOrigin = existing && existing.entityType.startsWith('CORE_X') && entry.entityType === 'NONE';
  const payload: EncounterKnowledgeRecord = {
    id,
    game: gameKey,
    entityType: keepCoreOrigin ? existing.entityType : entry.entityType,
    entityLabel: keepCoreOrigin ? existing.entityLabel : entry.entityLabel,
    powerId: entry.powerId,
    powerName: entry.powerName,
    powerEffect: entry.powerEffect,
    roomId: entry.roomId,
    defeatedCount: (existing?.defeatedCount ?? 0) + 1,
    observedAt: Date.now(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KNOWLEDGE_STORE, 'readwrite');
    tx.objectStore(KNOWLEDGE_STORE).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Falha ao salvar conhecimento da IA.'));
  });

  return readAIKnowledge(gameKey);
}

export async function clearAIKnowledge(gameKey: string): Promise<void> {
  const rows = await readAIKnowledge(gameKey);
  if (rows.length === 0) return;
  const db = await openSaveDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KNOWLEDGE_STORE, 'readwrite');
    const store = tx.objectStore(KNOWLEDGE_STORE);
    for (const r of rows) {
      store.delete(r.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Falha ao limpar banco da IA.'));
  });
}
