---
name: xxn-lite-loop
description: 用完即弃的「需求 × 工程组」轻量开发推进 Loop。支持 GitLab 与 GitHub、单仓与多仓（一核多从）、个人极简到团队严格三档（L1/L2/L3）及平滑升档。遇到一句话事项、已定设计稿或多人并行需求需要可控节奏、断点续接、独立终审与收尾无残留拆架时使用；10 分钟微改动直接对话改，不进本流程。
---

# xxn-lite-loop

围绕**单个需求**搭建临时施工脚手架，推进到合入上线后一键拆架（`teardown`），**不侵入业务仓库的 `AGENTS.md` 或主干分支**。

## 三层数据边界（严禁混放）

1. **Skill 本体（本目录）**：通用状态机、角色入口、GitLab/GitHub 统一脚本 `scripts/forge.mjs` 与配置引擎 `scripts/loopctl.mjs`。
2. **本机永久记忆（`~/.config/dev-loop/`，绝不提交进业务仓库）**：
   - `me.yaml`：个人模型档位偏好、工作时段、汇报方式、静音巡检偏好。
   - `projects/<group-slug>.yaml`：工程组档案（`forge: gitlab|github`、核心仓 `hubRepo`、关联子仓 `linkedRepos[]`、默认档位、验证命令、可选通知群与 bot 实查的成员 `open_id` 映射）。
3. **本次需求临时态（仅活在需求生命周期内）**：
   - Forge 台账 Issue / 子 Issue / PR(MR) / 标签（全部锚定在 `hubRepo`）；
   - 本次专属定时任务与临时 worktree；
   - 运行快照 `~/.config/dev-loop/runs/<req-slug>.json`（`teardown` 时自动归档清理）。

### 三层大白话协作规矩（可选 `rules`）

`me.yaml`、`projects/<slug>.yaml` 与本次 `--overrides` 都可写 `rules: ["一句话一条规矩"]`，按 **个人 → 工程 → 临时** 合并成生效清单；有生效规矩时确认单在 6 行之后多一行摘要（`协作规矩：生效 N 条（个人 x / 工程 y / 临时 z）`）。三条轻护栏只提醒、不截断、不阻断：每层最多 5 条、单条建议 ≤80 字、三层合计超过 10 条提示瘦身；驼峰/缩进/ESLint/单测覆盖率这类编码规范只提醒挪到仓库 `AGENTS.md`；L3 的个人规矩若试图免终审、调低风险判定、绕过升级串或私合环境/主干分支，直接拦下不生效并记入 `rules.blocked`。

## 入口路由（按用户意图直达）

| 用户意图 | 立即读取 | 核心动作 |
| --- | --- | --- |
| **首次使用 / 缺本机配置**（无 `me.yaml` 或当前工程无档案） | `references/lifecycle.md`（新增「零配置冷启动向导」） | 静默探测 git remote / 构建工具 / Forge CLI → 1 次问清 4 道选择题（全带默认值）→ 自动写盘，**绝不让用户手写 YAML**，紧接着出 6 行确认单 |
| **启动新需求**（一句话 / 贴设计稿） | `references/lifecycle.md`、`references/tiers.md` | 读本机 `me.yaml` + 工程组档案 → 判档（L1/L2/L3）→ 出 6 行确认单 → 确认后运行 `loopctl.mjs init` + `forge.mjs` 建齐脚手架并进首轮 |
| **查进度 / 问下一步**（现在卡哪了 / 接下来干嘛） | `references/lifecycle.md`（第六节「随时查进度与下一步引导」）、`references/controller.md` | 只读调用 `loopctl.mjs status [--req <slug>] [--live]` + 核对台账 → 用 3 句话答「当前阶段与卡点 + 待你动作 + 下一句可直接复制的口令」，不改状态 |
| **环境体检 / 台账校验**（开跑前自查 / 巡检抽查） | `scripts/loopctl.mjs` | 调用 `loopctl.mjs doctor`（6 项只读体检） / `ledger-lint`（≤80 行与结构硬校验） / `transition-check`（状态流转红线核验） |
| **加入已有 L3 团队需求**（给总台账链接） | `references/lifecycle.md`（第三节「加入已有 L3 团队需求」）、`references/tiers.md` | 读总台账识别未绑定槽位 → 合并确认一次 → 抢槽验证通过后建本人小台账与本机巡检/主控 |
| **主控每次唤醒**（定时或手动） | `references/controller.md` | 只按固定路由表读最小范围；严禁在主控会话内长聊设计（聊控分离） |
| **派终审 / 主研发调度**（L3 独立会话） | `references/review-and-dispatch.md` | 扫多仓 `待终审/终审中` → 派最强模型新会话 → 核对目标分支/head SHA/依赖后分流合入 + 同步总台账 |
| **小巡检 / 大巡检**（L2/L3） | `references/patrol-and-notify.md` | 小巡检无事安静退出；大巡检盯 5 条客观产物探针（含 L3 个人临时规范红线），工作时段内群里说人话真 `@` 涉事人 |
| **需求升档**（`L1→L2` / `L2→L3`） | `references/tiers.md`（第四节「平滑升档协议」） | 顺序运行 `loopctl.mjs upgrade --req <slug> --to L2|L3`（禁止跳档 `L1→L3`），补建对象后再 `--apply` |
| **收尾拆架与条件复盘**（合入上线 / 终止需求） | `references/lifecycle.md`（第五节「收尾拆架」） | 先按客观门槛评估 `loopctl.mjs retro`（顺风小单安静跳过，坎坷/大单出分级建议并须人工确认）→ 再两步拆架 `teardown` → `teardown --finalize` 核验无残留归档 |

