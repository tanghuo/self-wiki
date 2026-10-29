# Agent 工作台 P0 实机记录

2026-10-29，Windows x64，Node v24.16.0。执行器为 `C:\Users\Administrator\.grok\bin\grok.exe`，版本 `grok 1.0.70 (f50904eaee6c) [stable]`，ACP v1，模型 `grok-4.6`。

## 结论

**终端兼容问题已修正并通过真实 Grok 验证；P0 整体尚未完成。** 用户于本轮授权调整适配约定。最终 [UTF-8 实机报告](agent-workbench-p0-shell-utf8-2026-10-29.json)中客户端读、写、终端实际输出/退出码、拒绝、load 与终端清理均通过，`hostGatePassed=true`。项目配置加载时点、搜索/子工具、真实 Grok 长命令取消、原生生图授权等仍未验证，因此 `p0Complete=false`、`p2Blocked=true`。

当前不开放新工作台执行入口。此前三次探针只接受 executable＋argv 且拒绝任何附加环境变量，未覆盖 Grok 的实际请求形式；这不能证明 Grok 不支持客户端终端，也不足以断言它违反 ACP（`args` 是可选字段）。采用下面的显式 Shell 适配后，终端这一项已通过，不再要求仅为此升级 Grok。

### 本轮适配决策与实施

按 sr-design-gate Inline 路线实施，边界如下：

- `src/agent/engines/grokTerminal.js` 只将请求转换为不可变的最终操作：程序、完整参数、cwd、有效环境和省略的环境变量名，并计算操作 hash；本模块不授予权限、不执行命令。直接程序必须是绝对路径，整条命令由调用方明确指定 PowerShell，不按空格猜测或拆分。
- Windows 固定使用系统 Windows PowerShell，`-NoLogo -NoProfile -NonInteractive -Command`；UTF-8 前导脚本也在最终参数和 hash 中。命令语法固定为 PowerShell，不自动换 cmd/bash，不使用不透明的 EncodedCommand。
- 显示类环境变量按名称和值校验；Grok 附带的 `GRADLE_OPTS`、`MAVEN_OPTS`、`GROK_SESSION_ID` 明确省略并记录名称。未知变量、PATH、NODE_OPTIONS、代理等不被放行。审批对应有效操作，不能依赖 engine permission 或 hook 的标题复用。
- `tools/lib/probeTerminalHost.mjs` 是合成测试宿主，执行前每次要求批准最终操作，使用 `spawn(program,args,{shell:false})`，完整提供 create/output/wait/kill/release；输出限额、UTF-8 边界、退出码及清理不确定状态均有处理。
- 探针仅批准事先定义的 Node 标记输出命令及其有限 PowerShell 写法，核对真实进程输出和退出码，不根据模型文字判成功。不开放任意项目命令。
- 产品的审批卡、会话代际和授权持久化仍由 P2 实现；本轮没有用合成探针的固定批准策略替代用户审批 UI。

本轮针对性测试 10 项通过，覆盖直接/字符串请求、拒绝无副作用、输出限额、非零退出码、release、kill、Windows 子进程树、中文/空格路径与管道、环境变量和操作 hash。PowerShell 编码设置在 Codex 受限沙箱内曾遭 Windows 访问拒绝；相同测试在本机权限下通过，没有关闭 OS 安全策略。

## 运行记录

| 运行 | 发起 prompt 数 | 结果 | 脱敏报告 |
| --- | --- | --- | --- |
| 初次 | 1 | 初始化/本机登录通过；读取超时 90 秒，未观察到工具请求 | [首次报告](agent-workbench-p0-live-2026-10-29.json) |
| 指定模型及 low effort 重试 | 6 | 网络恢复后 fs/权限/load 有响应；terminal 请求被探针拒绝 | [重试报告](agent-workbench-p0-live-retry-2026-10-29.json) |
| 用户确认已开启代理 TUN 后 | 6 | 再次确认 fs、权限拒绝与 terminal 参数形态 | [TUN 后报告](agent-workbench-p0-live-tun-2026-10-29.json) |
| 显式 PowerShell 适配 | 6 | 真实终端输出与退出码通过，拒绝路径保留 | [Shell 报告](agent-workbench-p0-shell-2026-10-29.json) |
| 最终 UTF-8 参数适配 | 6 | 读写、终端、拒绝、load、清理全部通过，其他覆盖项仍待完成 | [最终报告](agent-workbench-p0-shell-utf8-2026-10-29.json) |

