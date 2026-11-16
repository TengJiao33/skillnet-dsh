# SkillNet DSH

[SkillNet](https://github.com/zjunlp/SkillNet) 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，在 DSH 中发现、安装、使用和分析技能。

中文界面沿用 SkillNet 三栏技能库与关系网图，跟随 DSH 明暗主题。默认使用 DSH 当前或选定模型，保留原有 prompt、生成、检索与校验逻辑。

当前版本 **0.5.0**，适配 **DSH 0.2.2-rc.1**，后端固定 **skillnet-ai==0.1.5**。这是独立适配插件。

## 功能

| 功能 | 行为 |
| --- | --- |
| 我的技能库 | 读取实际目录，浏览描述、源码、画像、关系与证据；新增技能标“未分析”，改动技能标“待更新” |
| 发现与安装 | 搜索 SkillNet 目录，显示来源仓库与星标；查看完整包，下载校验后确认安装到个人目录 |
| 使用技能 | 选择目标 DSH 对话，在原草稿后追加原生技能引用，不自动发送 |
| 对话内路由 | Agent 按需选技，通过原生 skill 工具加载完整指令，继续同一对话的任务 |
| 建图 / 更新图谱 | 新建 DSH 对话并预填草稿，用户发送后分步分析和校验；中断可续做，全部完成才发布图谱 |
| 创建技能 | 从需求、DSH 对话、任务记录或 GitHub 仓库生成草稿，预览后确认安装 |
| 质量评估 | 确认后完成官方五维评估，最近一次成功结果常驻对应技能详情 |

默认建图与路由无需向量配置。显式启用向量模式时沿用原 SDK 向量流程和索引检查，失败不会静默降级。

## 安装

### 环境

- DeepSeek Harness **0.2.2-rc.1**。
- Node.js **22.19 或以上**。
- Python **3.10 或以上**，并安装本项目的固定版本依赖。
- 使用模型功能前，在 DSH 中配置可用模型；仅浏览和下载无需模型密钥。

### 从源码安装

```powershell
git clone https://github.com/TengJiao33/skillnet-dsh.git
cd skillnet-dsh
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm ci
npm run build
```

在 DSH 桌面版进入 **插件 → 添加插件 → 安装现有插件**，选择该仓库的绝对路径。加载后，左侧会出现 **SkillNet**。

macOS / Linux 使用 `./.venv/bin/python` 安装 Python 依赖。插件依次寻找：插件配置中的 `python`、环境变量 `DSH_SKILLNET_PYTHON`、插件目录下的 `.venv`、系统 `python`。

[Releases](https://github.com/TengJiao33/skillnet-dsh/releases) 提供 `.tgz` 构建包。包中包含客户端构建产物和 Python 适配源码，Python 运行环境及依赖需要另行准备。

## 使用

### 个人技能库

首次打开自动连接个人技能目录，规则为：显式配置的 `dshHome` → `DSH_HOME` → 当前用户 `~/.dsh`，再取 `skills` 子目录，与 DSH 软件安装位置无关。

技能包应直接位于 `skills/<技能名>/SKILL.md`。可在技能库“管理”中连接其他实际目录或导入图谱；下载和创建流程只安装到个人技能目录。

列表、描述和普通源码视图读取当前文件。已有画像和图谱会保留，技能增删不会清空旧图谱；证据点击后打开分析时保存的源码快照并定位行号。零关系时仍显示技能节点。

### 发现、下载与使用

在“发现”浏览或搜索技能，默认按来源仓库星标排序。点击“查看”打开完整技能包；点击“下载”读取、校验后，由用户确认安装。

搜索使用 SkillNet 托管目录，结果可能指向历史提交，不等于对 GitHub 当前主分支的实时核验。下载保留来源指定版本，不擅自换成最新版。星标属于来源仓库；目录已有评估会标明来源。

在技能详情点击“使用”，选择目标对话后追加原生 `/技能名` 引用。保留已有文字、附件和引用，由用户继续编辑或发送，不调用模型。

### 对话内路由

直接在 DSH 对话中描述任务，例如：

> 从我的技能库里选择合适的技能，分析这份 CSV，并生成论文图表。

Agent 可以按需调用 `skillnet_route` 比较候选或选择互补技能，随后通过当前 Agent 的原生 `skill` 工具加载完整指令，继续原任务。单个技能已明显匹配时可直接原生加载，无需路由。

路由无需先打开插件页或建图，不自动下载或创建技能。是否触发工具由当前 Agent 决定，并非所有自然语言任务都会调用路由。

### 建图与续做

点击“建图 / 更新图谱”会新建专门的 DSH 对话并预填草稿。自行发送后，逐步提取画像并判断“可组合 / 相似”关系。

- 每步提交后执行原始 schema、源码证据和关系校验，通过后保存进度。
- 中断或 DSH 重启后，在同一建图对话发送“继续建图”即可续做。
- 完整分析通过后才原子发布图谱，中途停止保留旧图谱和成功缓存。
- 源码、模型或建图模式改变时，要求重新准备建图对话；旧任务不会覆盖更晚发布的图谱。

默认模式对小库直接比较技能对，较大库使用 BM25 能力、产出关键词及显式引用规则筛选候选，再执行原关系判断。关键词候选可能遗漏用词不同的语义关系；可选原 SDK 向量模式。

### 创建与评估

“创建”提供需求、DSH 对话、任务记录和 GitHub 四种来源。来源对话与推理模型独立，读取的文本可以编辑。生成期间显示进度和取消，完成后以草稿卡片展示；查看后进入预览，再确认个人安装。

对话来源只读取最近 24 条用户 / 助手文本，最多 80,000 字符，不提取系统提示、工具结果或推理。读取本身不调用模型。

“质量评估”检查安全性、完整性、可执行性、成本意识和可维护性，并保留 SDK 提示注入扫描。成功结果按技能和目录保存；重评时保留原结果，新评估成功后替换，失败或取消不清除旧结果。结构校验与图谱分析不代表技能质量已通过评估。

## 模型与配置

默认使用 DSH 当前 / 选定模型，无需再填写一套分析模型密钥。“设置”保留高级独立 API 和可选向量配置。

- 对话建图的推理发生在用户可见的建图对话中。
- 路由、创建、评估及查询改写使用 DSH 受限原生推理任务，继承模型选择，不继承原对话全部上下文或工具权限。
- 高级独立路由接口需要支持 DeepSeek Messages；任意 Chat Completions 网关不能直接替代。
- 向量模式单独要求向量模型配置，向量路由还要求有效且匹配当前技能的索引。

密钥通过 DSH 凭据服务保存，前端不回显。非敏感设置保存于 `DSH_HOME/skillnet/settings.json`。本仓库不包含预配置账号、密钥、个人技能或本机 profile。

## 数据位置

| 内容 | 默认位置 |
| --- | --- |
| 个人技能 | `DSH_HOME/skills/` |
| 连接和非敏感设置 | `DSH_HOME/skillnet/workspace.json`、`settings.json` |
| 建图对话进度 | `DSH_HOME/skillnet/analysis-conversations/` |
| 创建 / 评估任务与结果 | `DSH_HOME/skillnet/tasks/`、`results/`、`artifacts/` |
| 预览和安装记录 | `DSH_HOME/skillnet/staging/`、`installations/` |
| 分析快照与成功缓存 | 默认技能目录下的 `.skillnet/` |

断开目录连接或卸载插件不会删除技能和已保存分析。

## 开发与验证

先准备 Python 依赖，再运行：

```powershell
npm ci
npm run typecheck
npm run build
npm run check
npm test
```

当前自动化测试共 84 项，覆盖缓存与快照发布、分步续做、来源与证据校验、路由加载、下载与安装、评估记录等。模型接口测试使用受控响应，不代表任意真实模型或自然语言任务均已验证。

`client/` 为前端源码，`npm run build` 生成 `src/panel.js`；共享 DSH 的 React，通过原生槽位加载，无需 iframe 或单独启动 SkillNet Web 服务。`python/` 为固定 SDK 版本的适配层，`src/` 为宿主服务和工具入口。

## 来源与许可

- 上游：[zjunlp/SkillNet](https://github.com/zjunlp/SkillNet)，前端来源版本见 [`client/upstream/UPSTREAM.json`](client/upstream/UPSTREAM.json)。
- 保留上游 MIT 许可与适配说明，见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。
- 图标使用 Lucide，相关许可见 `NOTICE`。
