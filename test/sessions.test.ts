import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { Sessions } from "../src/Sessions.js"
import { chunked, converterWith, partChunks, pdfSource } from "./fixtures.js"

const SessionsTest = Sessions.layer.pipe(
  Layer.provide(converterWith((request) => chunked(partChunks(request.part?.index ?? 1), 5)))
)

describe("Sessions", () => {
  it.live("streams a contiguous log to live viewers and replays from any seq", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const info = yield* sessions.create({ source: yield* pdfSource(2), title: "report" })

      const live = yield* Stream.runCollect(sessions.events(info.id, 0))
      assert.deepStrictEqual(live.map((event) => event.seq), live.map((_, index) => index + 1))
      assert.strictEqual(live.at(-1)?.type, "done")

      const replay = yield* Stream.runCollect(sessions.events(info.id, 3))
      assert.deepStrictEqual(replay.map((event) => event.seq), live.slice(3).map((event) => event.seq))

      const snapshot = yield* sessions.snapshot(info.id)
      assert.strictEqual(snapshot.status, "done")
      assert.strictEqual(snapshot.title, "report")
      assert.deepStrictEqual(snapshot.blocks.map((block) => block.id), ["page-1", "page-2"])
    }).pipe(Effect.provide(SessionsTest)))

  it.effect("reports unknown sessions", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const error = yield* sessions.snapshot("missing").pipe(Effect.flip)
      assert.strictEqual(error._tag, "SessionNotFound")
    }).pipe(Effect.provide(SessionsTest)))
})
