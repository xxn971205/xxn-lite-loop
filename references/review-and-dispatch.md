# 独立终审与合入

## 送审前

- 围绕用户确认的业务流程、交互和契约改。保留存量接口、表和消息的兼容性。开关关闭时保持原有业务行为。
- 按工程档案的 `verification.mode` 交证据。`isolated-build` 交编译、约定的隔离测试和人工冒烟步骤。`local-test` 交受影响测试与实际运行证据。`hybrid` 同时交构建测试和关键路径实测。
- 用 `forge.mjs change-create --req <slug>` 建单。PR/MR 正文关联需求子 Issue 或 L1 追踪 Issue。跨仓写完整引用。写明契约版本、公共文件变更、外部接口或 SDK、验证、兼容与回退。叠加单写 `Depends-On: <repo!id 或 repo#id>`。非持有者在公共文件末尾追加时写明原因。
- 开发前用 `forge.mjs baseline-check` 检查远端。无冲突就在原候选分支追加提交。与需求基线确实有冲突时才在原候选分支上 rebase 到最新基线，用 `git push --force-with-lease` 更新；候选分支只归开发本人，已合入基线的历史不改写。解决冲突后标「待终审」重新送审，候选 SHA 变化会作废原终审。禁止把基线 merge 进源分支，否则会被 `SOURCE_CONTAINS_MERGE_COMMITS` 拦下。需求基线用 merge commit 保留审阅轨迹。

## 独立终审

每个 PR/MR 的每轮终审用新会话，优先独立子代理和跨厂商模型。L1/L2 用 `--role controller`，L3 只由主研发调度用 `--role dispatch`。收到 `review-dispatch` 后按引用读取固定候选，为将启动的独立终审分配一个新会话标识，再登记派审。

```bash
node scripts/forge.mjs dispatch-review --run "$run_file" --role "$role" \
  --forge "$forge" --repo "$repo" --id "$change_id" --head-sha "$head_sha" \
  --session "$review_session" --by "$dispatch_session"
```

L3 的 `--by` 必填，传派审方调度会话的实际标识，供公开评论签名。`--session` 传新终审会话的标识。L1/L2 主控可省略 `--by`，脚本用台账第 1 节的主控标识签名。

自建 Forge 实例在 `dispatch-review` 和 `verdict` 中都传运行态对应的 `--hostname`。`dispatch-review` 写入本机登记簿、发布派审评论并切换到「终审中」。

用 `loopctl.mjs brief` 生成任务说明，另附 `dispatch-review` 返回的 `dispatchId`、`nonce`、`round`、`headSha` 和 `session`。nonce 只交独立终审。终审在派审方本机运行，重读 PR/MR 确认候选 SHA 后发一次结论。

必改项和遗留建议须标明等级（P0/P1/P2），能从支持的业务入口触发，并有源码调用链或运行证据。写清用户实际看到什么、期望是什么、为何受影响。风格偏好或缺乏可达入口的疑点留作线索，不评级、不打回。前 2 轮为深审，问题尽量一次挖透；普通复审核必改项和直接影响；叠加单只审前置提交之后的 diff。累计打回达到 `rejectFuseCount`（默认 2）后，派审动作标 `fullReReview` 时仍做全量复审，但只就 P0、P1 打回，P2 改写到 `--remaining`（只剩 P2 时给「通过」并带遗留建议，通过后仍交人裁决）。

发布前填写实际轮次、派审时的完整 SHA 和本会话标识。下面是六项均已核验且均未命中时的命令。

```bash
node scripts/forge.mjs verdict --run "$run_file" --dispatch-id "$dispatch_id" --nonce "$nonce" \
  --forge "$forge" --repo "$repo" --id "$change_id" \
  --round "$round" --conclusion 通过 --head-sha "$head_sha" --session "$review_session" --slot "$slot" \
  --risk contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0
```

命中的风险项填 `1`。六项依次是改契约或对外接口、改删公共热点或其他槽位文件的已有内容、表结构或存量数据迁移、改开关默认值或关闭时的存量逻辑、改其他槽位或关联仓使用的方法签名、改地基或公共构建配置。文件末尾追加需声明。按需要加 `--must-fix "$must_fix"`、`--remaining "$remaining"` 和 `--keep "$keep"`。

