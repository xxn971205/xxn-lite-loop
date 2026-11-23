# 启动、加入、交接与拆架

## 本机配置

默认配置在 `~/.config/dev-loop`。隔离演练用 `XXN_LITE_LOOP_CONFIG_DIR` 或每条命令传 `--config-dir`。下文的 `node scripts/…` 命令从 LiteLoop 检出目录运行，`hubRepo.path` 指向业务仓的本地目录。所有配置和运行记录放仓外，业务仓库沿用自己的 `AGENTS.md`。

| 对象 | 内容 |
| --- | --- |
| `me.yaml` | 个人工作时段、角色模型、自审偏好和协作规矩。 |
| `projects/<slug>.yaml` | `forge`、`hubRepo`、`linkedRepos`、默认档位、验证方式、分支规则与可选飞书设置。私有 GitLab 用 `hostname`。GitHub Enterprise 的 `doctor` 也使用该字段。 |
| `runs/<req>.json` | 这次确认的配置、会话和定时任务、台账与清理对象。工作过程看 Git 平台。 |

下面是一套 GitHub 单仓 L1 配置。按实际情况替换用户名、模型标识、仓库名、已克隆的本地绝对路径和验证命令。验证命令的键 `demo` 与 `hubRepo.name` 一致。

### `me.yaml`

```yaml
user: demo-user
workHours:
  start: "09:30"
  end: "18:30"
  timezone: Asia/Shanghai
roleModels:
  controller: antigravity/gemini-4-neon
  coder: antigravity/gemini-4-neon
  selfReviewer: magpie_codex/gpt-6.2-sol
  finalReviewer: magpie_codex/gpt-6.2-sol
  patrol: antigravity/gemini-4-hydrogen
selfReview: true
# 可选，L2/L3 定时任务的间隔，单位为分钟。
thresholds:
  controllerLoopMinutes: 10
  smallPatrolMinutes: 20
```

### `projects/demo.yaml`

```yaml
forge: github
defaultTier: L1
hubRepo:
  name: demo
  repo: example-org/demo
  path: /work/demo
  branch: main
verification:
  mode: local-test
  commands:
    demo: npm ci && npm test
```

个人和工程档案可用受限 YAML 或 JSON。运行 `node scripts/loopctl.mjs config-resolve --project demo`，预期退出码为 0，输出中的 `meFile`、`projectFile` 指向上面两个文件，`hubRepo`、`verification` 和 `roleModels` 与实际配置一致。用了隔离目录时，为这条命令和后续命令传入同一个 `--config-dir`，或设置 `XXN_LITE_LOOP_CONFIG_DIR`。

