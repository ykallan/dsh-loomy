# dsh-loomy

把 **Loomy（讯飞桌面助手）** 的模型额度接入 DeepSeek Harness 的插件。

手机号+密码在**服务端**登录一次，就能在 DSH 的对话窗口里用 Loomy 模型网关的模型
（`spark-x` / `GLM-5.3-Flash` / `qwen3.8-flash` / `deepseek-v4-flash-0731` / `Kimi-k2.6` …），
支持**多账号池**、**额度感知选号**、**动态模型目录**、**本机点数账本**，并能在设置里管理一切。

> 这不是官方插件，也不是讯飞的产品。它只是把 Loomy 桌面客户端已经在用的接口
> （账号服务 + 模型网关）接到 DSH 的模型层上。上游随时可能改接口或收紧额度，届时插件会跟着失效。

---

## 功能

| 功能 | 说明 |
|---|---|
| **服务端登录** | 手机号 + 密码换 14 天会话；密码用上游下发的 RSA 公钥加密后才发出去，本机以 `0600` 保存，用来自动续期 |
| **短信登录** | 没设密码的账号可以走 `sendMsgCode` → `checkCode`，代价是会话到期后要重新收验证码 |
| **粘贴会话** | 也可以直接粘一个 `loomy_web_session`（只用于临时跑起来，14 天后失效） |
| **多账号池** | 每个账号独立会话与设备标识；卡片上可暂停、置顶、改备注、补密码、重新登录、删除；请求失败自动换号 |
| **额度感知选号** | 上游 `/points/records` 有真账本，所以默认策略是「点数最多优先」，另有 `round_robin` / `lru` |
| **动态模型目录** | 启动时与每小时从上游 `GET /models` 拉一次，按账号取并集；可勾选只暴露部分模型 |
| **点数显示** | 卡片显示每个号的 `可用 = 永久余额 + 每日赠送`（**不编造重置倒计时**：上游没公开） |
| **本机用量账本** | 记录经本插件发出的请求数、tokens 与**实际扣的点数**（`usage.points_consumed`） |
| **请求校验** | 上游对不认识的模型 id 会静默回退到默认模型，所以插件先按目录校验，未知 id 直接 400 |
| **并发与排队** | 默认 1 并发 + 最多 3 个排队，超出直接 429 |

## 安装

插件是一个 DSH bundle。仓库里**带着构建好的 `lib/`**（宿主 ESM + 浏览器 bundle），
装完就能用；只有改了源码才需要重新 `pnpm build`。
三种安装方式（本地目录 / npm / git）的完整步骤见 [INSTALL.md](INSTALL.md)。

最短路径：在 DSH 的**插件页 → 添加插件**里填这个目录的绝对路径。

```bash
git clone <this repo> dsh-loomy
cd dsh-loomy
pnpm install
pnpm build          # 仅当改了 src/ 才需要；产物在 lib/：index.mjs + client/index.js
```

装好后重启 DSH，在 **设置 → 插件 → DSH Loomy Connect** 里添加账号。

<details>
<summary>开发者：一条命令装进本机 profile</summary>

```bash
pnpm build && pnpm deploy
```

`pnpm deploy` 会把构建产物装成 **profile 内自足的一份副本**，并把依赖记成
`file:./vendor/dsh-loomy`：

```
<profile>/vendor/dsh-loomy/          产物副本（lib/ + 清单 + 文档）
<profile>/node_modules/dsh-loomy/    同一份副本
<profile>/package.json               "dsh-loomy": "file:./vendor/dsh-loomy"
```

这样做的原因（两种更直觉的做法都踩过坑）：`link:<checkout>` 会把插件文件留在仓库里，
仓库一被清理就在下次启动报 `cannot resolve profile bundle`；写版本号则因为包还没发布到
npm 而换来一次 `ERR_PNPM_FETCH_404` 并回滚安装。脚本幂等，重跑只覆盖有变化的文件，
不会动 profile 的默认模型，也不会碰 `cordis.patch.yml` 里别的条目。
</details>

