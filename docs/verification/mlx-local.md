# 本地 MLX 验证

所有服务器、凭证、下载目录与聊天都在 `launchVerificationServer` 的临时 HOME / 数据目录中。不会修改运行中的应用或原始模型目录。

## 自动检查

```sh
pnpm exec vitest run server/mlx/mlx.test.ts server/drivers/mistral.test.ts server/workspace-backup-policy.test.ts src/components/EnginesSettings.test.ts src/components/ModelPicker.test.ts
pnpm typecheck
pnpm i18n:check
pnpm build:server
PYTHONDONTWRITEBYTECODE=1 /path/to/mlx-venv/bin/python -m unittest discover -s server/mlx/python -p test_worker.py -v
```

覆盖私有仓库授权拒绝、凭证加密和重启恢复、文件路径检查、LFS 校验失败、下载取消和重试、对象存储跨源跳转、管理员边界、工作区备份排除、推理子进程异常退出、模型切换排队及独立取消。Python 检查覆盖碎片化工具调用、未知 / 不完整调用拒绝和 SSM 工具结果回放。

## 浏览器与完整聊天

需要可导入的 Playwright 和 Chromium，可通过 `OMB_VERIFY_PLAYWRIGHT`、`OMB_VERIFY_BROWSER_CHROME` 指定现有安装。

```sh
node --experimental-strip-types scripts/verify-mlx.ts
```

脚本启动隔离应用和模拟 CSGHub，使用真实 `MlxModels` 设置组件完成错误令牌提示、连接、私有模型浏览、下载、Python 配置、加载、桌面与 390px 截图。然后使用 control surface 的 `doctor`、`new-bot`、`set-model`、`send`、`wait`、`messages` 完成聊天，验证卸载与断开连接。默认使用确定性的进程替身，不要求 GPU 或真实模型权重；本地运行环境接口仍要求 Apple Silicon。

真实模型验证复用同一条链路。模拟仓库只读地提供给定目录的权重，下载到临时数据目录，再由应用启动真实 MLX 推理：

```sh
OMB_MLX_MODEL=/absolute/path/to/model \
OMB_MLX_PYTHON=/absolute/path/to/mlx-venv/bin/python \
node --experimental-strip-types scripts/verify-mlx.ts
```

`OMB_MLX_NO_BROWSER=1` 可用于只验证 API、推理和聊天。测试提问为“法国的首都是哪里？请用一句话回答。”，检查聊天结果包含“巴黎”或“Paris”。该检查只证明接入链路和一次问答，不是模型能力评测。

脚本打印 `evidence`、fixture URL、PID、日志路径；保存命令、wait / messages 结果和截图。成功或失败都会关闭自己启动的进程并删除临时应用目录，证据保留在输出目录。

## 2026-11-13 实测

- 119 项相关 TypeScript 测试、3 项 Python 工具协议检查通过。引擎设置中一条仍使用旧名称 MausBot 的基线测试断言已更新为当前 QBot 名称。
- 浏览器设置和完整聊天验证通过；验证页面桌面和 390px 布局无横向溢出。
- MiniCPM5-2B-MLX：从模拟仓库下载真实权重、加载、本地聊天通过。
- OmniFM-step8500-mlx-q4：同一链路通过，使用随应用提供的 KDA 实现；原模型目录未改动。
- 独立 Python 环境的创建、依赖安装和版本 / Metal 检查通过。
- TypeScript、语言目录校验及服务端打包通过；Python 运行资源随服务端包复制。

未验证用户部署的 CSGHub CE、真实组织权限配置、签名对象存储部署、已签名 Electron 安装包，以及复杂 Agent 任务质量。
