import { Effect, Layer, Option } from "effect"
import { type SessionSnapshot, SessionStore } from "../Sessions.js"

/** The part of Durable Object storage this adapter uses. */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

const KEY = "snapshot"

/**
 * Keep a finished session in its Durable Object's storage (one session per
 * object), so the page still loads after the object is evicted. A snapshot
 * larger than the storage value limit is not kept.
 */
export const layer = (storage: KeyValueStorage) =>
  Layer.succeed(SessionStore)({
    save: (snapshot) =>
      Effect.tryPromise(() => storage.put(KEY, snapshot)).pipe(
        Effect.catchCause((cause) => Effect.logWarning("The session snapshot was not persisted", cause))
      ),
    load: (id) =>
      Effect.tryPromise(() => storage.get<SessionSnapshot>(KEY)).pipe(
        Effect.map((snapshot) => (snapshot && snapshot.id === id ? Option.some(snapshot) : Option.none())),
        Effect.orElseSucceed(() => Option.none())
      )
  })
