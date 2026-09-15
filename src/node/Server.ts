import { NodeHttpServer } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { Routes } from "../http/Routes.js"

/** A Node HTTP server for every route. Requires `Sessions`. */
export const layerServer = (options: { readonly port: number; readonly host: string }) =>
  HttpRouter.serve(Routes, { disableLogger: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: options.port, host: options.host }))
  )