`config-resolve` 也会列出三层 `rules` 的生效结果。编码规范在仓库 `AGENTS.md`。飞书群和同一机器人实查的成员映射通过 [巡检窗口](patrol-and-notify.md#用户窗口) 设置。

## 第一次用时问四题

先查 Node.js 20+、Git、`gh` 或 `glab` 登录态、当前 remote、默认主干、构建验证命令和宿主可用角色模型。L2/L3 必须能建定时任务和独立会话并指定模型。用 `loopctl.mjs doctor` 检查，环境缺能力时告诉用户具体缺什么。

缺少个人或本工程档案时，一次问四题，每题给出可用默认值。用户可回答「按默认」。

1. 你怎么称呼、什么时段工作。默认 Git 用户名与 `09:00–19:00 Asia/Shanghai`。
2. 哪些仓一起改。默认当前仓，多仓用路径或名称确认。
3. 本机怎么验、平时用哪档。按工程现状建议本地运行（`local-test`）、隔离构建（`isolated-build`）或混合验证（`hybrid`），以及 [L1、L2 或 L3](tiers.md)。选 `local-test` 时逐仓确认试合命令，写入 `verification.commands`。命令在全新检出里执行，需自行安装验证依赖，例如 `npm ci && npm test`。跳过试合时写明 `verification.skipReason`。旧工程档案也需要补配，否则新需求执行 `init` 时会报 `MISSING_VERIFICATION`。
4. 写完代码后是否默认做跨模型自审。默认开启。

AI 写本机档案，跑 `config-resolve` 确认可读，当轮接上需求确认单。

## 一句话启动

1. 用户给需求或定稿链接后，按 [档位](tiers.md) 找到入口。需求有阻断歧义就集中问清。已有定稿的 L3 可从地基与契约开始，L1/L2 可直接排开发。
2. 用 `loopctl.mjs preview-init --req <slug> --project <slug> --tier <L1|L2|L3>` 出六行确认单。有明确基线、仓范围或起点时传对应参数。本页 L1 示例直接送审到 `main`，预览时加 `--branch main`。核对目标、验证方法、模型、定时任务及第 6 行的合并方式，等用户确认再创建对象。
3. L1 单变更单从主干拉功能分支，终审后由本人合回主干。L2/L3 按确认单建立独立需求基线，默认用 `loop/<slug>`，开发从该分支开始。多仓默认用同名基线。已有且已确认的分支直接复用。
4. 按以下顺序建台账。示例沿用上面的 `demo` 工程。
   1. **出计划。** 运行 `node scripts/loopctl.mjs init --req demo-task --project demo --tier L1 --branch main --session "$session_id"`，其中 `session_id` 是当前主控会话标识。沿用确认单里显式指定的基线和其他参数。脚本写入本地运行记录，并在 `forgePlan.issueCreates` 给出待建台账的 `key`、`title` 和完整 Markdown `body`。
   2. **建 Issue。** 用 `forgePlan.labelsSync.args` 调用 `forge.mjs` 补标签。然后逐条把计划里的 `title` 和 `body` 原样作为参数传给 `node scripts/forge.mjs issue-create --req demo-task --forge github --repo example-org/demo --title "$title" --body "$body"`。仓库取实际核心仓。计划带 `labels` 时也传给 `--labels`。GitHub 的新 Issue 链接在输出 `stdout`，GitLab 的编号和链接在 `json.iid` 和 `json.web_url`。把每个 Issue 与计划里的 `key` 对上。带 `--req` 建子 Issue、bug 和 PR/MR，脚本会加成员标签并登记。存量对象按确认的归属补成员标签或补登记。
   3. **回填编号。** 假设 GitHub 返回 Issue #42，执行 `node scripts/loopctl.mjs init --req demo-task --resume --issue-map '{"tracking":{"id":"#42","url":"https://github.com/example-org/demo/issues/42"}}'`。用实际编号和链接替换示例值。L2 用计划里的 `main`，L3 按计划逐个回填。检查 `run.issues` 已绑定，`forgePlan.issueCreates` 为空。若 L3 总台账第 3 节的主研发小台账仍显示「待建」，用 `issue-update` 写入小台账链接。中途退出可以用 `init --req demo-task --resume` 读回计划，先核对 Forge 上已创建的 Issue 再补剩余项。同一编号可重复回填。
5. 取回填后的 `scheduledTasks`，在宿主创建会话和任务，首轮核对命令和实际绑定。任务描述用脚本生成的内容，阶段、当前任务与契约从台账读。L1 默认手动推进，L3 的日报在大巡检任务里。

## 合并方式

用户说「合并改成全人工」或「改成自动合并」时，启动前带 `--overrides '{"autoMerge":false}'` 或 `--overrides '{"autoMerge":true}'` 重新运行 `preview-init` 出确认单，确认后带相同参数运行 `init`。L1 明确拆成多个变更单并建立独立需求基线时才开启。

运行中用 `loopctl.mjs merge-mode --req <slug> --manual` 切全人工，用 `--auto` 开启低风险自动合并。受保护基线拒绝开启。命令在本人台账留下【配置变更】评论，`status` 首段显示当前方式。开启后，`verdict` 对符合门禁的变更当场合并。

## 迁移以前的定时任务

在 v2.0 到 v2.1 的迁移中，核对现存的主控、小巡检、调度、大巡检任务。逐项保留已有任务 ID、周期、会话、台账绑定与启停状态，更新描述，让唤醒首句执行 `tick --req <slug> --role <本角色> --apply`。主控任务加 `--session <该任务绑定的主控会话标识>`。用 [主控](controller.md)、[调度](review-and-dispatch.md#l3-主研发调度) 或 [巡检](patrol-and-notify.md) 入口核对首句。旧 `lead-daily` 任务停用，日报设置沿用到 `lead-patrol`。核对宿主里的描述和启停状态，在运行态记录对应描述与旧日报任务已停用。日常「开工」恢复四类角色任务。

## 加入已有 L3

1. 用户发总台账链接。用 `forge.mjs issue-get` 读可认领槽位。已有本人绑定就复用小台账，接管前先关掉旧主控会话。
2. 一次确认槽位、工作时段、自审与可选确认点。
3. 用 `forge.mjs issue-comment` 在总台账发布绑定评论。首行用实际槽位和本主控的会话标识。

   ```text
   主控 ｜ A ｜ <会话标识>
   【配置变更】绑定 槽位A｜<用户名>｜<会话标识>
   ```

   首次加入时运行 `loopctl.mjs slot-claim --req <slug> --slot A --master <总台账完整链接> --session <会话标识>`。本机已登记该需求和现任会话时，运行 `loopctl.mjs slot-claim --req <slug> --slot A`。脚本核对 Forge 登录账号和总台账上的绑定。换会话时，同一账号可以复用小台账，先发新绑定，再用 `withdrawalComment` 和新会话签名撤回旧绑定，最后重新核对胜出绑定。收到 `withdraw-binding` 时，用命令输出的 `comment` 在总台账追加撤回记录，联系主研发。
4. 绑定生效后，在本人机器执行 `loopctl.mjs init --req <slug> --project <工程> --tier L3 --slot <本人槽位> --session <主控会话标识> --issue-map <台账编号JSON>`。编号 JSON 先填已存在的台账，例如 `{"master":"#5"}`。按计划建本人小台账时带 `--req` 和本槽位标签，用 `init --resume --issue-map` 回填，再更新总台账链接和子 Issue 指派。按返回清单只启动绑定本人小台账的主控和小巡检，首轮汇报。

## 计划交接

L2/L3 主控核对合入并关闭业务子 Issue 后，记「已完成」和「空闲」。本槽位还有未完成的业务子 Issue 时换新主控。本槽位已全部完成时直接进入收尾。

需要交接时，新开同模型主控会话，取实际会话标识。旧主控在本槽位台账追加【交接】，写第几任、两边会话标识、上一项的验证与下一步，停自己的定时任务。新主控依 [接任规则](controller.md#按动作续接) 在台账第 1 节登记标识，再运行 `loopctl.mjs init --req <slug> --resume --session <新主控会话标识>`。脚本核对台账并返回 `scheduledTasks`，从中取主控任务描述创建新任务。旧任务若再次唤醒，收到 `SUPERSEDED` 后删除本会话的主控任务并结束。

## 出口验收

L2/L3 可在工程档案设置 `acceptance.enabled: true` 和 `acceptance.guide`。默认关闭。L1 不适用。业务子 Issue 全部关闭且各有已合入需求基线的变更单后，主控的 `tick` 可派发 `acceptance-dispatch`。L3 由主研发主控派发。各仓的缺陷 Issue 不计入这项派发判断。

用 `loopctl.mjs brief --run <run.json> --role acceptor --issue <主台账完整引用>` 生成任务说明。验收者按 [验收角色规范](roles.md#acceptor) 核对实际结果，并在报告中写明实测的基线 SHA。请人合入主干前，确认最新验收结论为「通过」，且覆盖当前远端需求基线。基线已变化时重新验收。

用 `forge.mjs acceptance --run <run.json> --conclusion 通过|不通过 --report <文本或链接> --model <模型> --session <id>` 发布。命令读取主仓的远端需求基线 SHA，写入主台账评论。多仓需求只绑定核心仓基线，关联仓基线单独前移不会要求重新验收。`tick` 按当前 SHA 判断是否已有结论。基线前移后，可在主控正常运行时重新派发。

## 两步拆架

需求由人合入主干或确认中止后执行。已开启 [出口验收](#出口验收) 时，归档前保留可核对的远端需求基线。复盘见 [复盘规则](roles.md#retro)。

1. **出清单并执行。** 执行 `teardown --req <slug>`。脚本在同一轮实查需求成员、未结变更、阻断、缺陷和需求基线当前 SHA。有 `forgeReadErrors` 时，按其中的来源和错误码核对缺失事实。按清单停删关联任务，收 L3 协作者的停用回执，核对临时 worktree 并清理或登记保留原因。在台账写完结摘要，再用 `issue-close` 关闭。全量审阅 Draft 由主研发本人合入或关闭。遇未结项、脏 worktree 或状态不明，先查清并请人决定如何收尾。
2. **核验并归档。** 按 `resultsTemplate` 提交回执，运行 `teardown --req <slug> --finalize --results <json>`。脚本到 Forge 核对本次和出清单时发现的台账是否已关闭。开启出口验收的整需求归档还要核对主台账评论 ID 最大的验收记录。结论须为「通过」，记录中的模型须与本机的 `coder`、`coderEscalation` 不同，记录的 SHA 须匹配当前远端需求基线。旧记录缺 SHA 时须补验收。遇 `ACCEPTANCE_REQUIRED` 时按返回原因处理，或由人明确传 `--waive-acceptance <原因>`，原因记入台账和归档。核验失败时保留运行态，修正后可重试。

L3 协作者在本机按清单清理自己的主控和小巡检任务、小台账和本机 worktree，再核验归档。主研发负责总台账、升级台账和其余槽位的核验与回执。
