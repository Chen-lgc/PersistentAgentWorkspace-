# CSGHub CE 与本地 MLX 模型

在 **设置 → 引擎 → 本地 MLX · CSGHub** 配置私有模型仓库，下载后可在机器人或对话的模型选择器中选择 **MLX · Local**。

## 配置与使用

1. 在 CSGHub CE 中创建个人访问令牌（Access Token），给账号授予目标私有模型仓库的读取权限。
2. 填入 **平台 API 基础地址**，例如 `https://models.example.com`，粘贴令牌并点击“连接并验证”。地址可能不同于网页地址；不要填推理网关地址或 `/api/v1` 后缀。这里使用 Access Token，不是推理 API Key。
3. 点击“浏览”，搜索 `mlx` 或模型名称。可以查看“我的仓库”，或在下方直接输入私有组织仓库 ID，例如 `qingyan/omnifm-mlx-q4`。搜索列表允许展示其他格式；下载时会检查所需文件。
4. 点击“下载”。也可以指定分支、标签或 commit。下载会先解析为固定 commit，再取文件；模型列表显示实际 commit 的前八位。
5. 在 Apple Silicon Mac 上点击“安装独立推理环境”。需要已安装 Python（已验证 Python 3.12）；路径留空使用 `python3`。安装会从 Python 包索引下载依赖，不需要系统级 `pip install`。若已有环境，输入其 Python **绝对路径**，点击“验证并使用已有环境”。
6. 点击“加载”，或直接在机器人 / 对话的模型选择器中选择 **MLX · Local** 及下载的模型。首次使用会自动加载。点击“卸载内存”释放模型；“删除本地副本”删除应用下载的权重。

本地推理需要 macOS、Apple Silicon 和 Metal。仓库浏览与下载不要求 Apple Silicon。多个对话共用一个推理进程，按请求排队；切换模型时结束旧进程后再加载新权重。停止一个排队中的请求不会中断另一个对话的生成。

## 支持的模型

| 类型 | 仓库内容与范围 |
| --- | --- |
| 标准 MLX-LM | MLX-LM 0.32.2 支持的文本架构；包含 `config.json`、`model*.safetensors`、tokenizer 和聊天模板。支持分片 safetensors。 |
| SSM / OmniFM | `model_type: "kda"`，标准 FLA KDA 权重布局或清雁 OmniFM 文本导出；支持已有 Q4 导出及 offset RMSNorm。使用随应用提供的 `ssm-mlx` 实现。 |

模型目录中的 Python 文件不会被下载或执行。SSM 配置里的 `model_file` 会被忽略，改用应用自带的 KDA 后端；其他需要自定义 Python 的架构会被拒绝。自定义 tokenizer 代码也不执行。SSM 后端来源记录在 `server/mlx/python/NOTICE.md`。

模型必须带可用的聊天模板，例如 `chat_template.jinja` 或 tokenizer 配置中的 `chat_template`。当前接入是**纯文本**，不支持 OmniFM 图像、语音模块或 MLX-VLM。

原生工具调用使用 tokenizer 对应的解析器；没有原生工具协议的文本模型使用文本工具调用格式，并保留工具结果供后续推理。执行仍经过现有 Agent 工具权限与审批流程。接入工具协议不等于模型具备可靠的 Agent 能力，需要另做任务质量评估。

固定依赖为 `mlx==0.32.4`、`mlx-lm==0.32.2`、`transformers==5.22.2`、`numpy==2.5.4`。单次输入上限 32K token，生成上限由驱动设置为 2048 token；实际能力仍受模型自身上下文和设备内存限制。

## 数据与授权

- 连接、下载、运行环境和模型管理接口仅允许本机所有者或管理员访问，托管工作区拒绝这些管理操作。
- 令牌通过 `Authorization: Bearer` 发送，服务端 AES-256-GCM 加密保存，不回传到浏览器、不写入模型目录或推理子进程环境。加密密钥和文件使用本机私有文件权限；具有本机账号或管理员权限的人仍可能读取它们。
- 默认要求 HTTPS。可信内网若必须使用 HTTP，需要勾选允许明文传输；这不会提供传输加密。
- 对象存储跳转不携带跨源 Authorization；拒绝 HTTPS 降级到 HTTP，不关闭 TLS 证书校验。
- 固定 commit 下载，核对文件大小以及服务端提供的 LFS SHA-256；全部成功后才加入本地模型列表。取消或失败的下载不会成为可用模型。重试重新下载，不支持断点续传；重启清理未完成下载。
- 本地 MLX 通过标准输入输出通信，**不开放推理 HTTP 端口**。加载时启用离线模式，不自动去 Hugging Face 获取缺失文件。
- 断开仓库连接会清除本地令牌并取消未完成下载，已经下载的模型可继续离线使用。仓库撤销权限无法追回已经下载的权重。

数据位于当前应用数据目录的 `mlx/` 下（默认 `~/.openmausbot/mlx/`，也支持 `OMB_DATA_DIR`）。`models/` 保存完整快照，`venv/` 保存独立推理环境。整个 `mlx/` 目录排除在工作区备份与迁移的认证数据导出之外，需要在新设备重新连接并下载。

## CSGHub 接口与兼容范围

实现采用官方服务端与 SDK 的平台接口：

- `GET /csg/api/whoami-v2` 验证令牌并获取用户名；
- `GET /api/v1/models`、`GET /api/v1/user/{username}/models` 搜索和分页；
- `GET /csg/api/models/{namespace}/{name}/revision/{ref}?blobs=true` 获取固定版本及文件元数据；
- `GET /csg/{namespace}/{name}/resolve/{commit}/{path}` 下载文件。

参考：[CSGHub Access Token](https://www.opencsg.com/docs/en/profile/accesstoken)、[官方 SDK](https://github.com/OpenCSGs/csghub-sdk)、[CSGHub 服务端路由](https://github.com/OpenCSGs/csghub-server/blob/main/api/router/api.go)、[MLX-LM](https://github.com/ml-explore/mlx-lm)。旧版 CE 若缺少这些兼容接口，需要升级或按该版本调整适配层。

已用本地模拟 CSGHub 验证授权和下载，并用真实 MiniCPM5-2B-MLX、OmniFM Q4 权重完成应用内聊天。**尚未拿到用户实际 CE 实例地址和版本，未完成该部署的联调。**验证步骤见[本地 MLX 验证](verification/mlx-local.md)。
