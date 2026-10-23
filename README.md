# @zhujiuyi/dsh-mcpserver-manager · DSH MCP 服务管理

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

### `!!js` 表达的保真

Loader 把 `!!js` 表达式以 `{ __jsExpr: '<源码>' }` 包装对象交到插件手里，**不求值**。整条链路都原样传递这个包装，写盘时还原成 `!!js <源码>`：

- 编辑一个含 `cwd: !!js process.cwd()` 的服务的其它字段，该表达式必须逐字保留；
- 把它 `String()` 或 `JSON.stringify()` 会写出 `[object Object]`，下次加载即失败。

这条性质由 `test/js-expression.test.mjs` 钉住（含真实 YAML 往返校验）。

写入是事务性的：新文本先做结构校验（行能重新定界、条目数变动不超过 1），再写临时文件并 rename 覆盖；失败时 profile 原样不动，且在旁保留一份 `.bak-mcpmanager-*` 备份。

HMR 通过 chokidar 监听 `cordis.patch.yml`，所以写盘本身就是重载触发——无需显式 reload。

## 安装

```bash
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

或手动（等价于 `install_bundle` 做的事）：

1. 在 `<profile>/node_modules/` 下链接本包目录；
2. 在 `<profile>/package.json` 的 `dependencies` 加 `"@zhujiuyi/dsh-mcpserver-manager": "link:<绝对路径>"`；
3. 在 `dsh.profile.bundles` 末尾加入 `"@zhujiuyi/dsh-mcpserver-manager"`；
4. 重启 DSH。

## 开发

```bash
npm install          # 仅为测试安装 yaml
npm test             # 62 项测试：方言解析 + patch 编辑器 + !!js 保真 + 客户端契约
npm run check        # 语法检查（Host、Client、三个 src 模块）
npm run test:client  # 只跑客户端 bundle 自检
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

## 实测验证

在本机对照真实 profile 跑通（`rea` 服务，207 个工具）：

| 场景 | 结果 |
|---|---|
| 读取清单 | 识别 `rea`，状态 connected，207 个工具按 `mcp__rea__` 归组 |
| Claude Code JSON → dsh | `{"mcpServers":{"dbx":{...}}}` 转出的行与等价 dsh 片段**逐字段相同** |
| dsh 片段 → 行 | Windows 路径 `C:\\Users\\zhuji\\.dbx\\bin\\dbx-mcp.exe` 逐字符保真 |
| 新增服务 | `dbx` 写入 `- insert:` 块内，HMR 自动连接，25 个工具；`rea` 不受影响 |
| 编辑服务 | 改 `toolCallTimeoutMs` → 就地替换，文件只有一处定义，运行时生效 |
| 删除服务 | 移除 `dbx` 后配置文件**逐字节还原**，0 差异 |
| `!!js` 保真 | `cwd: !!js process.cwd()` 经读取、编辑、写回全程保留 |

写入前自动备份（`.bak-mcpmanager-*`），HMR 监听使改动即时生效。

## 测试覆盖

| 文件 | 覆盖 |
|---|---|
| `test/parse.test.mjs` | 两种方言的解析、互转、各字段边界、错误信息 |
| `test/patch-edit.test.mjs` | 行区间扫描、插入/替换/删除、注释边界、CRLF、真实 YAML 往返 |
| `test/js-expression.test.mjs` | `!!js` 包装在整条链路上的保真（含只改一个字段的回归测试） |
| `test/inventory.test.mjs` | loader generator 形态、同名冲突、工具归组、四种连接状态、降级路径 |
| `test/write-path.test.mjs` | 就地替换后 id 只有一处定义、改动真正生效、`!!js` 保留 |
| `test/client-selfcheck.mjs` | bundle 注册契约、`main`/`sidebar` 的 id 与 key 相等、zh/en 键对齐、纯 token 着色、无非法 require |

## 开发中发现的三个真实缺陷（已修复）

这三个 bug 都是对照运行中的 DSH 才发现；修复前单元测试全部"通过"：

1. **`!!js` 表达式被抹成 `[object Object]`** — Loader 以 `{__jsExpr}` 包装交给插件、不求值，整条链路却都把它 `String()` 了。编辑任何含 `!!js` 的服务的其它字段，都会写坏配置。
2. **`loader.entries()` 是 generator** — 用 `Array.isArray` 判断导致所有条目被丢弃，页面显示"没有 MCP 服务"，而 profile 里明明有。
3. **`configEditor.edit()` 只写覆盖行** — MCP 行在 `- insert:` 块内，交给它会**追加第二条定义**而非修改原行：接口报成功、文件变长，但运行值没变。已改为按存储形态选路径。

## 已知限制

- 只写 profile 自己的 patch；由 bundle 层或 home patch 提供的行不能在此删除。
- `!!js` 表达式在**导入**时按字面文本保留，不执行——粘贴进来的内容不可信，不应求值。
- 不支持 SSE 传输（DSH 的 MCP 客户端只接受 `stdio` 与 `streamable-http`），导入时会明确报错而不是静默改写。
- 连接状态是推导值，不是 MCP 客户端上报的实时状态。

## License

MIT
