/**
 * SSE event emitter for real-time UI updates.
 * Emits typed events when routes, sessions, injectors, or permissions change.
 */

export type SseEventType =
  | 'routes:changed'
  | 'sessions:changed'
  | 'injectors:changed'
  | 'permissions:changed';

export interface SseEvent {
  type: SseEventType;
  timestamp: number;
}

const listeners: Set<(event: SseEvent) => void> = new Set();

export function emit(eventType: SseEventType): void {
  const event: SseEvent = { type: eventType, timestamp: Date.now() };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error('SSE listener error:', err);
    }
  }
}

export function subscribe(fn: (event: SseEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
