import {
  Cause,
  Clock,
  Context,
  Effect,
  FiberSet,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schema,
  Semaphore,
  Stream
} from "effect"
import { type ConvertOptions, Converter, step } from "./Converter.js"
import { type DocumentInput, type DocumentState, initialState } from "./domain/Document.js"
import { CONTRACT_VERSION, isTerminal, type LiveEvent } from "./domain/Events.js"
import type { Source } from "./Source.js"

/**
 * Live sessions: each upload runs one conversion in the background and fans
 * its events out to any number of viewers, with replay from any `seq`.
 *
 * Live state is in memory. Provide a `SessionStore` to keep finished sessions
 * across restarts or evictions, and `NewSessionId` to control ids (a Durable
 * Object uses its own id).
 */

export interface SessionInfo {
  readonly id: string
  readonly title: string
  readonly mediaType: string
  readonly createdAt: number
}

export interface SessionSnapshot extends SessionInfo, DocumentState {}

export interface CreateSession {
  readonly source: Source
  readonly title: string
  /** Includes `credential`, which stays in memory for this conversion and is never stored. */
  readonly options?: Partial<ConvertOptions> | undefined
}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  id: Schema.String
}) {}

export interface SessionStoreService {
  /** Called once, when a session reaches `done` or `error`. */
  readonly save: (snapshot: SessionSnapshot) => Effect.Effect<void>
  readonly load: (id: string) => Effect.Effect<Option.Option<SessionSnapshot>>
}

/** Where finished sessions are kept. The default keeps nothing. */
export const SessionStore = Context.Reference<SessionStoreService>("parser-stream/SessionStore", {
  defaultValue: () => ({ save: () => Effect.void, load: () => Effect.succeed(Option.none()) })
})

/** How new session ids are made. Ids are capability URLs: keep them unguessable. */
export const NewSessionId = Context.Reference<() => string>("parser-stream/NewSessionId", {
  defaultValue: () => () => crypto.randomUUID()
})

interface Session {
  readonly info: SessionInfo
  state: DocumentState
  readonly log: Array<LiveEvent>
  readonly pubsub: PubSub.PubSub<LiveEvent>
  readonly lock: Semaphore.Semaphore
}

const MAX_SESSIONS = 50

const errorMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message
    ? error.message
    : "The conversion failed."
}

const snapshotOf = (session: Session): SessionSnapshot => ({ ...session.info, ...session.state })

/** A restored session replays as one append per block, then its terminal event. */
const restoredLog = (snapshot: SessionSnapshot): Array<LiveEvent> => {
  const log = snapshot.blocks.map((block, index): LiveEvent => ({
    version: CONTRACT_VERSION,
    seq: index + 1,
    type: "append",
    block_id: block.id,
    html: block.html
  }))
  const seq = log.length + 1
  log.push(
    snapshot.status === "done"
      ? { version: CONTRACT_VERSION, seq, type: "done" }
      : { version: CONTRACT_VERSION, seq, type: "error", message: "The conversion failed." }
  )
  return log
}

const make = Effect.gen(function*() {
  const converter = yield* Converter
  const store = yield* SessionStore
  const newId = yield* NewSessionId
  const fibers = yield* FiberSet.make()
  const sessions = new Map<string, Session>()

  const open = Effect.fn("Sessions.open")(function*(info: SessionInfo, state: DocumentState, log: Array<LiveEvent>) {
    const session: Session = {
      info,
      state,
      log,
      pubsub: yield* PubSub.unbounded<LiveEvent>(),
      lock: yield* Semaphore.make(1)
    }
    sessions.set(info.id, session)
    return session
  })

  // One lock per session: part fibers interleave, but the log must stay contiguous and in order.
  const commit = (session: Session, input: DocumentInput) =>
    Semaphore.withPermit(
      session.lock,
      Effect.gen(function*() {
        const transition = yield* step(session.state, input)
        if (!transition) return
        session.state = transition.state
        session.log.push(transition.event)
        yield* PubSub.publish(session.pubsub, transition.event)
      })
    )

  const evictFinished = () => {
    if (sessions.size < MAX_SESSIONS) return
    for (const [id, session] of sessions) {
      if (session.state.status !== "running") {
        sessions.delete(id)
        return
      }
    }
  }

  const create = Effect.fn("Sessions.create")(function*(input: CreateSession) {
    evictFinished()
    const session = yield* open(
      {
        id: newId(),
        title: input.title,
        mediaType: input.source.mediaType,
        createdAt: yield* Clock.currentTimeMillis
      },
      initialState,
      []
    )

    const run = converter.convert(input.source, input.options).pipe(
      Stream.runForEach((event) => commit(session, event)),
      Effect.andThen(commit(session, { type: "done" })),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Conversion failed", Cause.pretty(cause)).pipe(
            Effect.andThen(commit(session, { type: "error", message: errorMessage(cause) }))
          )
      ),
      Effect.ensuring(
        Effect.suspend(() => (session.state.status === "running" ? Effect.void : store.save(snapshotOf(session))))
      ),
      Effect.withSpan("Sessions.run", { attributes: { session: session.info.id } })
    )
    yield* FiberSet.run(fibers)(run)
    return session.info
  })

  const get = Effect.fn("Sessions.get")(function*(id: string) {
    const live = sessions.get(id)
    if (live) return live
    const stored = yield* store.load(id)
    if (Option.isNone(stored) || stored.value.status === "running") return yield* new SessionNotFound({ id })
    const { blocks, createdAt, mediaType, phase, status, title } = stored.value
    const log = restoredLog(stored.value)
    return yield* open({ id, title, mediaType, createdAt }, { seq: log.length, status, phase, blocks }, log)
  })

  const snapshot = (id: string): Effect.Effect<SessionSnapshot, SessionNotFound> => Effect.map(get(id), snapshotOf)

  const events = (id: string, after: number): Stream.Stream<LiveEvent, SessionNotFound> =>
    Stream.unwrap(Effect.gen(function*() {
      const session = yield* get(id)
      // Subscribe BEFORE reading the log: an event committed in between shows up in both, and `seq` dedupes it.
      const subscription = yield* PubSub.subscribe(session.pubsub)
      const replay = session.log.filter((event) => event.seq > after)
      if (session.state.status !== "running") return Stream.fromIterable(replay)
      const last = replay.at(-1)?.seq ?? after
      return Stream.fromIterable(replay).pipe(
        Stream.concat(
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.seq > last),
            Stream.takeUntil(isTerminal)
          )
        )
      )
    }))

  return Sessions.of({ create, snapshot, events })
})

export class Sessions extends Context.Service<Sessions, {
  readonly create: (input: CreateSession) => Effect.Effect<SessionInfo>
  readonly snapshot: (id: string) => Effect.Effect<SessionSnapshot, SessionNotFound>
  /** Events with `seq > after`, then live events until the terminal one. */
  readonly events: (id: string, after: number) => Stream.Stream<LiveEvent, SessionNotFound>
}>()("parser-stream/Sessions") {
  /** Requires `Converter`. Background conversions stop when the layer is released. */
  static readonly layer = Layer.effect(Sessions, make)
}
