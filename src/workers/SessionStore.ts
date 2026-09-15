import { Clock, Effect, Layer, Option } from "effect"
import { type SessionSnapshot, SessionStore } from "../Sessions.js"

/** The part of Durable Object storage this adapter uses. */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  setAlarm(scheduledTime: number): Promise<void>
}

export interface DurableSessionStoreOptions {
  /** Schedule the object's alarm this long after a session finishes. Delete its storage in `alarm()`. */
  readonly retentionMs?: number | undefined
}

const KEY = "snapshot"

/**
 * Keep a finished session in its Durable Object's storage (one session per
 * object), so the page still loads after the object is evicted. A snapshot
 * larger than the storage value limit is not kept.
 */
export const layer = (storage: KeyValueStorage, options: DurableSessionStoreOptions = {}) =>
  Layer.succeed(SessionStore)({
    save: (snapshot) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.tryPromise(async () => {
          await storage.put(KEY, snapshot)
          if (options.retentionMs) await storage.setAlarm(now + options.retentionMs)
        })).pipe(Effect.catchCause((cause) => Effect.logWarning("The session snapshot was not persisted", cause))),
    load: (id) =>
      Effect.tryPromise(() => storage.get<SessionSnapshot>(KEY)).pipe(
        Effect.map((snapshot) => (snapshot && snapshot.id === id ? Option.some(snapshot) : Option.none())),
        Effect.orElseSucceed(() => Option.none())
      )
  })
