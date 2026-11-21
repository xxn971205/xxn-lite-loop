# 生命周期：配置继承、初始化、加入与一键拆架

## 一、本机永久记忆（三级覆盖，零侵入仓库）

所有长期配置保存在 `~/.config/dev-loop/`，**绝不提交到任何业务仓库，也不写入 `AGENTS.md`**。

```text
~/.config/dev-loop/
├── me.yaml                    # 第 1 级：个人默认偏好（模型、工作时段、汇报习惯）
├── projects/<group-slug>.yaml # 第 2 级：工程/工程组记忆（Forge、核心仓+关联仓、默认档位、验证命令、群配置）
└── runs/<req-slug>.json       # 第 3 级：单次需求临时运行态（teardown 时自动归档清理）
```

合并优先级：**本次需求确认覆盖 > 工程组档案（`projects/<slug>.yaml`）> 个人偏好（`me.yaml`）> Skill 默认值（`tiers.md`）**。配置文件支持受限 YAML 子集（标量、嵌套对象、单行内联对象含引号键、列表；非法行带文件名与行号直接报错）以及完全等价的 `.json` 格式（`me.json`、`projects/<slug>.json`）。

### 关键配置字段

- `me.yaml`：
  - `workHours`: 如 `09:00-19:00` + `timezone: Asia/Shanghai`
  - `roleModels`: 抽象角色映射（`controller` / `planner` / `coder` / `selfReviewer` / `patrol` / `finalReviewer` / `leadPatrol`），未配置时自动读运行时环境（如 T3 `pstack-t3.json`）或探测可用模型。
  - `selfReview`: 个人默认是否自审（协作者默认开、主研发默认关）；开发与自审优先跨厂商模型。
- `projects/<group-slug>.yaml`：
  - `forge`: `gitlab` 或 `github`（私有 GitLab 实例可显式指定 `hostname: gitlab.example.com`）
  - `hubRepo`: 核心仓（`id` 或 `owner/repo`、本地路径、默认主干分支 `main/master`、提交前缀正则）
  - `linkedRepos[]`: 0..K 个关联仓（名称、repo 标识、本地路径、默认主干）
  - `defaultTier`: `L1` / `L2` / `L3`
  - `branchTemplate`: 可选需求基线命名模板（如 `feature_2611B_{slug}` 或 `loop/{slug}`；未配时默认 `loop/<req-slug>`）
  - `protectedEnvBranches`: 可选受保护环境分支规则列表（内置保底精确匹配 `["main","master","test","uat"]`，支持追加精确名、`*` 通配符如 `release/*` 和 `/正则/` 如 `/^feature_\d{4}[A-Z]?_(test|uat)$/`；硬禁止自动合入，且非主干环境分支严禁反向合入需求基线）
  - `verification`: `{ mode: "isolated-build" | "local-test" | "hybrid", commands: { "<repo>": "<校验命令>" } }`
  - `notify`: 可选外部渠道（如 `feishuGroupChatId`、`dailyReportEnabled: true|false`、`dailyReportTime`、`externalMentionWindow`、`externalNotifyDisabled: true|false` 一键静默外部推送但保留巡检与 Forge 评论、`memberOpenIds` 内部研发映射、`externalContacts` 外部接入方对接人映射——**所有 `open_id` 必须由发送通知的同一 bot 实查群成员获得，严禁手抄他人应用的 ID**）。

### 需求基线分支标准（来源、命名与单仓/多仓规则）

