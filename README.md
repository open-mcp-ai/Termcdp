# termcdp

[English](README.md) ｜ **[中文](README.zh-CN.md)**

> **Many browsers at once — local or remote.**

A zero-dependency Chrome DevTools Protocol console: cross-machine SOCKS5 transport, multi-instance aggregation, an MCP interface. Browsers and Node's V8 inspector alike.

## Run

```bash
npx -y @open-mcp-ai/termcdp
```

Zero runtime dependencies (`node:` builtins only). Node ≥ 22.

## Use it

Register it with any MCP client, or let the model configure it itself:

```json
{ "mcpServers": { "termcdp": { "command": "npx", "args": ["-y", "@open-mcp-ai/termcdp", "mcp"] } } }
```

The model opens a browser with debugging on, then connects to it automatically.

## Remote browsers

- A browser's debugging port usually accepts connections from localhost (127.0.0.1) only.
- Adding [**Termcp**](https://github.com/open-mcp-ai/Termcp) (an MCP server) to the agent is recommended. Once the SSH host is configured in the [**Termcp**](https://github.com/open-mcp-ai/Termcp) WebUI, the AI can set up an SSH-based tunnel through [**Termcp**](https://github.com/open-mcp-ai/Termcp) on its own.
- The AI also starts the browser on the remote machine through [**Termcp**](https://github.com/open-mcp-ai/Termcp), using the dynamic port forwarding the SSH tunnel provides (ssh -D, SOCKS5).
- Termcdp then connects to the remote machine's browser debugging port through that dynamic port forwarding.

## Download a script, inject it — without it entering the model's context

The agent never has to carry the bytes. `fetch` pulls a URL **into termcdp's own process** and hands back a receipt; the body stays in the in-memory result store and is referenced by id.

```
invoke("fetch", "http://localhost:18765/api/sessions/<id>/files/download?path=%2Ftmp%2Fa.js")
  → {resultId: "fetch/7", bytes: 3145728, sha256: "…"}      ← no body in context
invoke("lab1.S1.call", "Runtime.evaluate", {expression: "<that source>"})
```

Why the download happens here and not in the page: a page-side `fetch` + `eval`, and a `<script src>` tag, are both blocked by the page's Content-Security-Policy (`connect-src` / `script-src`), and a cross-origin fetch also needs CORS headers — termcp sends none. Fetching in termcdp's process, then injecting the source as an expression, works on a strict-CSP page and needs neither.

This pairs with **Termcp**'s `GET /api/sessions/{id}/files/download`: termcp serves any file the session can reach (remote host, or the termcp host itself), termcdp pulls it in and injects it. `file:` and `data:` URLs are refused — `fetch` runs on the host, not in the page, and would otherwise read any local file. Nothing is written to disk on either hop: the store is in memory and dies with the process.
