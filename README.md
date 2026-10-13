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
