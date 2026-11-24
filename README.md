# xxn-lite-loop

用一句话启动一个需求，在 GitHub 或 GitLab 上看到进度、独立终审和待你决定的事。合入后两步拆架，停本次任务、关台账、核验并归档。支持个人小需求 L1、个人复杂需求 L2 和多人协作 L3。

## 安装

需要 Node.js 20+、Git 和已登录的 `gh` 或 `glab`。

```bash
bash install.sh
# 可选安装本机防误推、误合提醒
bash install.sh --with-hooks
```

新开 AI 会话。首次运行会一次问四个问题并自动写本机档案。开始时核对确认单上的仓库、验证命令、模型和合入方式，回复「确认」。

升级到 v2.2 时，已有 `local-test` 工程档案需在 `verification.commands` 补上各仓试合命令，或用 `verification.skipReason` 写明跳过原因，否则启动新需求会报 `MISSING_VERIFICATION`。试合命令在全新检出里运行，需自行安装验证依赖。 [工程档案示例](references/lifecycle.md#projectsdemoyaml) 升级到 v2.3 起，终审打回的必改项必须标明等级（`【P0】`/`【P1】`/`【P2】`），熔断后只就 P0、P1 打回，P2 改写到 `--remaining` 遗留建议。

| 想做什么 | 对 AI 说 |
| --- | --- |
| 启动需求 | `$xxn-lite-loop 给这个工程加一个 Markdown 导出功能` |
| 加入团队需求 | `$xxn-lite-loop 加入 <总台账链接>` |
| 知道卡在哪 | 在巡检会话说「现在进度怎样，要我做什么？」L1 可问主控。 |
| 让更复杂的需求继续跑 | `$xxn-lite-loop 把当前需求从 L1 升到 L2` |
| 设置飞书通知 | 在巡检会话说「往 XX 群推送」或「别发群了」。 |
| 完成后关闭需求流程 | `$xxn-lite-loop 收尾拆架` |

## 查看记录

Git 上的台账和签名评论记录事实。开巡检会话问细节，或用 `node scripts/loopctl.mjs status --req <slug>` 看进度、待办、本机最近唤醒和巡检脚本评论。程序用 `--json` 取数据，加 `--live` 查代码平台实况。

每次定时唤醒先由脚本查台账和变更单。脚本完成机械检查，并把执行结果留在记录里。有需要判断的内容才交给相应会话。生产主干与公共环境分支由人合入。个人偏好和工程配置默认放在 `~/.config/dev-loop`。

角色入口、七条底线与按场景查找的文档在 [SKILL.md](SKILL.md)。使用反馈和脱敏的流程改进提案可走 Issue。 [贡献说明](CONTRIBUTING.md)
