# dsh-mcp-manager · DSH MCP 服务管理

DeepSeek Harness 插件：在一个页面里管理**所有已配置的 MCP 服务**——查看连接状态、每个服务提供的工具，用 dsh 片段或 Claude Code JSON 新增服务，并单独编辑某个服务的配置。

## 功能

- **服务清单**：读取 profile 组合后的 Loader 条目，列出每个 MCP 服务的 `serverName`、传输方式、端点与连接状态。
- **工具查看**：按 `mcp__<serverName>__<tool>` 命名空间归组，展开任一工具可看完整 input schema。
- **连接状态**：由 fiber 状态与已注册工具推导（connected / inactive / error / unknown），并给出推导依据。
- **新增服务**：粘贴 dsh 片段、`@mcp` 简写，或 Claude Code 的 `mcpServers` JSON，自动识别并转换；也可手动填表。
- **单独编辑**：只改当前选中服务的配置，其他服务不受影响。
- **启用 / 停用**：写 `disabled` 标志，保留配置但不启动。
- **删除服务**：移除该行；`- insert:` 块变空时一并清理。

## 两种导入方言

### dsh 片段（推荐，可直接复制现有配置）

```yaml
- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: "C:\\Users\\zhuji\\.dbx\\bin\\dbx-mcp.exe"
```

也接受简写：

```
@mcp linear
transport: http
url: https://mcp.linear.app/mcp
headers: Authorization=Bearer TOKEN
```

### Claude Code / Cursor JSON

```json
{
  "mcpServers": {
    "dbx": { "command": "C:\\Users\\zhuji\\.dbx\\bin\\dbx-mcp.exe" }
  }
}
```

JSON 会被转换成 dsh 认可的行，转换结果与上面 dsh 片段完全一致：

```yaml
- id: mcp-dbx
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dbx
    transport: stdio
    command: 'C:\Users\zhuji\.dbx\bin\dbx-mcp.exe'
```

## 写入策略

| 操作 | 机制 | 说明 |
|---|---|---|
| 改已有服务配置 | `ctx.configEditor.edit()` | DSH 官方路径：校验完整候选、保留注释与 `!!js`、原子落盘。该服务不可用时回退到直接改行。 |
| 新增 / 删除 / 启停 | 直接编辑 `cordis.patch.yml` | `configEditor` 只能改已存在条目，无法增删。 |

直接编辑采用**行区间替换**而非「解析-重序列化」：

- `yaml` 库打包在 DSH 的 asar 内，插件无法从其模块图解析；DSH 另有的 `js-yaml` 同样不可用。
- 更关键的是保真：profile 的 `cordis.patch.yml` 是手工维护的文档，充满注释、刻意排序和 `!!js` 表达式。整棵树重新序列化会毁掉这些，行区间编辑则只替换插件能精确定界的连续行。

写入是事务性的：新文本先做结构校验，再写临时文件并 rename 覆盖；失败时 profile 原样不动，且在旁保留一份 `.bak-mcpmanager-*` 备份。

HMR 通过 chokidar 监听 `cordis.patch.yml`，所以写盘本身就是重载触发——无需显式 reload。

## 安装

```bash
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

或手动（等价于 `install_bundle` 做的事）：

1. 在 `<profile>/node_modules/` 下链接本包目录；
2. 在 `<profile>/package.json` 的 `dependencies` 加 `"dsh-mcp-manager": "link:<绝对路径>"`；
3. 在 `dsh.profile.bundles` 末尾加入 `"dsh-mcp-manager"`；
4. 重启 DSH。

## 开发

```bash
npm install          # 仅为测试安装 yaml
npm test             # 42 个单元测试：两个方言 + patch 编辑器
npm run check        # 语法检查
```

测试只读真实 profile 的副本，绝不写用户配置。

## 结构

| 文件 | 职责 |
|---|---|
| `index.js` | Host 入口：7 条路由（servers / server / parse / add / update / remove / toggle） |
| `src/parse.mjs` | 方言解析与规范化（纯函数） |
| `src/patch-edit.mjs` | 行区间编辑器 + 事务写入 |
| `src/inventory.mjs` | 从 Loader 树与工具注册表推导清单 |
| `client/client.js` | 浏览器端：侧栏入口 + 主页面 + 弹窗 |

## 已知限制

- 只写 profile 自己的 patch；由 bundle 层或 home patch 提供的行不能在此删除。
- `!!js` 表达式在**导入**时按字面文本保留，不执行——粘贴进来的内容不可信，不应求值。
- 不支持 SSE 传输（DSH 的 MCP 客户端只接受 `stdio` 与 `streamable-http`），导入时会明确报错而不是静默改写。
- 连接状态是推导值，不是 MCP 客户端上报的实时状态。

## License

MIT
