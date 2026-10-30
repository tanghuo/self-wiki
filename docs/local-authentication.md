# 本机连接与认证

本机 API 需要认证。桌面程序会通过主进程和后端的私有启动通道自动配对；renderer 只获得 HttpOnly Cookie，不获得通用管理 Bearer。

## 浏览器

`npm.cmd start` 或 `node src/server/server.js --open` 会打开带一次性配对码的链接。配对码有效期 60 秒，只能使用一次；浏览器兑换后立即清除 fragment。认证 Cookie 为 HttpOnly、SameSite=Strict，后端重启后失效。

直接访问普通地址会显示连接页，不会自动授予权限。在本机终端获取新链接：

```powershell
node src/cli/main.js pair --data-dir "D:\wiki-data"
```

打开返回的 `url`，或将链接/配对码粘贴到连接页。不要把一次性链接发给其他人。LAN 配对码与本机配对码互不通用；LAN 和临时分享继续使用各自原有凭据。

## CLI 与脚本

优先使用 `--data-dir` 自动发现。后端在数据目录 `.runtime/credentials-<实例ID>.json` 保存 CLI 独立管理 Bearer；Unix 权限为 0600，Windows 移除继承权限并仅授予当前用户和 SYSTEM。正常退出清除凭据；重启生成新凭据。公开的实例记录与 API 响应不含管理 Bearer。

显式 `--url` 或 `SELF_WIKI_URL` 需要指定 `--token-file`，也可用 `SELF_WIKI_TOKEN_FILE` 指向该文件：

```powershell
node src/cli/main.js status --data-dir "D:\wiki-data"
node src/cli/main.js status --url http://127.0.0.1:8765 --token-file "D:\wiki-data\.runtime\credentials-实际实例ID.json"
```

凭据文件留在应用数据目录，不要复制到项目或提交到 Git。`/api/instance` 需要认证；无需权限的存活检查使用 `/api/health`，它仅返回应用名及存活状态。

## 工具与子进程

旧聊天 CLI 工具只获得当前活动轮次、活动调用绑定的工具令牌，允许检索和提出建议，不允许管理设置、采纳建议或创建本机配对码。自动整理 worker 使用独立令牌访问租约协议和只读图片；退出后撤销令牌。Grok MCP 保留自己的会话工具令牌，不能调用管理 API。

引擎子进程只继承系统路径、临时目录、用户/CLI 登录目录和语言等允许的环境变量，不继承应用凭据、无关服务密钥及代理凭据。Grok CLI（工作台、聊天、工作流及生图）额外显式设置大小写 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 为本机 Clash 地址 `http://127.0.0.1:7890`，不依赖系统代理或 TUN，不继承父进程的代理地址及 NO_PROXY 绕过规则。需保持 Clash 的 7890 混合端口运行；代理不可用时请求失败，不自动改为直连。此默认值位于 `src/agent/executors/grokEnvironment.js`；修改后需重启应用后端，新启动的 Grok 进程才会生效。其他引擎和宿主命令仍使用原环境白名单。

此机制防止未认证 HTTP 请求。拥有同一系统用户权限的进程仍可能读取凭据或数据库；本机认证和 cwd 均不是操作系统沙箱。

## 验证

自动验证覆盖匿名 API/SSE/产物/写设置拒绝、一次性兑换与过期、HttpOnly、重启轮换、CLI 发现与显式凭据、开发代理、浏览器刷新、LAN/临时分享及旧聊天回归。完整结果与桌面打包验证记录在 [工作台实施方案](agent-workbench-plan.md)第 10 节。