1. **来源优先级**：**本次确认单显式指定（`--branch <name>` 或口头指明复用已有需求分支）> 工程组档案 `branchTemplate` 自动推算（如 `feature_2611B_{slug}` 或 `loop/{slug}`）> 工程组显式配置的 `baselineBranch` > Skill 默认 `loop/<req-slug>`**。初始化确认单必展示最终生效的基线与合并方式，用户回复「确认」即锁定；若显式指定了受保护环境分支（如 `--branch main`），确认单直接显示「全人工合并」并硬禁自动合并。若仓内已有现成需求分支（例如团队提前拉好的迭代分支，或 L3 同事通过「加入」读取总台账），直接复用，不新建。
2. **受保护分支红线**：`main` / `master` / `test` / `uat` 及工程配置的 `protectedEnvBranches` **严禁直接作为自动合入基线**；需求基线必须从各勾选仓的默认主干（或用户显式指定的起始分支/提交）拉出独立分支。
3. **单仓与多仓同名规则**：勾选多个关联仓时，**默认所有参与仓使用同一个需求基线分支名**（如后端和前端均用 `feature_2611B_xxx` 或 `loop/xxx`），降低跨仓心智与脚本映射复杂度；仅当个别仓有强历史规范冲突时，才在确认单与运行态里按仓单独覆盖映射。
4. **L1 与 L2/L3 的基线形态**：
   - **L1（极轻单人小活）**：单 PR/MR 改动无需套两层分支，直接从主干拉一条功能分支（如 `loop/<req-slug>`）向主干提 PR/MR，跑完独立终审后由**人**合并到主干；只有拆成 ≥2 个子 PR 且开启低风险自动合入时，才以 `loop/<req-slug>` 为需求基线承接子 PR，最后由人合回主干。
   - **L2 / L3（多 PR/MR 或多人并行）**：必须建独立且唯一的需求基线分支；所有开发分支从需求基线拉出并终审后以 `merge commit`（禁 squash）合回需求基线，并可从 P2 起建「需求基线 → 主干」Draft 全量审阅 PR/MR。合入 `test/uat/main/master` 一律由人执行（L3 主干仅主研发合并）。
5. **新鲜度与冲突隔离**：拉开发分支前须 `baseline-check` 核实未落后远端（`fetch` 失败直接阻断，不假报对齐）；合入环境分支遇冲突时，从需求基线拉冲突解决分支仅向目标环境提单，**严禁将环境或冲突分支反向合回需求基线**。

## 二、一句话启动初始化（`init`）

### 零配置冷启动向导（首次使用，绝不让用户手写 YAML）

当 `loopctl.mjs status` 报告 `needsOnboarding: true`（本机缺少 `me.yaml`，或当前目录所属工程未命中 `projects/*.yaml|json`）时，**绝不把 YAML 模板甩给用户手填，也不要分 7–8 轮零碎盘问**，按 3 步 1 分钟完成：

1. **先静默探测（能猜到的绝不问）**：
   - 检查本机 `node -v`（20+）、`git`、`glab` / `gh` 登录态；
   - 读当前目录 `git remote -v` 与默认主干，自动推断 `forge`（`gitlab`/`github`）、私有 `gitlabHost`、`hubRepo`；
   - 扫描仓库根目录（`pom.xml`、`package.json`、`pyproject.toml`、`go.mod`、`AGENTS.md`）推断默认校验命令草案；
   - 探测宿主默认模型配置（如 T3 `~/.claude/pstack-t3.json`）。
2. **一次合并问清 4 题（全部给出推荐默认值，用户回「默认」即可直接通过）**：
   - **Q1 你的称呼与工作时段**：默认取 git 用户名、`09:00-19:00 Asia/Shanghai`（非工作时段自动循环只心跳不写码）。
   - **Q2 是否多仓联动**：默认单仓（当前目录）；如前后端/多服务联动，回复关联仓路径或名称即可。
   - **Q3 本工程校验能力与默认严格度**：本工程本地能不能直接起服务自测（`local-test` 本地能跑 / `isolated-build` 只能隔离编译 / `hybrid` 多仓混合）+ 平时默认按哪档起手（`L1` 个人小活 / `L2` 个人复杂多仓 / `L3` 多人协作）。
   - **Q4 写码后是否默认开跨模型自审**：默认开启（个人单干或主研发可按喜好关闭）。
3. **自动落盘并顺滑接续需求**：
   - 由 AI 自动写出 `~/.config/dev-loop/me.yaml` 与 `~/.config/dev-loop/projects/<slug>.yaml`（均支持 `.json` 等价格式）；
   - 立刻运行 `loopctl.mjs config-resolve --project <slug>` 校验配置无误；
   - **直接衔接输出本次需求的 6 行确认单**，不让用户重新发一遍需求。

收到用户一句需求（或贴设计稿链接）时，按 4 步完成启动：

1. **识别环境与工程组**：
   - 检查本机 `node`（20+）、`git` 及 `forge` CLI（`glab` / `gh` 登录态）与所需能力（L2/L3 自动循环需支持定时任务与自动新开会话并指定模型；不满足则停下提示换环境，不静默降级）。
   - 自动探测当前目录 git remote，命中 `~/.config/dev-loop/projects/` 直接载入记忆；首次遇到的工程则探测关联仓与构建命令，生成工程组记忆供下次复用。
