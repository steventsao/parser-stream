import { Cause, Clock, Context, Effect, FiberSet, Layer, Predicate, PubSub, Schema, Semaphore, Stream } from "effect"
import { type ConvertOptions, Converter, step } from "./Converter.js"
import { type DocumentInput, type DocumentState, initialState } from "./domain/Document.js"
import { isTerminal, type LiveEvent } from "./domain/Events.js"
import type { Source } from "./Source.js"

/**
 * In-memory live sessions: each upload runs one conversion in the background
 * and fans its events out to any number of viewers, with replay from any `seq`.
 * Swap this layer for a durable one (Redis, a database, a Durable Object) when
 * sessions must survive a restart.
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
  readonly options?: Partial<ConvertOptions> | undefined
}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  id: Schema.String
}) {}

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

const make = Effect.gen(function*() {
  const converter = yield* Converter
  const fibers = yield* FiberSet.make()
  const sessions = new Map<string, Session>()

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
    const session: Session = {
      info: {
        id: crypto.randomUUID(),
        title: input.title,
        mediaType: input.source.mediaType,
        createdAt: yield* Clock.currentTimeMillis
      },
      state: initialState,
      log: [],
      pubsub: yield* PubSub.unbounded<LiveEvent>(),
      lock: yield* Semaphore.make(1)
    }
    sessions.set(session.info.id, session)

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
      Effect.withSpan("Sessions.run", { attributes: { session: session.info.id } })
    )
    yield* FiberSet.run(fibers)(run)
    return session.info
  })

  const get = (id: string) =>
    Effect.suspend(() => {
      const session = sessions.get(id)
      return session ? Effect.succeed(session) : Effect.fail(new SessionNotFound({ id }))
    })

  const snapshot = (id: string): Effect.Effect<SessionSnapshot, SessionNotFound> =>
    Effect.map(get(id), (session) => ({ ...session.info, ...session.state }))

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
