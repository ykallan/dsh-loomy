# dsh-loomy 开发约定

面向在本仓库里改代码的 agent / 人。用户文档见 `README.md`，上游协议事实见
`docs/PROTOCOL.md`。

## 常用命令

```bash
pnpm typecheck     # 宿主侧 tsc + 浏览器侧 tsc（两套 tsconfig，别只跑一个）
pnpm test          # vitest：纯函数 + 本地假上游，不打真实接口
pnpm build         # tsdown（宿主 ESM + 客户端 CJS），再 wrap-client 包成自注册 bundle
pnpm deploy        # 把 lib/ 装进 profile 的 vendor/ 与 node_modules/（依赖记成 file:）
node scripts/smoke-apply.mjs   # 离线跑一遍 apply()：路由 / provider 注册 / 门禁，不打上游
```

本机没有全局 `pnpm` 时，用宿主自带的 node + pnpm：

```bash
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install
```

**改了宿主侧代码必须重启 DSH 才生效。** 客户端产物由 `dsh-client-hmr` 自动送进浏览器，
宿主模块不会热载；部署脚本只覆盖内容不同的文件，所以「重启后行为没变」通常是没重新 build。

## 分层：谁负责什么

```
src/config.ts       上游常量（两个主机/路径/签名键/会话寿命/超时）—— 唯一的字面量出处
src/signer.ts       账号服务签名：九行 stringToSign + HMAC-SHA1 + 请求头
src/rsa.ts          密码的 RSA/PKCS#1 v1.5 加密（DER 可能是 SPKI 也可能是 PKCS#1）
src/login.ts        账号服务客户端：密码登录 / 短信登录 / userinfo / 设备标识
src/accounts.ts     账号文档；单账号会话解析（单飞 + 代际 + 冷却 + 自动重登）
src/catalog.ts      模型目录的数据结构、合并、勾选过滤
src/discovery.ts    GET /models 的抓取与解析（多账号并集）；探活
src/points.ts       GET /points/records → 余额/每日赠送；「额度用尽」标记
src/account-pool.ts 谁现在能接活（点数/轮转/LRU + 槽位/冷却/暂停/置顶）
src/queue.ts        全局并发闸门（1 在飞 + 最多 3 排队 + 入场冷却）
src/upstream.ts     模型网关这一层：请求头（traceparent 是硬要求）/ 错误归类 / 用量抽取
src/shim.ts         回环 HTTP 服务：选号、换号重试、流式透传、记账
src/adapter.ts      pi-ai provider（模型描述 + 指向 shim + 思考档位映射）
src/usage.ts        本机用量账本（tokens + 实际扣的点数）
src/web-status.ts   同源路由（只服务 loopback，不吐凭证）
src/index.ts        组装：Config、定时器、provider 注册、路由挂载
src/client/*        浏览器侧：卡片、底部状态行、侧边栏页
```

## 硬约定

- **纯 ESM + 源码里相对导入带 `.ts` 后缀**（`import { x } from './config.ts'`）。tsdown 负责打包。
- **客户端不能 import 宿主模块的运行时值**。类型可以（`import type`），纯常量请自己抄一份
  —— 一旦运行时 import 到 `web-status.ts`，`node:http` / `pi-ai` 就会被拖进浏览器包。
- **每个 `(kind, path)` 只能 `ctx.webServer.register` 一次**。同一路径的 POST 和 DELETE
  必须共用一个 handler，否则第二次注册会抛 duplicate route，把同一次 effect 后面的注册全跳过。
- **所有路由都要过 loopback 检查**（`hostIsLoopback` + `originIsLoopback`），写操作还要
  `content-type: application/json`。
- **凭证不进浏览器**：状态文档里只允许打码手机号、到期时间、点数、勾选状态。
  `session` 与 `password` 只留在宿主进程和 `0600` 的文档里。
- **新增 CSS 类名先 `pnpm build`（生成 `.module.css.d.ts`）再 typecheck**。
- **未知模型 id 必须拦下来**：上游对不认识的 id 会静默回退到默认模型，放过去等于骗用户。
- **`traceparent` 不能省**：缺了它上游会挂到超时，而报错是「超时」不是「缺头」。
- **会话续期必须单飞并带代际**：同一账号并发重登会互相覆盖，把好端端的号写成待登录。
- **额度用尽与「服务过载」不是一回事**：只有 `402` / 点数文案才记成额度用尽并冷却；
  `5xx` 只做短时退避。响应码也要如实传：一个 402 不能被换成一个笼统的 429。
- **不要编造每日赠送的重置时刻**：上游没有公开，卡片只显示数值。

## 测试口味

- 只测纯函数、本地状态机与「假上游 + 真 shim」的端到端；需要网络的测试用
  `globalThis.fetch` 打桩或起一个本地假 HTTP 服务，并在 `finally`/`afterEach` 里还原。
- 每个 spec 自己建临时目录（`mkdtempSync`），`afterEach` 删掉，不碰用户真实数据。
- `test/shim.spec.ts` 是唯一「跑真 HTTP」的用例：它用本地假上游验证请求头、流式透传、
  用量记账与额度冷却。改转发逻辑必须让它继续通过。

## 发布

用户没明确说「推 github / 发版」时，只到 `typecheck` → `test` → `build` → `deploy` 为止。
不要自行 `git push`、打 tag、建 Release 或 `npm publish`。
