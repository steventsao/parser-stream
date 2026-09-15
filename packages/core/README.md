# parser-stream

The core: the `HtmlStream` port and the streaming DOM engine.

It cuts a plugin's HTML stream into complete blocks, sanitizes each one, numbers them, and reduces them to a document. It has no HTTP, no sessions, and no transport.

Part of [parser-stream](https://github.com/steventsao/parser-stream): stream a document into clean, sanitized, semantic HTML, block by block, with your own key or your own plugin. See the repository for the design and for how to write a plugin.

## License

MIT
