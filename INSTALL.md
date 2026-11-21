# 安装

本插件是一个 **DSH bundle**。仓库里**带着构建好的 `lib/`**（宿主 ESM + 浏览器 bundle），
克隆下来就能装；**只有改了源码才需要重新构建**。
三种方式选一条，都要求 Node `^22.19.0 || >=24.0.0`。

---

## 0. 构建（仅当改了 `src/`）

```bash
git clone <this repo> dsh-loomy
cd dsh-loomy
pnpm install
pnpm build          # 产物：lib/index.mjs（宿主）+ lib/client/index.js（浏览器）
```

`lib/` 是**入库**的：发布/安装时宿主直接加载它。所以改完源码不重新 build，DSH 加载的
还是旧产物 —— 这是「改了代码没生效」最常见的原因。

没有全局 `pnpm` 时，用 DSH 自带的 node + pnpm：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install
& $node $pnpm build
```

`pnpm install` 会提示 `Ignored build scripts: @google/genai, protobufjs` 之类的信息。
仓库的 `pnpm-workspace.yaml` 已经把这两个包显式登记成 `allowBuilds: false`（它们是 pi-ai
的传递依赖，本插件不用它们的构建脚本），所以安装不会因此失败。

---

## 1. 本地目录（推荐给自己用）

```bash
pnpm build
pnpm deploy         # 装进 <用户目录>/.dsh/profiles/desktop
```

`pnpm deploy` 做的事：

```
<profile>/vendor/dsh-loomy/          构建产物副本（lib/ + 清单 + 文档）
<profile>/node_modules/dsh-loomy/    同一份副本（宿主立刻可解析）
<profile>/package.json               "dsh-loomy": "file:./vendor/dsh-loomy"
<profile>/dsh.profile.bundles        追加 "dsh-loomy"
```

为什么不写 `link:` 也不写版本号：

| 做法 | 后果 |
|---|---|
| `link:<checkout 路径>`（插件管理器按目录安装会这么写） | 插件文件留在 checkout 里；checkout 被清理/误删，下次启动就是 `cannot resolve profile bundle "dsh-loomy"` |
| `"0.1.0"` 之类版本号（包没发布到 npm） | 插件页安装会 `ERR_PNPM_FETCH_404` 并回滚 |
| **`file:./vendor/<pkg>` + profile 内副本** | 文件自足、无需 registry；`pnpm deploy` 幂等重装 |

也可以在**插件页 → 添加插件**里填这个目录的绝对路径。那种方式由插件管理器写 manifest，
升级后要重新安装一次。

**改了宿主侧代码必须重启 DSH**；客户端产物由 `dsh-client-hmr` 自动送进浏览器。

---

## 2. npm（发布之后）

包发布到 npm 后，在插件页搜 `dsh-loomy`，或直接填 `dsh-loomy`（可带版本，如
`dsh-loomy@0.1.0`）。这条路由 pnpm 掌管，升级即 `插件页 → 检查更新`。

未发布时这条路会失败在 `ERR_PNPM_FETCH_404` —— 用第 1 种或第 3 种。

---

## 3. git（给别人装）

把仓库推到你自己的 GitHub，在插件页填 `github:<user>/dsh-loomy`。

三个注意点：

1. **`lib/` 已入库**，所以 `github:<user>/dsh-loomy` 拉下来就能装；但如果你改了源码，
   记得先在插件目录 `pnpm install && pnpm build`（否则宿主加载的是旧的 `lib/`）。
2. 如果宿主不支持 git 直装，就走第 1 种。
3. 别把 `~/.dsh/.loomy-accounts.json` 一起提交 —— 那是明文密码。

---

## 装完之后

1. 重启 DSH。
2. **设置 → 插件 → DSH Loomy Connect**。
3. 「手机号」填讯飞账号的手机号，「密码」填**讯飞账号中心**的密码，点「登录」。
   - 桌面客户端里没有「设置密码」的地方：去 [讯飞账号中心](https://account.xfyun.cn)
     设一次，之后就能无人值守自动续期。
   - 没设密码：点「发送验证码」，填进输入框，点「用验证码登录」。
   - 也可以直接粘一个 `loomy_web_session`（14 天内有效，不能自动续期）。
4. 回到对话窗口，在模型选择器里选 `Loomy` 下的模型。
5. 卡片底部点 **体检**，`provider` 一项应为通过 —— 它表示 `loomy` 这个 provider
   真的注册到了宿主的模型层。为 false 时通常是没重新 `pnpm build`，或者 DSH 没重启。

想看状态文档长什么样：

```bash
curl http://127.0.0.1:<DSH 的 Web 端口>/api/loomy/status
```

只接受回环请求（`Host` 与 `Origin` 都必须是 `127.0.0.1` / `localhost`）。

---

## 卸载

1. 插件页 → DSH Loomy Connect → 卸载（或把它们从 profile 的 `package.json`
   `dependencies` 与 `dsh.profile.bundles` 里去掉）。
2. 想连凭证一起清掉：删 `~/.dsh/.loomy-accounts.json`、`.loomy-usage.json`、
   `.loomy-refresh.log`。

Windows 上不要用 `Remove-Item -Recurse` 删 junction/符号链接：它会跟进目标把内容一起删掉。
