/**
 * `@parser-stream/app` — one app over the core: live sessions plus an HTTP and
 * Server-Sent Events transport.
 *
 * `Sessions` keeps a running conversion and fans its events out. `Routes`
 * serves the upload page, the redirect, the document page, and the event
 * stream. `Ui` renders the plain pages. None of it is required: the core emits
 * the same events for any transport.
 */
export { PageRoutes, Routes, ServerConfig, type ServerOptions, SessionRoutes } from "./Routes.js"
export {
  type CreateSession,
  NewSessionId,
  type SessionInfo,
  SessionNotFound,
  Sessions,
  type SessionSnapshot,
  SessionStore,
  type SessionStoreService
} from "./Sessions.js"
export * as Ui from "./Ui.js"
