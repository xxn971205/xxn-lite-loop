# 10 分钟体验指南

先用 L1 给问候程序加一个小功能：确认范围、看独立终审与合并前试合、在 GitHub 自己合回 `main` 并拆架。再用 L2 打开巡检窗口，问一次进度、做一次裁决。飞书绑定可选。

## 准备沙箱

**你执行。** 需要 Node.js 20+、Git 和已登录的 `gh`。先把 `<你的账号>/<沙箱仓名>` 换成你自己的 GitHub 私有仓名后在终端运行下面命令，再用 AI 客户端打开输出的 `repo` 目录。若本机还没按 `README.md` 安装 v2.3，把 [SKILL.md](../SKILL.md) 发给 AI，让它从同一份 LiteLoop 检出的 `scripts/` 运行命令。

```bash
SANDBOX_REPO="<你的账号>/<沙箱仓名>"
SANDBOX_DIR="$(mktemp -d /tmp/liteloop-sandbox.XXXXXX)" && mkdir -p "$SANDBOX_DIR/repo" && cd "$SANDBOX_DIR/repo"
printf '{"name":"hello-sandbox","private":true,"scripts":{"test":"node --test"}}\n' > package.json
printf 'const name = process.argv[2] || "World";\nconsole.log(`Hello, ${name}!`);\n' > index.js
printf 'const test = require("node:test"), assert = require("node:assert/strict"), { execFileSync } = require("node:child_process");\ntest("greets", () => assert.equal(execFileSync("node", ["index.js", "Alice"], { encoding: "utf8" }), "Hello, Alice!\\n"));\n' > index.test.js
printf '# hello-sandbox\n' > README.md
git init -b main && git add . && git commit -m "init"
gh repo create "$SANDBOX_REPO" --private --source=. --remote=origin --push
gh repo view "$SANDBOX_REPO" --json nameWithOwner,isPrivate,defaultBranchRef
export XXN_LITE_LOOP_CONFIG_DIR="$(mktemp -d "$SANDBOX_DIR/config.XXXXXX")"
printf 'repo: %s\nconfig: %s\n' "$PWD" "$XXN_LITE_LOOP_CONFIG_DIR" && npm test
```

**你会看到。** GitHub 新建了私有沙箱 `<你的账号>/<沙箱仓名>`，默认分支是 `main`，终端打印本地 `repo` 路径和本次专用配置目录。把配置目录路径发给 AI，让它在所有命令和定时任务里用 `XXN_LITE_LOOP_CONFIG_DIR` 或 `--config-dir` 指向该目录（桌面会话可能读不到终端环境变量）。

**去哪确认。** 终端输出含 `"isPrivate":true`，且 `npm test` 通过。请 AI 首次读配置前复述沙箱仓库和配置路径。这样可避开日常的 `~/.config/dev-loop`。

## L1 走完一次交付

### 1. 发一句话，确认范围

**你说。** 「`$xxn-lite-loop` 用 L1 给沙箱的问候程序加 `--repeat <n>`。例如 `node index.js Alice --repeat 2` 应逐行输出两次问候，省略参数时仍只输出一次。加测试并用 `npm test` 验证，最后我自己在 GitHub 合到 `main`。配置用刚才打印的目录。」

