/**
 * The application layer: one way to run the core as a web app.
 *
 * `Sessions` keeps a live conversion and fans its events out. `Routes` serves
 * the upload page, the redirect, the document page, and the event stream. `Ui`
 * renders the plain pages. None of it is required: build your own app on
 * `parser-stream` (the core) instead, or take these as a starting point.
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