## 使用

1. **加账号**：设置 → 插件 → DSH Loomy Connect → 「手机号」「密码」→ 登录。
   密码是**讯飞账号中心的密码**（桌面客户端里没有「设置密码」的地方，要先去
   [讯飞账号中心](https://account.xfyun.cn) 设一次）。没密码就先发验证码。
2. **选模型**：在对话窗口底部的模型选择器里选 `Loomy` 下的模型。模型 id 与上游一致，
   不做改名/别名映射 —— 上游目录里叫什么，这里就是什么。
3. **多账号**：重复添加即可。卡片上可以置顶（优先用）、暂停（不参与轮转）。
   某个号的会话失效时，有密码的会自动重登；没密码的会标成「需要登录」，不影响其它号。
4. **点数**：切到「点数」页点「刷新点数」，每个号的余额、每日赠送、查询失败原因都会显示。
5. **挑模型**：「模型」页里可以逐个勾选，也可以用 **全选** / **反选**。
   反选是全选的反操作：全选 → 一个都不给，一个都不给 → 全选，部分勾选 → 取补集，
   按两次就回到原样。「一个都不给」是一个真实存在的状态（模型选择器里不会再出现 Loomy），
   不会又被当成「全选」。

## 点数是什么，不是什么

- **是**上游账本里的**账号级**数字：`可用 = 永久余额（balance）+ 每日赠送（dailyBalance）`。
  这是真查询（`GET /points/records`），不是本机估算。
- **不是**本机用量。底部的「今日」只统计**本机经这个插件**花掉的量 —— 同一个号在别的设备、
  别的客户端上花掉的点数不在这里。
- **每日赠送的重置时刻上游没有公开**，所以插件只显示数值，不编倒计时。
- 一个请求实际扣多少点由模型倍率决定（`x0.1` … `x12.0`，卡片上每个模型都标了），
  上游在响应的 `usage.points_consumed` 里给准确值，本机账本记的就是那个数。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabledModels` | `[]` | `custom` 模式下允许出现的模型 id；空 = 全部 |
| `modelSelectionMode` | 未设置 | 模型勾选模式：`all` 全给 / `none` 一个都不给 / `custom` 只给勾选的。未设置时由 `enabledModels` 推断 |
| `showDock` | `true` | 对话输入框下方那行 Loomy 状态 |
| `showSidebarPanel` | `false` | 侧边栏图标列里的入口（图标列是共用资源，缺省不占） |
| `showSettingsEntry` | `true` | 设置左侧导航里的入口 |
| `maxConcurrent` | `1` | 同时打到上游的生成数 |
| `maxQueue` | `3` | 本地排队上限，超出直接 429 |
| `strategy` | `balance` | 选号策略：`balance` / `round_robin` / `lru` |
| `autoRenew` | `true` | 会话快到期时用存着的密码自动重登 |

环境变量：`LOOMY_UPSTREAM`（模型网关，测试可指向本地假上游）、`LOOMY_ACCOUNT_BASE`
（账号服务）、`LOOMY_AK_ID` / `LOOMY_AK_SECRET`（签名常量覆盖）、
`LOOMY_IDENTITY_MODE`（`per_account` 缺省 / `client` 逐字照抄客户端的 `devid: web`）、
`LOOMY_MAX_CONCURRENCY` / `LOOMY_MAX_QUEUE` / `LOOMY_QUEUE_COOLDOWN_MS`、
`UPSTREAM_IDLE_TIMEOUT_MS`、`DSH_HOME`（插件数据目录，默认 `~/.dsh`）。

## 数据落在哪

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/.loomy-accounts.json` | 多账号凭证（含 `session` 与 `password`） | `0600` |
| `~/.dsh/.loomy-usage.json` | 本机用量账本 | 默认 |
| `~/.dsh/.loomy-refresh.log` | 登录/续期失败的原因（1MB 截断） | `0600` |

凭证是**明文**存的（`0600`）—— 这是纯客户端方案：不存密码就得多收一次验证码。
不要把 `.loomy-accounts.json` 提交到任何仓库。

## 排障

- **卡片一直「读取中」** → 宿主 WebServer 没起来，或 `/api/loomy/status` 被拦截。
  卡片只接受 loopback 请求（`Host` 与 `Origin` 都必须是回环）。
- **登录报「HMAC signature」** → 签名常量与当前客户端不一致。设 `LOOMY_AK_ID` /
  `LOOMY_AK_SECRET`；签名细节见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md) 第 3 节。
