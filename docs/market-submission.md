# 插件市场上架

**状态：PR 已提交，CI 全绿，等待维护者合并**

- PR: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9102
- 标题：`Add zhujiuyi/dsh-mcpserver-manager (tools)`
- CI: `check` = **SUCCESS**（2026-10-24 14:49 +08），13 个步骤全部通过
- PR 状态：`mergeable: clean`，改动 1 个文件（+6 行）

## 事实

| 项目 | 值 |
|---|---|
| 仓库创建 | 2026-10-23 12:15 +08 |
| 满 24 小时 | 2026-10-24 12:15 +08 |
| 实际提交 | 2026-10-24 14:40 +08（26.4 小时） |
| npm | `@zhujiuyi/dsh-mcpserver-manager@0.3.2`（latest） |
| 分类 | `tools` |
| topic | `dsh-plugin`、`mcp`、`deepseek-harness` |

## 提交内容

单个文件 `data/plugins/zhujiuyi__dsh-mcpserver-manager.yml`（+6 行）。
README 是生成的，PR 不碰它——CI 在 runner 里重新生成后校验。

## CI 本地复现

提交前在本地核对了 CI 会跑的全部检查，避免推到远端才发现问题：

| CI 步骤 | 本地结果 |
|---|---|
| Stale-fork guard | +1 / -0 |
| 所有文件以 .yml 结尾 | 通过 |
| 条目位于 `data/plugins/<owner>__<repo>.yml` | 通过 |
| README 与 data 一致 | 重新生成 6705 条，本条目已在双语 README 中 |
| awesome-lint | 通过（本地 Windows 路径报错是环境问题，CI 上正常） |
| added-dates / capabilities / adopt-discussions / entries-path | 3/9/9/3 全部通过 |
| Build (locale parity) | 6705 行 × 2 语言，通过 |

## PR 描述要点

强调与其他同类插件的差异——市场已有 9 个 MCP 管理类条目，其中几个覆盖
了「列表 + 增删改 + 状态」。本插件的差异：

1. **保存前静态预检**：可执行文件缺失、把包名当命令、`${VAR}` 未展开、
   工作目录是文件、URL 缺路径。只有 error 阻止写入且可覆盖；纯静态，
   不启动进程、不开 socket、不执行粘贴内容。
2. **写入保真**：就地替换而非追加覆盖行；`!!js` 表达式与注释逐字节保留。
3. **编辑即配置文本**：预填配置文件真实内容，两种格式可编辑，往返不丢字段
   （`!!js cwd`、`toolCallTimeoutMs` 均保留）。

## 如果 CI 变红

常见原因是上游 main 的其它条目导致 YAML 解析失败。处理方式：

```bash
cd %LOCALAPPDATA%\Temp\awesome-dsh
git fetch origin main
git checkout -B add-mcpserver-manager origin/main
# 重新放回 data/plugins/zhujiuyi__dsh-mcpserver-manager.yml
git add data/plugins/zhujiuyi__dsh-mcpserver-manager.yml
git commit -m "Add zhujiuyi/dsh-mcpserver-manager (tools)"
git push fork add-mcpserver-manager --force-with-lease
```

## 备注

- 首次尝试（定时任务触发）在开 PR 那步中断，未产生 PR；复核后重建分支重推，
  未产生重复 PR。
- GitHub GraphQL 接口在本机不稳定（`EOF`），全程改用 REST API。