用 `--conclusion 打回` 时须传 `--must-fix`。按行首编号或 `- ` 分条，每条须以 `【P0】`/`【P1】`/`【P2】`（也接受 `P0：` 等写法，脚本归一成 `【P0】`）开头并填实「入口：」和「证据：」，规则见 [终审角色](roles.md#final-reviewer)。字段缺失或仅有 Markdown 强调符时报 `MUST_FIX_INCOMPLETE`，缺等级报 `MUST_FIX_GRADE_MISSING`，熔断后必改项含 P2 报 `MUST_FIX_P2_AFTER_FUSE`，结论均不落地。「通过」结论只能省略 `--must-fix` 或填「无」（否则报 `PASS_WITH_MUST_FIX`）。通过与打回均可传 `--remaining` 登记遗留建议（可选，默认「无」）；遗留建议同样按条带等级、入口和证据，仅允许 P2，出现 P0/P1 报 `REMAINING_GRADE_TOO_HIGH`，与必改项重复报 `DUPLICATE_REVIEW_ITEM`，不阻塞合入，只计入终审评论和归档指标。

```bash
must_fix=$(cat <<'EOF'
1. 【P0】订单提交空商品列表时返回 500，期望返回 400 并提示商品不能为空
   入口：下单页点击「提交」→ POST /api/orders
   证据：src/order/create.ts:42 直接读取 body.items[0].sku 未判空，传入 {"items":[]} 抛出 TypeError
2. 【P1】取消订单后库存未回滚，导致可售数持续偏低
   入口：订单详情点击「取消订单」→ POST /api/orders/:id/cancel
   证据：src/order/cancel.ts:18 仅更新订单状态，未调用 inventoryService.release
EOF
)
remaining=$(cat <<'EOF'
1. 【P2】空态文案未区分无权限与无数据
   入口：订单列表页 GET /orders
   证据：src/order/list.tsx:18 统一渲染「暂无数据」
EOF
)
node scripts/forge.mjs verdict --run "$run_file" --dispatch-id "$dispatch_id" --nonce "$nonce" \
  --forge "$forge" --repo "$repo" --id "$change_id" \
  --round "$round" --conclusion 打回 --head-sha "$head_sha" --session "$review_session" --slot "$slot" \
  --risk contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0 \
  --must-fix "$must_fix" --remaining "$remaining" --keep "保留原有支付回调签名校验逻辑"
```

命令先核对本机当前派审、nonce、轮次、会话和 Forge 上的完整 head SHA，再登记结论、发审计评论。发布失败时，下次 `tick --apply` 补发。也可用 `forge.mjs verdict --republish --run <运行态路径> --forge <forge> --repo <repo> --id <变更编号> --dispatch-id <派审 ID>` 补发已登记的正文。评论仅供审计，合入由同一次 `verdict` 按本机登记和实时门禁决定。

## 结论分流与人工决定

打回时 `verdict` 标「需修改」。通过并满足门禁时，`verdict` 带候选 SHA 当场合并。源分支包含相对基线新增的 merge commit 时标「需修改」。在原候选分支用 `git rebase origin/<需求基线>` 变基到最新需求基线（默认不保留 merge commit），仅保留本次需求提交，再用 `git push --force-with-lease` 更新原 PR/MR 后重送，保留打回次数和升档依据。出现未合入的前置依赖或临时故障时，标「待合并」并登记等待自动重试。全人工模式、高风险、熔断或其他分支门禁拒绝合并时交人处理，命令输出原因。没有本机派审登记的「通过」评论只能交人工核对。

`local-test` 的合并前试合在全新临时检出里合并已核对的基线和候选 SHA，验证命令需自带依赖安装步骤。通过后，脚本在请求平台合并前再次核对远端基线。基线变化时返回 `TRIAL_BASE_MOVED`，下一轮 `tick` 用新基线重新试合。再次核对到平台执行合并之间仍有短暂的竞争窗口。平台排队会延长这个窗口。合入日志和评论保留试合时的基线证据。

L1/L2 由主控运行 `loopctl.mjs tick --req <slug> --role controller --apply`。L3 由主研发调度运行 `loopctl.mjs tick --req <slug> --role dispatch --apply`。脚本安排派审、超时重派、补发审计评论，并按本机等待记录重试合入。L1 默认手动触发。打回次数取本机与 Forge 有效打回评论数的较大值，派审轮次和已用会话仍保留 Forge 历史记录。

- 提交方按有效打回结论在原分支追加修改，逐条回执，再打「待终审」开启新轮。超时或候选变化后重新派审，轮次取本机及 Forge 已见最大轮次加一。
- 全量重审待裁决时，在个人或总台账相应待办找到变更单。由本人或 L3 主研发裁决继续修改、手工接受合并，或拆分后重审。用 `forge.mjs reply` 落对应裁决。
- 自动合入实查候选提交、目标分支、前置依赖、需求 Issue 归属和 Git 提交来源。仓级合并策略须允许 merge commit。需要手动触发已登记的自动重试时，用 `forge.mjs change-merge --head-sha <sha> --target <基线> --run <运行态文件>`，沿用同一门禁。
- `change-merge` 省略 `--run` 时只预览命令。
- 合并方式见 `status` 首段。在运行中用 `loopctl.mjs merge-mode --req <slug> --manual|--auto` 切换，确认单阶段按 [合并方式](lifecycle.md#合并方式) 修改。
- 生产主干和公共环境分支由人合入，L3 主干由主研发合入。从生产主干同步回需求基线也须人确认。环境分支和环境冲突解决分支禁止反向并入需求基线。冲突时从需求基线拉分支，仅向目标环境提单；门禁由 `change-create`、`change-merge` 执行。
- L2/L3 可从地基阶段起按仓建「需求基线 → 主干」Draft PR/MR，供主研发看完整 diff。合并冲突按送审前的基线流程解决，然后按对应范围复审。

## L3 主研发调度

先跑 `node <skill>/scripts/loopctl.mjs tick --req <slug> --role dispatch --apply`，无输出即结束本轮。看到 `facts-error` 时说明读取或核验失败的来源，暂停依赖该事实的动作。遇到 `needsLlm: false` 只记录脚本回执。

收到 `review-dispatch` 时用 `--role dispatch --by <本调度会话标识>` 登记派审，留下轮次、独立终审会话标识和候选 SHA。终审用 `verdict` 当场处理结论，跨槽位基线通知和总台账事实计数由 `tick` 执行。调度会话只负责派审，槽位业务交各自主控，切阶段和裁决交主研发。