- **登录报「密码错」** → 密码指的是**讯飞账号中心**的密码；没设过就先用短信登录，再补密码。
- **模型目录是空的** → 上游没返回模型，或还没登录。点「刷新模型」看账号级错误。
- **对话报 `unknown model`** → 请求的 id 不在 `GET /models` 的目录里。上游对未知 id 会
  静默回退到默认模型，所以插件宁可报错也不让你以为在用别的模型。
- **对话报 401** → 该账号会话失效；有密码会自动重登，没密码去卡片上补密码或重新登录。
- **对话报 429** → 本地队列满了（1 在飞 + 3 等待），或所有号都在冷却。等一会儿再发，
  或在卡片上「刷新点数」看看是不是某个号点数用完了。
- **模型选择器里没有 Loomy** → 卡片底部的「体检」会指出具体是哪一关没过。其中
  `provider` 那一条说明 provider 有没有真的注册到宿主的模型层：为 false 时通常是
  `lib/` 还是旧的（没重新 `pnpm build`），或者 DSH 没重启。

## 原理

```
DSH / pi-ai ──OpenAI──▶ 本机回环 shim ──OpenAI 兼容──▶ loomyad.xunfei.cn/api/v1
                              │
                              ├─ 选号（账号池：点数/轮转/最久未用）
                              ├─ 解析会话（快过期就用存着的密码重登）
                              ├─ 注入 token / traceparent / loomy-version
                              ├─ 流式 / 非流式同一条路径（body.stream 区分）
                              └─ 结束后按 usage.points_consumed 记账

登录：本插件 ──HMAC-SHA1 签名──▶ account.xfinfr.com ──RSA(密码)──▶ 14 天会话
```

上游的接口细节（两个主机、九行签名、会话寿命、目录/点数形状、错误语义）都记在
[`docs/PROTOCOL.md`](docs/PROTOCOL.md)。改转发逻辑前请先读那一份。

## 开发

```bash
pnpm typecheck   # 宿主侧 + 浏览器侧两套 tsconfig
pnpm test        # vitest（纯函数 + 本地假上游，不打真实接口）
pnpm build       # tsdown + wrap-client（CSS module 会生成 .d.ts）
node scripts/smoke-apply.mjs   # 离线跑一遍 apply()：路由 / provider 注册 / 门禁
```

约定见 [`AGENTS.md`](AGENTS.md)。

## 与同类项目的区别

| | 本插件 | loomy2api（Python 网关） | loomy2api（Web 版反向代理） |
|---|---|---|---|
| 形态 | DSH 插件，注册 `loomy` provider | 独立 HTTP 网关 | 独立 HTTP 网关 |
| 上游 | 模型网关 `loomyad.xunfei.cn`（OpenAI 兼容） | 同 | Web 聊天接口（单 `content`，无 tools） |
| 登录 | 服务端密码/短信 | 服务端密码/短信 | 浏览器 Cookie |
| 多账号 | 有（点数感知选号） | 有 | 有 |
| 工具调用 | 透传 | 透传 | 不支持 |

## 免责声明

本插件与讯飞、DeepSeek 均无隶属关系，供个人学习与自用。使用它可能违反上游的服务条款；
账号风险、额度变化、接口失效都由使用者自行承担。请勿用于商业分发或转售。账号里的点数
是真金白银（或每日赠送的额度），所有请求都会按上游规则扣费。
