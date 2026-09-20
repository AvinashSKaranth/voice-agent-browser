import type { AppEvent } from './types';

type Handler<T extends AppEvent['type']> = (e: Extract<AppEvent, { type: T }>) => void;
const handlers = new Map<string, Set<(e: AppEvent) => void>>();

export const bus = {
  on<T extends AppEvent['type']>(type: T, fn: Handler<T>): () => void {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    const h = fn as unknown as (e: AppEvent) => void;
    set.add(h);
    return () => {
      set!.delete(h);
    };
  },
  emit(e: AppEvent) {
    handlers.get(e.type)?.forEach((fn) => {
      try {
        fn(e);
      } catch (err) {
        console.error('bus handler', e.type, err);
      }
    });
  },
};
