#!/usr/bin/env node
import { ServerConfig } from "@parser-stream/app/Routes"
import { layerServer } from "@parser-stream/node/Server"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { basename, extname } from "node:path"
import { Converter, toDocument } from "parser-stream/Converter"
import { renderHtmlDocument } from "parser-stream/domain/Document"
import { mediaTypeFromPath } from "parser-stream/Source"
import { ConfigurationError, ConverterLive, SessionsLive } from "./App.js"

try {
  process.loadEnvFile()
} catch {
  // no .env in the working directory
}

const parserKind = () => process.env["PARSER"] ?? "gemini-parsebench"
const needsGeminiKey = () => parserKind().startsWith("gemini")
/** True when the host can convert without the caller sending a key. */
const hostHasCredential = () => !needsGeminiKey() || Boolean(process.env["GEMINI_API_KEY"])

const mode = Flag.Literals("mode", ["auto", "whole", "split"]).pipe(
  Flag.withDescription("auto: split when the source has several parts. whole: one request. split: one request per part."),
  Flag.withDefault("auto")
)

const concurrency = Flag.Int("concurrency").pipe(
  Flag.withDescription("Parts converted at the same time in split mode"),
  Flag.withDefault(4)
)

const serve = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(Flag.withAlias("p"), Flag.withDefault(3000)),
    host: Flag.String("host").pipe(
      Flag.withDescription("Bind address. Anything other than loopback lets the network use this server."),
      Flag.withDefault("127.0.0.1")
    )
  },
  Effect.fn(function*({ host, port }) {
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1"
    if (!loopback) yield* Console.error(`Warning: listening on ${host}. Anyone who can reach it can use this server.`)
    const config = ServerConfig.layer({
      ...(loopback ? {} : { allowedHosts: "any" as const }),
      keyField: hostHasCredential() ? "hidden" : "required"
    })
    return yield* Layer.launch(layerServer({ port, host }).pipe(Layer.provide([SessionsLive, config])))
  })
).pipe(Command.withDescription("Start the demo app: upload page, document pages, and the event stream"))

const convert = Command.make(
  "convert",
  {
    file: Argument.String("file").pipe(Argument.withDescription("Path to a PDF, image, or other file your plugin reads")),
    out: Flag.String("out").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("Write the HTML file here instead of stdout"),
      Flag.optional
    ),
    mediaType: Flag.String("media-type").pipe(
      Flag.withDescription("Override the media type guessed from the file extension"),
      Flag.optional
    ),
    mode,
    concurrency
  },
  Effect.fn(function*({ concurrency, file, mediaType, mode, out }) {
    const type = Option.getOrUndefined(mediaType) ?? mediaTypeFromPath(file)
    if (!type) {
      return yield* new ConfigurationError({ message: `Unknown media type for ${file}. Pass --media-type.` })
    }
    if (!hostHasCredential()) {
      return yield* new ConfigurationError({
        message: "Set GEMINI_API_KEY (https://aistudio.google.com/apikey), or pick another plugin with PARSER."
      })
    }
    const fs = yield* FileSystem.FileSystem
    const bytes = yield* fs.readFile(file)
    const title = basename(file, extname(file))
    const state = yield* Effect.gen(function*() {
      const converter = yield* Converter
      return yield* toDocument(
        converter.convert({ bytes, mediaType: type, name: title }, { mode, concurrency }).pipe(
          Stream.tap((event) => event.type === "progress" ? Console.error(event.phase) : Effect.void)
        )
      )
    }).pipe(Effect.provide(ConverterLive))
    const html = renderHtmlDocument({ title, blocks: state.blocks })
    if (Option.isSome(out)) {
      yield* fs.writeFileString(out.value, html)
      yield* Console.error(`Wrote ${out.value}`)
    } else {
      yield* Console.log(html)
    }
  })
).pipe(Command.withDescription("Convert one file to a standalone HTML file"))

Command.make("parser-stream").pipe(
  Command.withDescription("Stream documents into clean, sanitized HTML with your own key or your own plugin"),
  Command.withSubcommands([serve, convert]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