**你会看到。** 第一次会一次问四个问题，可答「按默认，单仓，本地运行 `npm test`，本次选 L1」。AI 会在隔离目录写入 `me.yaml` 和工程档案（`local-test` 需配 `verification.commands`，有外部依赖的工程需自带安装步骤如 `npm ci && npm test`，否则 `init` 报 `MISSING_VERIFICATION`），用 `config-resolve` 核对后输出 6 行确认单：需求与档位、工程组与基线、验证策略（含合并前试合）、角色模型、节奏与收尾、合并方式。核对后回「确认」。 [配置示例](../references/lifecycle.md#本机配置)

**去哪确认。** 在当前会话核对 6 行确认单：第 2 行核心仓是你的沙箱、基线为 `main`（让主控预览与初始化时传 `--branch main`），第 3 行合并前试合为 `npm test`，第 5 行定时为关，第 6 行显示「全部人工合并（基线是受保护分支）」。L1 单变更单从 `main` 拉功能分支，终审后由本人合回 `main`。重复体验时给需求起新名字。

### 2. 打开 GitHub 台账

**你说。** 「把这次需求的 GitHub 台账链接发给我。」

**你会看到。** 一个追踪 Issue，含基本信息、当前任务、变更与终审清单以及收尾待办。若需定位卡点，请 AI 核对 `init` 是否生成正文、`issue-create` 是否返回链接，以及 `init --resume --issue-map` 是否已回填编号。 [建台账步骤](../references/lifecycle.md#一句话启动)

**去哪确认。** 打开 Issue 的「基本信息」和评论区，刷新核对「最近唤醒」与当前步骤。L1 默认手动推进，两次操作之间没有定时心跳。

### 3. 看独立终审与合并前试合

**你说。** 「继续完成开发和测试，送独立终审。把变更单和终审结论链接给我。」

**你会看到。** 主控建指向 `main` 的 PR，用 `forge.mjs dispatch-review` 登记派审。独立终审用 `forge.mjs verdict` 登记并发布结论：打回时标「需修改」；通过后，`local-test` 会在全新临时检出里用 `npm test` 做合并前试合（失败则标「需修改」）。开启自动合并且目标非受保护基线时，`verdict` 核对基线未前移后当场合并；本例目标是受保护的 `main`，试合通过后留存试合基线证据并标「待合并」，交由你本人合入。

**去哪确认。** 在 PR 的 **Files changed** 看 `--repeat` 实现与测试，在描述核对 `npm test` 证据；在评论区确认派审与结论对应同一轮次、终审会话标识与主控不同、候选仍是当前提交，并看到「合并前试合：npm test 通过」及基线 SHA。体验 L2 时，启动前可说「合并改成全人工 / 改成自动合并」重看确认单第 6 行，启动后用 `loopctl.mjs merge-mode --req <slug> --manual|--auto` 切换，对照 `status` 首段和台账【配置变更】评论。

### 4. 自己合入

**你执行。** 确认终审通过且合并前试合通过后（若 `main` 在试合后有新提交，先重新确认），在 GitHub PR 页面选 **Create a merge commit** 合入 `main`，再对主控说「我已合入，请对账」。

**你会看到。** PR 变为 **Merged**，台账更新已合入结果。

**去哪确认。** 看 PR 顶部状态和 GitHub `main` 的提交记录，刷新台账核对 PR 链接。

### 5. 拆架

**你说。** 「收尾拆架。先给清单，按清单清理，核验后告诉我还剩什么。」

**你会看到。** AI 先列出关联台账、任务和临时工作目录，再执行关闭、核验和归档。有未结项或需保留的工作目录时先按清单决定。

**去哪确认。** GitHub 追踪 Issue 为 **Closed** 且有完成摘要，隔离目录的 `runs/archive/` 有本次归档，宿主任务列表里无该需求的活动定时任务。

## L2 体验巡检窗口

### 6. 开第二个需求并问进度

**你说。** 「`$xxn-lite-loop` 用 L2 给这个沙箱 README 增加一条命令示例，说明如何运行问候程序。先做计划，我想先决定 README 是否同时放测试命令。沿用本次隔离配置目录，给这次需求取新名字。」

**你会看到。** 确认单里有独立需求基线（默认 `loop/<slug>`）、主控和小巡检定时任务，以及第 6 行的合并方式。确认启动后，主控把 README 范围问题写进台账「需本人处理」并留一条可回复的评论。进宿主的小巡检会话问「现在做到哪了，下一步要我做什么？」若要看定时唤醒记录，可在工作时段从宿主手动触发小巡检任务一次。

**去哪确认。** 巡检会话各用一句告诉你做到哪、等你决定什么、最近一次醒来做了什么，逐句附链接对照 GitHub 台账和评论；也可用带隔离目录的 `loopctl.mjs status --req <slug>` 看本机记录。

### 7. 给一次裁决

**你说。** 在小巡检里引用上一步的问题评论，回复「我确认 README 只加运行问候程序的命令示例，这次测试命令不用写进 README。请把裁决回到那条评论。」

**你会看到。** 巡检用 `forge.mjs reply` 把决定写成【裁决】、关联原评论并返回链接，主控据此继续准备本轮工作。

**去哪确认。** 打开台账原问题与裁决，核对范围、执行人与原评论关联。

### 8. 绑飞书群，可选

**你说。** 提前把发通知的机器人加进测试群，在小巡检会话说「把这次的提醒往测试群推送」。

**你会看到。** 群绑定结果；遇同名群会列候选，成员对不上时原样列出。成功后出现【配置变更】评论，后续有新提醒才按配置窗口推送。说「别发群了」可解除本次绑定。

**去哪确认。** 打开 GitHub 台账评论，核对群名和「仅本次需求」范围，解除后再看一条【配置变更】。体验完成后可按「拆架」收尾第二个需求，再按需删除临时目录和私有沙箱仓。