## 档位速查（详情与全量阈值见 `references/tiers.md`）

- **L1 极轻档（Sprint）**：个人一句话小需求 / 宽松个人项目。1 个追踪 Issue 兼台账 + 1 主控 + 变更单必经 1 次独立终审；默认不开定时、不建调度与巡检。
- **L2 标准档（Standard）**：个人复杂多仓需求 / 长时自动推进（跨夜需显式配置对应工作时段）/ 严格工程单人做。1 主台账 + 子 Issue + 1 主控 + 1 静音小巡检（60m）+ 变更单必经独立终审；低风险无依赖可自动合 / 高风险手合 / `k≥2` 交本人裁决。
- **L3 团队严格档（Squad）**：2–N 人并行 / 强耦合多仓。`1+N+1` 台账 + 契约与归属 + 各槽位主控 + 主研发独立调度 + 静音小巡检 + 全局大巡检（30m 客观探针 + 群真 `@` + 可选 10:00 日报）。

## 不可妥协的 7 条硬底线（只管推进机制与交付单元，不管个人写码风格/工具）

1. **聊控分离**：探讨需求、方案头脑风暴、写草稿一律另开普通会话；主控只收定稿或文档链接做 Forge 落盘，防止主控上下文膨胀失忆。
2. **主控不写代码**：主控只做对账、路由、派子角色（拆分/开发/自审）、核验构建、push、建 PR/MR 与写台账；开发/终审由短命子会话执行，**具体写码/调研用什么工具或个人 Skill，Loop 不干涉**。
3. **写前校验 + 先记后做**：每次外部写操作前先核台账主控标识（优先用 `forge.mjs issue-update --expect-owner <id>` 机械锁），非现任立即停写自停定时任务；外部动作前记「准备做 X」，完成后改「已完成 X」。
4. **交付单元标准不放水**：子 Issue 必齐五项（范围/契约/纵向 MR 拆分 1–3 片/验收/存量影响与回退），按第一性原理切分可独立验收的纵向功能片，杜绝按技术分层硬拆或巨型 MR。
5. **所有变更必经独立终审**：L2/L3 绝不因提交人是主研发或单人开发而免终审（仅 L1 个人单干允许用户在 `me.yaml` 显式 DIY 放宽）；生产/环境分支（`test/uat/main/master`）合入与部署一律由人执行。
6. **巡检只评不改**：小巡检与大巡检绝不改代码、绝不改台账正文、绝不代裁决；对台账只写评论，无事安静退出。
7. **双轨表达**：GitLab/GitHub 评论给 AI 看（写清源码路径、commit SHA、精确动作）；外部群消息给人看（禁止堆内部代号，必须说人话：问题在哪 + 举个例子 + 为什么 + 建议怎么改）。

## 内置工具与可选薄 Hook（优先调用，不手拼 API，需 Node 20+）

- `node <skill>/scripts/loopctl.mjs`：配置四级合并、环境体检（`doctor`）、台账自检（`ledger-lint`）、状态流转守卫（`transition-check`）、只读状态与实时仪表盘（`status [--live]`）、确认单与初始化（`preview-init` / `init`）、抢槽判定（`slot-claim`）、唤醒/终审/巡检判定、顺序升档（`upgrade`）、条件触发机制复盘（`retro`）与两步拆架（`teardown` / `teardown --finalize`）。
- `node <skill>/scripts/forge.mjs`：统一 GitLab（`glab`）与 GitHub（`gh`）的 Issue 读写关闭（支持 `--expect-owner` 写前锁）、PR/MR（`change-list/create/label/merge`）、标签同步（`labels-sync`）、叠加依赖与 head SHA 及 Git 血统白名单硬校验、基线核对（`baseline-check`）。
- `node <skill>/hooks/guard-command.mjs`（可选加装，用 `hooks/install-hooks.mjs` 安装）：仅在当前目录命中活跃 Loop 运行态时激活，经词法解析**100% 放行全部正常 `git` 命令与非合并 `glab/gh` 命令**，只精准拦截向受保护环境分支裸 `git push`、反向 `git merge` 非主干环境分支以及绕过 `forge.mjs` 裸跑 `glab mr merge`/`gh pr merge`。
