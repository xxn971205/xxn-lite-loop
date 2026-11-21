# xxn-lite-loop

一套**用完即弃**、只管需求交付节奏与底线的 AI 轻量工程推进环（MIT License）。

- **只管机制，不干涉你用什么工具/编码风格**：无论用 T3 Code、Codex、Claude Code 还是 Gemini，无论个人开发怎么写码怎么测，Loop 只守住「需求建构与纵向拆分标准 + Git 唯一真相基地 + 独立审查 + 防误合门禁 + 收尾零残留」。
- **核心基地在 GitLab / GitHub，本机配置在仓外**：长期偏好与工程档案存在 `~/.config/dev-loop/`，绝不污染业务仓库 `AGENTS.md` 或主干分支；需求上线后两步拆架归档，业务仓 0 残留。
- **三档按需平滑升档**：单人极轻 **L1** → 个人多仓自动推进 **L2** → 多人并行 **L3**（支持总台账临时规范热同步、个人偏好不破公共门禁、大巡检 5 条客观探针）。
- **三层大白话协作规矩**：`me.yaml` / 工程档案 / 本次覆盖各写 `rules: ["一句话一条规矩"]`，按个人 → 工程 → 临时合并，确认单带一行摘要；只收协作与风控规矩（编码规范请放仓库 `AGENTS.md`），每层 ≤5 条、单条 ≤80 字、合计 ≤10 条只提醒不截断，L3 个人规矩不得绕过公共门禁。
- **脚本确定性守卫 + 可选薄 Hook + 条件触发纯机制复盘**：内置 `doctor` / `ledger-lint` / `transition-check` / `status --live` / `--expect-owner` 写前锁 / `retro`，并可选加装零误杀正常 `git` 命令的薄 Hook 安全栓。

## 1 分钟安装（需 Node.js 20+、Git、已登录 `glab` 或 `gh`）

```bash
bash install.sh
# 如需可选加装防裸推主干 / 防裸 merge 的薄 Hook 安全栓（仅活跃 Loop 目录生效，0 误杀正常 git 命令）：
bash install.sh --with-hooks
```

重启 AI 客户端或新开会话后，直接说人话触发（首次自动 4 题向导建好本机档案，无需手写 YAML）：

1. **一句话启动需求**：`$xxn-lite-loop 给这个工程加一个导出 Markdown 的功能`
2. **加入同事建好的 L3 需求**：`$xxn-lite-loop 加入 <需求总看板 Issue 链接>`
3. **随时查进度 / 卡点**：`$xxn-lite-loop 现在什么进度，我接下来该干嘛`
4. **中途平滑升档**：`$xxn-lite-loop 把当前需求从 L1 升档到 L2`
5. **收尾复盘与拆架**：`$xxn-lite-loop 收尾拆架`

## 目录结构

- `SKILL.md` 与 `references/`：主入口、档位阈值、生命周期、主控路由、独立终审、巡检通知与模板。
- `scripts/loopctl.mjs`：配置四级合并与三层协作规矩（`rules`）、状态机、升档、拆架与守卫/复盘统一入口。
- `scripts/guard.mjs`：`doctor`、`ledger-lint`、`transition-check`、`status --live` 与 L3 个人约定红线检查。
- `scripts/retro.mjs`：客观门槛触发的纯 Loop 机制复盘引擎（纯只读，支持生成脱敏 Issue 提案）。
- `scripts/forge.mjs`：GitLab (`glab`) / GitHub (`gh`) 统一适配层（含写前锁 `--expect-owner` 与 Git 分支血统门禁）。
- `hooks/guard-command.mjs` & `hooks/install-hooks.mjs`：可选薄安全栓与非破坏性安装器。
- `tests/`：全流程离线模拟测试与守卫/Hook 多轮压测套件。

## 反馈与演进

本仓库采用**只读发布模式**（主分支受保护，不直接合并外部 PR）。欢迎通过 Issue 模板反馈 Bug 或提交 `loopctl.mjs retro` 生成的脱敏机制优化提案，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
