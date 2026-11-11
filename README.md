# 🧬 Skill Evolution (`skill-evolution`)

[![CI](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml/badge.svg)](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.11-informational.svg)](#开发)
[![Tests](https://img.shields.io/badge/tests-70%20passed-34d399.svg)](#开发)
[![Hermes parity](https://img.shields.io/badge/Hermes%20parity-41%2F41-8b7cf6.svg)](#能力对齐与审计)

> DSH 的 `skill` 工具只能加载技能，不能写回技能。这个插件补上写回的那一段：回合结束后自动复盘会话、把经验蒸馏成技能草稿、过四道代码级闸门后等你批示，全程记账、可单条回滚。

[English Documentation (README.en.md)](./README.en.md) · [变更日志 (CHANGELOG.md)](./CHANGELOG.md)

---

## 它做什么

1. **回合后自动复盘** — 监听 `turn/end` 与 `session/flush`，识别 `user-correction`、`new-technique`、`skill-was-wrong` 三类信号；按 `minTurnsBetween` 回合 / `minMinutesBetween` 分钟双重节流（`.throttle.json` 跨进程持久化），快照有界（`maxMessages` 条、`maxChars` 字符）。
2. **复盘是只读的** — 复盘跑在宿主 subagent fork（`subagents.startActivation`，工具白名单 `skill` / `glob` / `grep` / `read`）或一个 OpenAI-compatible 辅助端点；两条通道都不写文件，写入由插件在闸门之后自己做，且新回合到来会打断上一次复盘、单次有超时。
3. **默认只产草稿** — `mode: draft` 时产物只写 `<skillsRoot>/.staging/`，正式技能库零改动；采纳后由 `promote` 落进正式技能目录，靠 DSH 技能文件系统的热更新自动生效。
4. **四道代码级闸门 + 归属保护** — 见下方闸门表；只有 `metadata.createdBy: agent` 的技能会被自动改写，用户手写技能一律不碰。
5. **账本与单条回滚** — 每次创建 / 补丁 / 批示修订 / 采纳 / 合并 / 归档都追加一条 `.evolution_ledger.jsonl`，文件内容按 SHA-256 去重存进 `.evolution_backups/blobs/`；回滚前先做安全捕获，捕获失败就拒绝回滚（fail-closed）。
6. **生命周期与建伞合并** — `.usage.json` 旁路遥测驱动 `active → stale(14d) → archived(30d)`（零使用不归档、`pinned` 豁免、内置技能受保护、只移动不删除）；另有 LLM 建伞合并把多个窄技能并成类级别伞技能，默认只预览不执行。

---

## 它怎么做

### 流水线模块

| 环节 | 文件 | 做什么 |
|---|---|---|
| 采集 | `lib/collector.js` | 剥离系统注入块，识别复盘信号，节流，压缩历史为摘要，裁剪到 `maxChars` |
| 复盘 | `lib/reflector.js` + `lib/prompts.js` | fork 只读复盘或调辅助端点；提示词逐字取自 Hermes（见 `vendor/hermes/`） |
| 蒸馏 | `lib/synthesizer.js` | 结构化 JSON → `SKILL.md` 内容（纯函数） |
| 闸门 | `lib/gatekeeper.js` | 四道静态检查，见下表 |
| 落盘 | `lib/applier.js` | draft/apply 两种落盘位置，归属保护，提升草稿 |
| 记账 | `lib/ledger.js` | JSONL 账本、SHA-256 blob、单条回滚、轮转与 blob GC |
| 生命周期 | `lib/usage.js` | `.usage.json` 遥测、三态转换、pinned/保护技能、adopt/disown |
| 建伞合并 | `lib/consolidation.js` | 前缀聚类 + LLM 计划校验（原子性：一条不合规整批拒绝） |
| 展示 | `client.js` + `lib/http-api.js` | Web 工作台与 `/dsh-evolution/api/*` |

### 四道闸门（`lib/gatekeeper.js`）

| # | 检查 | 拒绝什么 |
|---|---|---|
| 1 | 命名 | 非 kebab-case、超 64 字符、`fix-X` / `debug-Y` / PR 号 / 日期戳这类一次性会话产物、裸库名 |
| 2 | Frontmatter | 缺 `description`；`description` 超 80 字符；`frontmatter.name` 与目标名不一致 |
| 3 | 禁词扫描 | 负面断言（`X tool does not work`）、环境失败（`command not found`）、一次性叙事 |
| 4 | 体积与路径 | 正文超 24000 字符；`add_reference` 的路径不是 `references/<topic>.md` 或带日期戳 |

### 前端挂载点（`client.js`）

| 插槽 | order | 内容 |
|---|---|---|
| `main` | — | 完整工作台：概览 / 待审草稿 / 技能库 / 账本 / 参数五个视图 |
| `sidebar.panellist` | 15 | 侧栏入口 |
| `settings.section` | 30 | 只放引擎参数与状态，不放审阅工作台 |
| `settings.section.icon` | — | 设置段图标 |

界面样式只取宿主 `--dsw-alias-*` token 跟随明暗主题（720px 容器、20/14/12 号字阶梯、`.5px` 行分割线、36×20 原生开关）。

### HTTP API（`lib/http-api.js`）

前缀 `/dsh-evolution`，`GET /dsh-evolution/mobile` 返回独立手机端页面。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-evolution/api/status` | 完整状态（技能数、草稿含正文与中文简报、账本、最近复盘、节流、配置） |
| GET | `/dsh-evolution/api/skills` | 技能列表（生命周期状态、使用次数、是否 agent 创建） |
| GET | `/dsh-evolution/api/drafts` | 待审草稿（含完整 `SKILL.md` 与 `briefing`） |
| GET | `/dsh-evolution/api/skill/:name` | 单个技能详情 |
| GET | `/dsh-evolution/api/ledger` | 账本记录（`?limit=`） |
| GET | `/dsh-evolution/api/ledger/:id` | 单条账本（含前后文件 SHA 清单） |
| GET | `/dsh-evolution/api/candidates` | 可参与建伞合并的候选技能 |
| POST | `/dsh-evolution/api/refine-draft` | 按批示让 AI 重写草稿并更新简报 |
| POST | `/dsh-evolution/api/promote` | 采纳草稿（可先融合批示） |
| POST | `/dsh-evolution/api/promote-batch` | 原子批量采纳 |
| POST | `/dsh-evolution/api/discard` | 驳回草稿 |
| POST | `/dsh-evolution/api/tidy` | 待审积压一键分诊 |
| POST | `/dsh-evolution/api/rollback` | 按账本 `id` 回滚 |
| POST | `/dsh-evolution/api/pin` | 固定 / 取消固定 |
| POST | `/dsh-evolution/api/adopt` · `/disown` | 纳入 / 取消纳管 |
| POST | `/dsh-evolution/api/consolidate` | 建伞合并（`dryRun: true` 预览） |
| POST | `/dsh-evolution/api/config` | 保存配置 |
| POST | `/dsh-evolution/api/review` | 手动触发一次复盘 |

---

## 安装

**方式 A：插件管理器**

```bash
# 装进指定 profile（等价于在该 profile 目录执行 pnpm add）
dsh plugin add github:veritaswiki/skill-evolution
```

然后把包名加入该 profile 的 `dsh.profile.bundles`，重启 DSH。插件自己的 `cordis.patch.yml` 会带上默认配置（把 DSH 技能目录描述上限从 500 收到 80 字符，并对本插件 `insert` 一份配置）。

**方式 B：配置文件**

不装 bundle，直接在 `~/.dsh/cordis.patch.yml` 写：

```yaml
- id: tool-skill
  config:
    catalogDescriptionMaxLength: 80
- insert:
    - id: skill-evolution
      name: 'skill-evolution'
      config:
        enabled: true
        mode: draft
```

**方式 C：源码**

```bash
git clone https://github.com/veritaswiki/skill-evolution.git
dsh plugin add ./skill-evolution
```

装好之后，`/evolution status` 应能看到技能根目录、模式、技能数、待审草稿数与账本条数。

---

## 配置

`cordis.patch.yml` 里的默认值与 `index.js` 的 Schemastery 定义一致：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用回合后自动复盘 |
| `skillsRoot` | string | `""`（→ `~/.dsh/skills`） | 技能根目录；草稿、账本、遥测都放这里 |
| `mode` | `"draft" \| "apply"` | `"draft"` | `draft` 只写 `.staging/`；`apply` 过闸后直接落盘 |
| `minTurnsBetween` | number | `1` | 两次复盘之间至少间隔多少个可复盘回合 |
| `minMinutesBetween` | number | `2` | 两次复盘之间至少间隔多少分钟 |
| `maxMessages` | number | `24` | 快照保留的最近消息条数 |
| `maxChars` | number | `24000` | 单次复盘快照字符上限 |
| `reviewTimeoutSeconds` | number | `180` | 单次复盘超时 |
| `reviewModel.provider` | string | `""` | 复盘专用模型 provider；留空继承当前会话模型 |
| `reviewModel.model` | string | `""` | 复盘专用模型名；留空继承当前会话模型 |
| `reviewModel.reasoningEffort` | string | `""` | 透传给宿主的 reasoning effort |
| `curatorEnabled` | boolean | `true` | 是否启用生命周期维护 |
| `consolidate` | boolean | `false` | 定时 curator 是否自动跑建伞合并 |
| `consolidateDryRun` | boolean | `true` | 建伞合并只出计划、不改盘 |
| `staleAfterDays` | number | `14` | 多少天未使用标记 `stale` |
| `archiveAfterDays` | number | `30` | 多少天未使用移入 `.archive/`（不删除） |

环境变量（全部可选）：

| 变量 | 作用 |
|---|---|
| `DSH_EVOLUTION_BASE_URL` | OpenAI-compatible 辅助端点（如 `https://host/v1`）。不设则复盘走宿主 subagent fork |
| `DSH_EVOLUTION_API_KEY` | 辅助端点的 Bearer token |
| `DSH_EVOLUTION_MODEL` | 辅助端点使用的模型名 |
| `DSH_EVOLUTION_PORT` | 独立手机端服务的固定端口，默认 `18890` |
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh` |

### 命令与工具

`/evolution` 子命令：`brief [name]` / `drafts`、`refine <name> <批示>`、`approve <name> <批示>`（`promote` 同义，同样必须带批示）、`reject <name> <批示>`（`discard` 同义）、`ledger`、`skills`、`adopt <name>`、`disown <name>`、`rollback <id>`、`review`、`consolidate [--apply]`、`status`（默认）。

`evolution_review_center` 工具面向聊天端 / 手机端：`action` 取 `brief`、`interactive_review`（默认）、`refine`、`approve`、`reject`。

---

## 已知限制

- **辅助通道需要你自己配**：不带任何网关地址或凭据。不设 `DSH_EVOLUTION_BASE_URL` 时复盘走宿主 subagent fork，走不了低延迟辅助模型那条路。
- **闸门挡不住「没价值」**：四道闸门只做静态检查（命名、frontmatter、禁词、体积），「这条经验值不值得记」仍由模型判断，草稿需要人看。
- **界面只有中文**：`locale/en.json` 只覆盖插件名与描述，工作台没有英文 UI。
- **交互卡片依赖宿主**：`evolution_review_center` 的卡片走宿主 `userQuestions` 服务；宿主没有这个服务时退化为返回中文简报文本，需要用户直接回复批示。
- **本地 HTTP 无鉴权**：固定端口服务绑 `0.0.0.0:18890`，供本机或可信网络使用；端口被占用时静默跳过。
- **`mode: apply` 会直接改正式技能库**：只对 `metadata.createdBy: agent` 的技能生效，默认仍是 `draft`。
- **归档不释放磁盘**：移进 `.archive/`，要回收得自己删。
- **正文上限 24000 字符**：超了必须拆到 `references/`。

---

## 开发

```bash
npm test                # 70 个单元测试（node --test test/*.test.js）
npm run audit:parity    # 41 项能力对齐审计（37 项 Hermes 能力 + 4 项 DSH 独有）
npm run audit:prompts   # 两段提示词逐字节保真度（LESSON_LAYER_BLOCK / _DO_NOT_CAPTURE_BLOCK）
npm run sanitize        # 脱敏门禁，0 命中才通过
```

需要 Node ≥ 20.11（`tools/*.mjs` 用 `import.meta.dirname`）。CI 会跑语法检查、70 个测试、两道审计和脱敏门禁。

### 能力对齐与审计

`npm run audit:parity` 逐项核对 Hermes 能力是否落地，并列出 4 项 DSH 独有能力；`npm run audit:prompts` 把 `lib/prompts.js` 里的两段提示词与 `vendor/hermes/background_review.py` 的原文逐字节比对（当前 2098 / 1690 字符全等）。

`vendor/hermes/` 是 Nous Research `hermes-agent` 的逐字副本（MIT），见 [`vendor/hermes/PROVENANCE.md`](./vendor/hermes/PROVENANCE.md)。

---

## License

[MIT](./LICENSE)。`vendor/hermes/` 下的参考源码来自 Nous Research `hermes-agent`，同样遵循 MIT。