合计发起 25 次 prompt；该计数不是已确认的计费次数。未请求生图/改图。首次超时与用户随后开启 TUN 的时间一致，但本实验没有单独隔离网络变量，不把因果关系当作已证明。

所有实验均使用操作系统临时目录中新建的 `wiki-agent-p0-*` 合成目录，不在用户项目、Wiki 数据目录或 Git 工作区内测试修改。保留这些合成目录用于核查；不持久化模型正文、Bearer、登录信息、原始环境值或图片数据。

## 首次三次运行的逐项观察（历史记录）

| 项目 | 实际结果 | 状态 |
| --- | --- | --- |
| initialize | 声明 `fs.readTextFile/writeTextFile` 与 `terminal`；返回协议 1、loadSession、图片与 hooks 能力 | 通过，仅声明 |
| authenticate | `cached_token` 返回成功；并不证明远端模型网络可用 | 通过 |
| 客户端读取 | 磁盘为 DISK 标记；宿主返回不同 HOST 标记；回答命中 HOST，收到 `fs/read_text_file` | 实机通过 |
| 客户端写入 | 收到写入审批与 `fs/write_text_file`，仅写入指定合成文件，核对字节一致 | 实机通过 |
| 客户端终端 | 收到 `terminal/create`；`command` 是整条命令字符串，`args` 为空或未提供（当前报告统一记录为 `[]`）；另附多个环境变量 | **不兼容，未执行** |
| 拒绝写入 | 选择 `reject_once`，原合成文件保持原值 | 实机通过 |
| 拒绝命令 | 选择 `reject_once`，目标合成文件未出现 | 实机通过；不是终端执行通过 |
| load | 关闭进程后重新 initialize/authenticate/load，未发送新 prompt，未观察到写入/启动命令请求 | 实机通过，有限观察 |
| hook 错误 | 故意返回 RPC error 后仍收到权限请求及 `fs/write_text_file`；宿主独立拒绝后无文件副作用 | **hook 错误不能作为可靠门禁** |
| 取消 | 首次超时进程被关闭；未验证正常运行 prompt 的取消回执及进程后代清理 | 未测 |
| 项目配置 | 尚未用项目配置哨兵验证 initialize/new 的加载时点 | 未测；不能启用项目执行 |
| 搜索/子工具、hook 超时、原生生图授权 | 未证明这些路径全部经过宿主 | 未测 |

真实 terminal 参数示例（仅合成无害命令）：

```json
{
  "command": "D:\\soft\\node.exe -e \"process.stdout.write('SELF_WIKI_P0_COMMAND')\"",
  "args": []
}
```

ACP v1 [终端规范](https://agentclientprotocol.com/protocol/v1/terminals)提供 `command` 和可选的 `args`。首次三次探针没有执行上述字符串，不能算终端通过；本轮已通过明确的 PowerShell 操作执行并记录实际输出/退出码。A01 还包含产品测试命令与展示，不能仅以这次合成命令通过宣称整项产品验收完成。

报告中的旧字段 `hookErrorClosed` 只检查了文件是否存在，不能证明 hook 本身拒绝执行。现已修正为 `hookErrorSideEffectAbsent` 与 `hookErrorStoppedTool`，保留更正说明；后者在两次真实运行中均为 false。没有以“宿主拒绝后的无副作用”冒充 hook fail-closed。

## 可复现入口与 fixture

```powershell
node tools/probe-agent-workbench.mjs --live --output .local/p0-new-run.json
node --test test/integration/agent-workbench-probe.test.js
```

`--live` 必须显式提供，输出路径必须尚不存在。真实运行会使用已登录的 Grok 并可能消耗额度；默认单次 prompt 超时 90 秒，可用 `--timeout-ms` 调整（最多 180 秒）。开始每轮输出阶段名；超时发送取消并关闭进程，不自动重发未知请求。

fixture 测试仅验证探针能区分宿主执行、伪造的成功文字、拒绝、恢复和 hook 错误后的副作用，不能替代真实 CLI。未实现的完整 terminal 生命周期、信任时点和进程后代测试仍列为未测；探针不会因为这部分 fixture 通过而开放 P2。
