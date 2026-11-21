# dsh-loomy

Bridge **Loomy** (iFlytek's desktop AI assistant) model quota into DeepSeek Harness.

Sign in once with a phone number and password — server-side — and the Loomy model gateway's
models (`spark-x`, `GLM-5.3-Flash`, `qwen3.8-flash`, `deepseek-v4-flash-0731`, `Kimi-k2.6`, …)
show up in DSH's model picker, with a multi-account pool, points-aware routing, a dynamic model
catalog and a local usage ledger.

> Not an official plugin, not an iFlytek product. It only wires the endpoints the Loomy desktop
> client already uses (account service + model gateway) into DSH's model layer. The upstream can
> change or tighten its quota at any time; the plugin breaks with it.

---

## Features

| | |
|---|---|
| Server-side sign-in | phone + password → a 14-day session. The password is RSA-encrypted under the key the account service hands out, stored locally with `0600`, and used for automatic renewal |
| SMS sign-in | accounts without a password can use `sendMsgCode` → `checkCode`, at the cost of a new code every 14 days |
| Pasted session | a bare `loomy_web_session` works too (for a quick try; it cannot renew itself) |
| Account pool | per-account session and device identity; pin / pause / rename / add password / sign in again / delete from the card; automatic failover |
| Points-aware routing | the upstream really does report a ledger (`/points/records`), so the default strategy is "most points first"; `round_robin` and `lru` are available |
| Dynamic catalog | `GET /models` on startup and hourly, unioned across accounts; optionally expose only the models you check |
| Honest points | the card shows `available = permanent balance + daily grant`. No reset countdown is invented — the upstream does not publish one |
| Local ledger | requests, tokens and the **actual points charged** (`usage.points_consumed`) for this machine only |
| Request validation | the upstream silently falls back to its default model for an unknown id, so the plugin validates against the catalog and answers `400` instead |
| Concurrency | 1 in flight + up to 3 queued by default; beyond that a plain `429` |

## Install

The plugin is a DSH bundle. **The repo ships the built `lib/`** (host ESM + browser bundle), so
a clone is directly installable; rebuild only after changing `src/`.
See [INSTALL.md](INSTALL.md) for the local-directory / npm / git variants.

```bash
git clone <this repo> dsh-loomy
cd dsh-loomy
pnpm install
pnpm build          # only after editing src/; outputs lib/index.mjs + lib/client/index.js
```

Then restart DSH and open **Settings → Plugins → DSH Loomy Connect** to add an account.

For developers, `pnpm build && pnpm deploy` installs a self-contained copy into the local
profile (`vendor/dsh-loomy` + a `file:` dependency), so the checkout can be moved or deleted
afterwards.

## Usage

1. **Add an account** — phone number and the **iFlytek account-centre password** (the desktop
   client has no "set password" screen; set it once at account.xfyun.cn). No password? Use SMS.
2. **Pick a model** — choose something under `Loomy` in the chat model picker. Model ids are
   used verbatim; there is no alias table.
3. **More accounts** — add as many as you like. Pin the one you want first, pause the rest.
   An account whose session dies is renewed automatically when a password is stored, and marked
   *needs sign-in* otherwise.
4. **Points** — the Points tab refreshes the real ledger per account.

## What the points are (and are not)

- They **are** the account-level numbers from the upstream ledger:
  `available = balance (permanent) + dailyBalance (daily grant)`.
- They are **not** local usage. "Today" in the footer only counts what this machine spent
  through this plugin.
- The daily grant's reset moment is **not published**, so no countdown is shown.
- Each request costs `multiplier ×` points (`x0.1` … `x12.0`, shown on every model row); the
  exact charge comes back as `usage.points_consumed`.

## Configuration

| key | default | meaning |
|---|---|---|
| `enabledModels` | `[]` | model ids offered in the pickers (empty = all) |
| `showDock` | `true` | the Loomy status line under the chat input |
| `showSidebarPanel` | `false` | entry in the sidebar icon column |
| `showSettingsEntry` | `true` | entry in the settings navigation |
| `maxConcurrent` | `1` | concurrent upstream generations |
| `maxQueue` | `3` | local queue depth before a `429` |
| `strategy` | `balance` | `balance` / `round_robin` / `lru` |
| `autoRenew` | `true` | renew sessions with the stored password before they expire |

Environment: `LOOMY_UPSTREAM`, `LOOMY_ACCOUNT_BASE`, `LOOMY_AK_ID` / `LOOMY_AK_SECRET`,
`LOOMY_IDENTITY_MODE` (`per_account` by default, or `client` to mirror the shipped client's
`devid: web`), `LOOMY_MAX_CONCURRENCY` / `LOOMY_MAX_QUEUE` / `LOOMY_QUEUE_COOLDOWN_MS`,
`UPSTREAM_IDLE_TIMEOUT_MS`, `DSH_HOME`.

## Files on disk

| file | contents | mode |
|---|---|---|
| `~/.dsh/.loomy-accounts.json` | accounts, sessions and passwords | `0600` |
| `~/.dsh/.loomy-usage.json` | local usage ledger | default |
| `~/.dsh/.loomy-refresh.log` | why a login / renewal failed (1 MB cap) | `0600` |

Credentials are stored in plaintext under `0600` — that is the price of not asking for an SMS
code every two weeks. Never commit `.loomy-accounts.json`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The card stays on "Loading…" | the host WebServer is down, or `/api/loomy/status` is blocked; only loopback requests are accepted |
| "HMAC signature" on sign-in | the signing constants no longer match the client; set `LOOMY_AK_ID` / `LOOMY_AK_SECRET` |
| "wrong password" | it is the iFlytek account-centre password; set it first, or use SMS |
| The catalog is empty | not signed in yet, or the upstream listed nothing; press "Refresh models" to see the per-account error |
| `unknown model` | the id is not in `GET /models`; the upstream would otherwise answer with its default model |
| `401` in a chat | that account's session died; it renews itself only when a password is stored |
| `429` | the local queue is full, or every account is cooling down (often: out of points) |
| `Loomy` missing from the model picker | press "Run checks" in the card; the `provider` row says whether the provider really registered |

## How it works

```
DSH / pi-ai ──OpenAI──▶ loopback shim ──OpenAI-compatible──▶ loomyad.xunfei.cn/api/v1
                            │
                            ├─ account selection (points / round robin / LRU)
                            ├─ session resolution (renew with the stored password)
                            ├─ inject token / traceparent / loomy-version
                            ├─ streaming and non-streaming share one path (body.stream)
                            └─ record usage.points_consumed in the local ledger

sign-in: this plugin ──HMAC-SHA1──▶ account.xfinfr.com ──RSA(password)──▶ 14-day session
```

The protocol details (two hosts, the nine-line signature, session lifetime, catalog and points
shapes, error semantics) live in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

```bash
pnpm typecheck   # host + browser tsconfigs
pnpm test        # vitest, pure functions + a local fake upstream
pnpm build       # tsdown + wrap-client
node scripts/smoke-apply.mjs   # offline apply(): routes, provider registration, loopback gates
```

See [AGENTS.md](AGENTS.md) for the conventions.

## Disclaimer

Unaffiliated with iFlytek and DeepSeek; for personal study and use. Using it may violate the
upstream's terms of service. Account risk, quota changes and endpoint breakage are yours to
carry. Do not redistribute or resell. The points are real (or a daily grant) and every request
is billed upstream.
