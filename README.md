# @itsyuyi/dsh-session-manager

DeepSeek Harness (DSH) plugin for **workspace session management** — currently: a durable **“Delete session”** action, right in the sidebar session row menu, with a host-styled confirmation dialog.

为 DeepSeek Harness 提供**工作区会话管理**能力——当前版本：在侧栏会话行菜单中增加可**彻底删除会话**的操作，配宿主风格确认弹窗。

## Features / 功能

- **“Delete session” menu row** appended to each session's `…` menu (after the shipped pin / rename / fork / archive rows), styled exactly like the host's destructive menu rows (theme tokens only, light & dark).
  每个会话“…”菜单末尾追加红色“删除会话”项，样式与宿主内置菜单行一致（仅用主题 token，自动适配明暗主题）。
- **Host-styled confirmation dialog** rendered in the `shell.overlay` slot: Escape / mask click dismiss, Cancel focused on open, in-flight and error states live inside the dialog.
  宿主同款确认弹窗：Esc/点遮罩关闭、打开即聚焦“取消”、删除中与错误状态都在弹窗内展示。
- **Durable deletion** — removes the session log artifact and detaches it from every workspace account (archive/pin sets included). The sidebar refreshes automatically; the search index reconciles itself on the next search.
  彻底删除——移除会话日志工件并从所有工作区登记（含归档/置顶集合）中摘除。侧栏自动刷新，搜索索引下次搜索时自动同步。
- **Safety guard** — refuses to delete a session with actual running work (a turn in flight, owned jobs, live subagents, active schedules), using the exact same `workspace/session-activity` admission the host's own archive flow uses. Idle sessions — even currently open ones — are deletable.
  安全保护——复用宿主归档同款的活跃判定：只拒绝**真正在运行**的会话（回合/任务/子代理/日程），空闲会话（即使打开着）可删。
- **Localized** — UI copy follows the host language (中文 / English), live-switching.
  界面文案跟随宿主语言，实时切换。
- **Verification tool** — `verify-session.mjs` checks on disk whether a session is truly gone (artifact directory + workspace registry), by session id **or title**.
  附带核对脚本：按 id 或标题确认会话是否已从系统目录真正删除。

## Requirements / 环境要求

- DeepSeek Harness (web surface), DSH `0.1.7` generation (`@deepseek-ai/cordis` 4.x)
- Node `^22.19.0 || >=24.0.0`

## Install / 安装

In any DSH agent session, ask the agent (or use the plugin manager) to install from npm:
在任意 DSH 会话里让 Agent 执行（或通过插件管理器）从 npm 安装：

```
plugin_manager install_bundle  target: @itsyuyi/dsh-session-manager
```

Or install from a local clone / 或从本地克隆安装：

```bash
git clone https://github.com/itsyuyi/dsh-session-manager.git
# then: plugin_manager install_bundle  target: /absolute/path/to/dsh-session-manager
```

Then **refresh the browser page** once to load the client module.
安装后**刷新一次页面**以加载客户端模块。

Uninstall / 卸载：`plugin_manager remove_bundle @itsyuyi/dsh-session-manager`

## Usage / 使用

1. Hover a session row in the sidebar → click `…` → **Delete session / 删除会话**.
2. Confirm in the dialog. Done — the row disappears immediately.
   弹窗确认后即删除，侧栏行立即消失。

If the session is actually running, the dialog tells you to stop it first (this includes the session you are chatting in while it is mid-turn).
若会话正在运行，弹窗会提示先停止（包括你正在对话中的会话）。

### Verify deletion / 核对删除结果

```bash
node verify-session.mjs              # list every known session with on-disk status
node verify-session.mjs "Some title" # check one session by title or id
```

“Deleted” means: artifact directory under `~/.dsh/sessions/` gone **and** no reference left in `workspace.json`. Projection-cache leftovers are derived data and never read again (harmless).
“已删除”判定：`~/.dsh/sessions/` 下工件目录消失 **且** `workspace.json` 无引用。投影缓存残留属派生数据，不会再被读取（无害）。

## How it works / 工作原理

| Half | Mechanism |
|---|---|
| Host (`index.js`) | Registers `POST /plugins/dsh-session-manager/delete-session` on the host web server. Deletion = activity check (`workspace/session-activity` waterfall) → unarchive/unpin → `detachSession` from every workspace → `rm -rf` the session's JSONL artifact directory (traversal-proof: only ever removes existing directory names under the persistence root). |
| Client (`client.js`) | Registers a menu row in `sidebar.workspaces.session.menu.item` and a confirmation dialog in `shell.overlay`, sharing one request store. Styling copied from the host Modal/Menu/Button rules under a `dsm-` prefix using only `--dsw-*` theme tokens. |

The SQLite session-search index needs no write: it reconciles against the persistence listing on the next search and drops vanished sessions automatically.

## Notes / 说明

- Replacing the plugin's **host** code requires restarting `dsh web` (Node ESM module cache); client code reloads on page refresh.
  修改插件 Host 端代码需重启 `dsh web` 才能重载；Client 端刷新页面即可。
- Deleting a session is **irreversible** — prefer the built-in *Archive* when you may come back.
  删除**不可恢复**——想留后路请用内置“归档”。

## License

MIT © 2026 itsyuyi