2. **需求分诊与快速澄清**：
   - 若用户自带完整设计稿 → 直入 P2（L3）或 P3（L1/L2）；
   - 若用户只说了一句话且关键边界清晰 → 直接给简版五项（L1）或拆 1–3 个步骤；
   - 若需求存在阻断歧义 → 先列 2–4 个具体问题快速澄清（P0），不瞎猜。
3. **一次合并确认单（固定确认点）**：
   - 调用 `node <skill>/scripts/loopctl.mjs preview-init --req <slug> --project <slug> [--tier L1|L2|L3] [--repos a,b] [--branch <br>] [--stage P0|P1|P2|P3]` 输出极简确认单，确认对象与后续 `init` 完全共用同一规范（核心仓身份固定、拒绝未知仓名），等用户回复「确认」。
4. **一键搭脚手架并进首轮**：
   - 调用 `forge.mjs labels-sync --forge ... --repos ... --labels ...` 同步勾选子仓的实际档位标签集（兼容 GitHub 无 Group 级标签，默认只补缺不覆盖已有共享标签颜色）；
   - 按档位用 `forge.mjs issue-create` 在 `hubRepo` 创建台账 Issue（L1 建 1 个；L2 建主台账；L3 初始化建 3 个：总台账 + 主研发小台账 + 升级 Issue，其余协作者加入时建各自小台账）；
   - 运行 `loopctl.mjs init --req <slug> --project <slug> ...` 原子写入临时运行态 `~/.config/dev-loop/runs/<req-slug>.json`（持久化 `forge`/`autoMerge`/`baselineBranch`/`protectedEnvBranches`，重复 `init` 需显式 `--resume` 绝不静默覆盖）；
   - L2/L3 按稳定任务 ID 建定时任务并各自触发首轮验证一次（非 ASCII 需求名/用户名自动附加短 hash 防撞名；L3 个人任务指向个人小台账，日报仅 `dailyReportEnabled: true` 时创建）：
     - `liteloop-<req>-<user>-controller`
     - `liteloop-<req>-<user>-patrol`（静音小巡检）
     - L3 主研发另建 `liteloop-<req>-<user>-dispatch`、`liteloop-<req>-<user>-lead-patrol`、可选 `liteloop-<req>-<user>-lead-daily`。

> **定时任务描述硬规则**：只写「角色入口一句话 + 本机必需路径/仓库/台账编号/会话标识」，**绝不写入规则正文、当前阶段、当前 Issue、契约版本或模型配置**；末尾固定写「阶段、当前任务与版本以台账为准，个人配置以本机与台账配置为准」。

## 三、加入已有 L3 团队需求

同事在本机装好 `xxn-lite-loop` 后，只需说「加入 `<总台账链接>`」：

1. 用 `forge.mjs issue-get` 读取总台账，查当前未被绑定的槽位（如 `槽位A`），若已有本人绑定记录则复用旧小台账（视同本人主动接管，接管前先关旧会话）。
2. 结合同事自己的 `~/.config/dev-loop/me.yaml` 与实测可用模型，一次合并询问槽位、工作时段、是否自审、可选确认点，输出确认单等回复「确认」。
3. **先抢槽、再建台账（防残留小台账）**：确认后先在总台账用 `forge.mjs issue-comment` 发 `【配置变更】` 绑定评论，立刻调用 `forge.mjs issue-comments --forge <f> --repo <hubRepo> --id <总台账ID>` 拉取含数字 `id` 的完整评论流，再运行 `loopctl.mjs slot-claim --slot <槽位> --input '<claims JSON>'` 判定归属（按槽位过滤，以最早未撤回绑定、同秒按数字评论 ID 升序为准）。
4. 若判定冲突，不改旧评论，追加 `【配置变更】撤回绑定：槽位｜原评论链接｜冲突` 并停下联系主研发，绝不建空小台账或覆盖他人指派。
5. 取得无冲突绑定后，在 `hubRepo` 建本人小台账、补记小台账链接、将本槽位标签子 Issue 指派给本人，建立绑定个人小台账的个人主控与静音小巡检并完成首报。

## 四、聊控分离与计划交接

