# dsh-sync

Back up and sync DeepSeek Harness content to a NAS over WebDAV.

Every scope (profile config, skills, memory, credentials, extra directories…) carries its own
direction, so one machine can back up its sessions while sharing its skills bidirectionally and
leaving credentials alone. The plugin adds a first-class **备份与同步** panel to the sidebar.

## What it syncs

| Scope | Contents |
| --- | --- |
| `baseConfig` | `cordis.patch.yml`, `cordis.yml`, desktop preferences, locale |
| `modelConfig` | Provider routes and model lists, exported as JSON |
| `mcpServers` | MCP loader rows, exported as JSON |
| `pluginInventory` | Profile `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| `skills` | `~/.agents/skills` and its version lockfile |
| `credentials` | `.credentials.yaml` (off by default) |
| `memory` | A memory storage directory you choose |
| `extraPaths` | Any directories or files you add, optionally at a custom remote path |

Each scope can be switched on or off independently.

## Directions

| Direction | Behaviour |
| --- | --- |
| `off` | Not synced at all. |
| `push` | Writes into this machine's slot `machines/<device>/`. Incremental by file content hash. Never deletes remotely, never writes back locally. |
| `pull` | Only downloads, for bootstrapping a new machine. Overwrite policy is configurable: only missing / newer / always. |
| `two-way` | Reconciles against the shared tree `shared/` using a stored baseline, so "only I changed" is distinguishable from "only the other machine changed". Genuine conflicts keep both copies. |

Deletion is never propagated in any direction — a file removed locally stays on the remote.

Scopes whose content is machine-specific (model config, MCP rows, plugin inventory, memory) can only
be pushed or pulled, not reconciled two-way.

## Remote layout

```
<webdav>/<remoteDir>/
  machines/<device>/<scope>/<rootTag>/…        one-way backup, per machine
  machines/<device>/.dsh-nas-sync/manifest.json   sha256 of what was uploaded
  shared/<scope>/<rootTag>/…                   two-way shared tree
  shared/.dsh-nas-sync/base-<device>.json      this machine's two-way baseline
```

`<rootTag>` records which local root a file came from (`dsh` = DSH home, `agents` = `~/.agents`,
`home` = user home, `abs` = an absolute path), which is what makes a pull able to rebuild the
original absolute path.

## The panel

`备份与同步` in the sidebar icon list opens a panel with three tabs:

- **首页** — per-scope status cards (local/remote file counts, pending uploads) plus
  "refresh comparison" and "run all in their directions".
- **同步内容配置** — the switch, direction and path lists for every scope, with a save button.
  Nothing takes effect until it is saved.
- **连接配置** — WebDAV URL, credentials, remote subdirectory, device name, pull/conflict policy.

## Agent tool

The plugin registers one tool:

- `nas_sync` — `{ action: "plan" | "run", items?, mode?, dryRun? }`. `plan` computes the delta
  without writing anything; `run` performs the transfer.

## Notes and limits

- **Credentials are plaintext.** `.credentials.yaml` is uploaded unencrypted if you enable that
  scope, so anyone who can read the NAS copy can use the tokens in it. It is off by default.
- **http:// is plaintext on the wire.** The plugin warns on every run until the endpoint is https.
- **`link:` / `file:` dependencies are not rewritten.** A profile `package.json` containing absolute
  paths is backed up as-is and needs manual fixing on another machine.
- **Two-way merges nothing textually.** Conflicting files are preserved as
  `<file>.conflict-<device>-<timestamp>` rather than merged.
- **The comparison walks the remote.** Opening the panel paints from configuration immediately and
  fills the numbers in the background; remote directory listings are cached for 15 seconds and
  bypassed when you press refresh.

## Install

```
dsh plugin add github:stone-yu/dsh-sync
```

Or use **Plugins → Add plugin** in DSH and point it at this repository.

Requires a DSH build that mounts a WebDAV-reachable browser session; the Host half declares
`@deepseek-ai/schemastery` as a peer dependency.

## 中文说明

把 DSH 的内容备份到 NAS 的 WebDAV 目录，支持多端共享与还原。

- **每个内容项独立设置方向**：关闭 / 上传备份 / 下载还原 / 双向同步。
- **上传按文件内容哈希增量**，单个文件是整文件替换；**任何方向都不传播删除**。
- **双向同步**用基线做三方比对，冲突时保留双方副本，不做文本合并。
- 侧栏有独立面板（首页 / 同步内容配置 / 连接配置），改配置需手动保存。
- 记忆与其他文件目录的路径可自行配置；其他文件目录还能指定独立的远端位置，用来放公共产出物。

## License

MIT
