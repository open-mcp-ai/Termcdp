# termcdp

**中文** ｜ [English](README.md)

> **同时控制多个浏览器——本地或远端。**

零依赖的 Chrome DevTools Protocol 控制台：跨机 SOCKS5 传输 + 多实例聚合 + MCP 接口。浏览器和 Node 的 V8 inspector 都能驱动。

## 运行

```bash
npx -y @open-mcp-ai/termcdp
```

零运行时依赖（只用 `node:` 内置）。Node ≥ 22。

## 用起来

注册到任意 MCP 客户端，或者让AI自己配置：

```json
{ "mcpServers": { "termcdp": { "command": "npx", "args": ["-y", "@open-mcp-ai/termcdp", "mcp"] } } }
```

AI将打开调试模式的浏览器，然后自动连上去。

## 远端浏览器控制

- 浏览器调试端口通常只允许本机（127.0.0.1）访问。
- 推荐给 Agent 添加 [**Termcp**](https://github.com/open-mcp-ai/Termcp)（一个 MCP），在 [**Termcp**](https://github.com/open-mcp-ai/Termcp) 的 WebUI 里配置好 SSH host 后，AI 能自动基于 [**Termcp**](https://github.com/open-mcp-ai/Termcp) 建立基于 SSH 的隧道。
- AI 也会通过 [**Termcp**](https://github.com/open-mcp-ai/Termcp) 自动开启远程机器上的浏览器，且使用 SSH 隧道提供的动态端口转发（ssh -D，SOCKS5 协议）。
- Termcdp 使用动态端口转发连接上远端的浏览器调试端口。