- **聊控分离**：任何需求探讨、方案讨论、私有文档起草，一律在**普通独立会话**进行；主控窗口只接收定稿结论或文档链接，专职落 Forge 台账、子 Issue、派活与提交 PR/MR。
- **计划交接（L2/L3 完成一个业务子 Issue 一律换新主控）**：
  1. 旧主控当前步骤写「已完成」，本轮改「空闲」；
  2. 自动新开同模型主控会话取得新标识；
  3. 在小台账发 `【交接】第 N 任（旧标识）→ 第 N+1 任（新标识）`，附上一 Issue 计划与结果归档；
  4. 旧主控停用自身定时任务，新主控按接任规则写标识并建自己的定时循环。

## 五、收尾拆架（`teardown`）与条件触发机制复盘（`retro`）

需求合入主干（或确认中止）后，先按客观门槛决定是否复盘，再执行两步拆架，**绝不在外部清理完成前提前删掉活动 run**：

0. **可选前置：条件触发纯机制复盘（`loopctl.mjs retro --req <slug> --input '<客观统计JSON>'`）**：
   - **顺风小单绝不打扰**：仅当命中客观门槛（L3 多人 / MR ≥ 6 / 历时 ≥ 3 天 / 存在 `k≥2` 熔断打回 / 首次过审率 < 60% / 同类纠偏 ≥ 2 / 发生阻塞超时、卡住失联或冲突 / 使用过本次临时规范）或用户显式传 `--force` 时才触发；
   - **只复盘 Loop 推进机制，绝不干涉个人写码风格/测试写法**：输出最多 3–5 条精炼提案，精准分流至「调本机/工程参数」「补工程门禁配置」「脱敏 Skill 级 Issue 提案草稿」；
   - **严格人工拍板**：AI 永不静默修改规则或自动发 Issue；用户逐条确认后才回写本机配置，或提交脱敏 Issue 到维护仓库。

1. **第一步：预检出清单（`loopctl.mjs teardown --req <slug> [--live <实时Forge快照JSON>]`）**：
   - 先用 `forge.mjs change-list` / `issue-get` 采集各勾选子仓最新未结 PR/MR、未关阻断与协作者小台账，通过 `--live` 传入实时事实覆盖过期本地快照（无需为同步最新状态加 `--force`），同时核对本机及他机定时任务清单与临时 worktree 真实 git 状态（`git status` 失败标 `unknown`，绝不假报干净）；
   - 若仍有未结项且未传 `--force`，停下先请本人确认；**此时保留 `runs/<req>.json` 不删**。
2. **第二步：逐项执行外部清理**：
   - 停删本机全部关联定时任务（L3 协作者机器的已认领槽位任务须提供负责人的停用回执）；
   - 清理确认可删的临时 worktree（带未提交改动或 `unknown` 状态须显式核验或写明保留原因）；
   - 用 `forge.mjs issue-comment` 写完结摘要评论并用 `forge.mjs issue-close` 关闭全部台账；全量审阅 Draft PR/MR 由主研发本人转正合并或关闭。
3. **第三步：核验并最终归档（`loopctl.mjs teardown --req <slug> --finalize --results <json>`）**：
   - 强制要求传入 `--results`，按对象类型逐项校验回执（本机任务须 `stopped:true`、协作者已认领任务须 `stopped:true` 且带 `confirmedBy`、台账须 `closed:true`、worktree 须 `removed:true` 或带原因 `keep:true`），全部通过才原子归档 `runs/<req>.json` 至 `runs/archive/`（保留 `me.yaml` 与 `projects/` 记忆）；存在保留项或 `--force` 豁免时如实标 `zeroResidue: false` 并记明细；任一步失败均保留活动 run，修复后按原 `--req` 幂等重试。

## 六、随时查进度与下一步引导（`status` · 只读不改状态）

用户做到一半忘了下一步该干嘛、或想看当前有哪些运行中的需求时（如「`$xxn-lite-loop` 现在什么进度 / 我接下来干嘛」）：

1. 运行 `node <skill>/scripts/loopctl.mjs status [--req <slug>]`（纯只读，不改动任何运行态或台账）。
2. 若存在未完成的 `pendingUpgrade` 或 `pendingTeardown`，优先提示把半程升档/拆架收完并给出对应命令；若 `needsOnboarding: true`，直接转入「零配置冷启动向导」。
3. 结合对应台账正文，只用 **3 句话大白话** 回复用户：① 当前在哪个档位/阶段、有没有卡点 ② 需要你本人做什么（或目前无需动手）③ 下一句可以直接复制发送的口令（如继续推进、升档或收尾拆架）。
