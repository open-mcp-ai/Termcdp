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

## 下载脚本并注入 —— 文件不进模型的 context

字节不必经过 agent：`fetch` 把 URL 拉进 **termcdp 自己的进程**，只回一张收据；正文留在内存里的 result store，按 id 引用。

```
invoke("fetch", "http://localhost:18765/api/sessions/<id>/files/download?path=%2Ftmp%2Fa.js")
  → {resultId: "fetch/7", bytes: 3145728, sha256: "…"}      ← context 里没有正文
invoke("lab1.S1.call", "Runtime.evaluate", {expression: "<该源码>"})
```

为什么下载发生在这一侧而不是页面里：页面自己 `fetch` + `eval`、以及 `<script src>` 标签，都会被页面的 CSP（`connect-src` / `script-src`）拦下，跨域 fetch 还需要 CORS 头 —— termcp 不发这些头。在 termcdp 进程里下载、把源码当表达式注入，在严格 CSP 页面上也能用，且不需要 CORS。

这条链路和 **Termcp** 的 `GET /api/sessions/{id}/files/download` 配套：termcp 能读出会话能碰到的任何文件（远端主机，或 termcp 本机），termcdp 拉进来再注入。`file:` 和 `data:` 会被拒 —— `fetch` 跑在主机上而不是页面里，否则它就成了“读本机任意文件”。两段都不落盘：store 在内存里，随进程退出消失。
