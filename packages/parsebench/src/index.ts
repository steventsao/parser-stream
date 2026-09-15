/**
 * `@parser-stream/parsebench` — the ParseBench layout contract, with no
 * provider in it: the prompts, the `Schema`-typed `LayoutElement`, and the
 * renderer that decides the HTML tags.
 *
 * A plugin pairs this contract with a model: `@parser-stream/gemini` runs it on
 * Gemini Flash, and `@parser-stream/openai-compatible` runs it on a local vLLM
 * or Ollama server.
 */
export * from "./Contract.js"
