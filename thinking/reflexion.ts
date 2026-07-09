// thinking/reflexion.ts
import { messagesToText, stripThinkBlocks } from './dataTypes.js';

export function keyFor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 12)
    .join(' ');
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

export function findRelevant<T extends { key?: string }>(
  lessons: T[],
  input: string,
  k = 3,
  threshold = 0.18
): T[] {
  const k1 = keyFor(input);
  if (!k1) return [];
  const scored = lessons
    .map(l => ({ l, s: jaccard(k1, l.key || '') }))
    .filter(x => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  return scored.map(x => x.l);
}

type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;

export async function writeLesson(
  callChat: CallChat,
  input: unknown,
  failure: string,
  opts: Record<string, unknown>
): Promise<string> {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a reflexion agent. A previous attempt failed. Distill ONE general lesson that, ' +
          'if applied to similar future problems, would reduce the chance of the same failure. ' +
          'The lesson must be a single, terse, imperative sentence. No preamble.'
      },
      {
        role: 'user',
        content: `Problem: ${messagesToText(input).slice(0, 800)}\n\nFailure: ${failure}\n\nLesson:`
      }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

export interface Lesson {
  input?: string;
  lesson: string;
  key?: string;
  at?: number;
}

export interface ReflexionStore {
  list(): Lesson[];
  add(l: Lesson): Lesson;
  recall(input: string, k?: number): Lesson[];
  size(): number;
}

export function makeReflexionStore(initial: Lesson[] = []): ReflexionStore {
  const lessons: Lesson[] = [...initial];
  return {
    list() {
      return [...lessons];
    },
    add(l: Lesson) {
      const entry: Lesson = { ...l, key: l.key || keyFor(l.input || ''), at: Date.now() };
      lessons.push(entry);
      return entry;
    },
    recall(input: string, k = 3) {
      return findRelevant(lessons, input, k);
    },
    size() {
      return lessons.length;
    }
  };
}

export interface Reflexion {
  store: ReflexionStore;
  getHint(): Promise<string>;
  learn(failure: string): Promise<Lesson>;
}

export function attachReflexion(
  callChat: CallChat,
  input: unknown,
  opts: { lessons?: Lesson[]; memory?: ReflexionStore; topK?: number; [k: string]: unknown } = {}
): Reflexion {
  const store: ReflexionStore =
    opts.memory && typeof opts.memory.list === 'function'
      ? opts.memory
      : makeReflexionStore(opts.lessons || []);
  return {
    store,
    async getHint() {
      const relevant = store.recall(messagesToText(input), opts.topK || 3);
      if (!relevant.length) return '';
      return 'PAST LESSONS — apply these if relevant:\n' + relevant.map((l, i) => `${i + 1}. ${l.lesson}`).join('\n');
    },
    async learn(failure: string) {
      const lesson = await writeLesson(callChat, input, failure, opts);
      return store.add({ input: messagesToText(input), lesson, key: keyFor(messagesToText(input)) });
    }
  };
}
