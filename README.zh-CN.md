# ISIC 产业结构分析

[English](./README.md) | **中文**

基于 **ISIC Rev.5** 产业结构分类的交互式桑基图，四层下钻，一直落到一批真实公司。

- **22 门类** → **87 大类** → **258 中类** → **463 小类** → 公司
- 点击任意方块下钻；再点一次、按 `Esc`、或点面包屑即可返回上层。
- 表格视图与图表内容一一对应，任何数值都不必靠悬停才能读到。
- 浅色 / 深色两套主题，均经校验。

## 关于这张图

桑基图**带宽 = 收录公司数**。空小类保留 1 个单位的宽度（灰色的「暂无收录」占位），
这样结构不会因为覆盖度低而从图上消失。于是同一列内宽度始终可比，ISIC 的结构完整性
也不受"我们恰好收录了多少家公司"影响。

配色：每个门类按 ISIC 原序固定占用 8 个色槽之一，筛选不会给幸存者重新上色。
四个层级把该色相向底色混合出深浅：门类最深、小类最浅，因此一个门类读起来是一条
可辨认的色带。

## 数据 —— 信任任何一个数字之前请先读这里

这份数据的两半**来源不同**，这一点很重要：

| 部分 | 来源 | 可信度 |
|---|---|---|
| 分类树（代码、层级、顺序、英文名） | 联合国统计司 ISIC Rev.5 官方结构文件 | 权威，脚本生成 |
| 中文名（`isicRev5.zh.ts`） | 人工翻译 | 人工成果，可能滞后于标准 |
| **公司 → ISIC 小类 的归属** | **逐家人工判定** | **主观。**没有任何公开源发布公司的 ISIC 码 |
| 公司身份字段（`gleif` / `sec`） | GLEIF 法人库（LEI）、SEC EDGAR | 权威，按名称匹配 |
| 中文业务描述 | 人工撰写 | 主观 |

GLEIF 与 SEC 都已实测：**两者都不提供 ISIC 分类**（SEC 的 `sic` 是完全另一套体系）。
任何"自动归类"都只能靠关键词猜，所以归类走人工种子清单，采集脚本只做身份字段富化。
未匹配到的公司保留种子值，绝不推算。

归类按主营业务活动就近判定。多元化集团确实可能跨类经营。

## 快速开始

```bash
npm install
npm run dev          # http://localhost:5183
```

```bash
npm run typecheck    # tsc -b --noEmit
npm run build        # typecheck + vite build
```

## 数据管线

脚本**只在本地手动跑**，不进构建，所以 `npm run build` 离线可用。

```bash
npm run fetch:isic   # 下载 UN Rev.5 结构 → src/data/isicRev5.generated.ts
npm run build:zh     # 合并人工译名    → src/data/isicRev5.zh.ts
npm run check:zh     # 同上，但只校验不写文件（便于接 CI）
npm run collect      # 富化公司种子      → src/data/companies.generated.json
```

三个脚本都是**幂等**的：重跑产出逐字节一致。加 `--offline` 可只读
`scripts/cache/`（已 git 忽略），完全不走网络。

- `scripts/fetch-isic.mjs` 断言 `22 / 87 / 258 / 463` 以及父子前缀不变量；
  下载异常会**直接中止**，不会产出一棵残缺的树。
- `scripts/enrich-companies.mjs` 读 `scripts/seed/companies.seed.json`（唯一人工维护的
  真值），查询 GLEIF 与 SEC，写出生成文件与 `scripts/collect-report.md`，报告里列出
  每一家未能匹配的公司。名称匹配拒绝猜测：分数过低、或与次优解打平，都判为未匹配。

要改公司数据：改种子清单，再跑 `npm run collect`。**不要**直接编辑
`companies.generated.json`。

## SQLite 建库与 API（可选）

同样这 830 个节点 / 150 家公司，也可以从本地 SQLite 库提供。**这是增强，不是必需**
——没有它时页面完全走内存数据（见下文「宕机回落」）。

```bash
npm run db     # 建库 scripts/cache/industry.db（生成物，已 git 忽略）
npm run api    # 只读暴露该库 → http://127.0.0.1:5184
```

库不存在时 `npm run api` 会先自动建一次，所以 `npm run db` 只在需要手动重建时才跑。
两者都要求 **Node ≥ 22.5**（用到实验性的 `node:sqlite`），因此 npm script 会替你带上
`--experimental-sqlite`。请走 npm script，不要直接 `node server/index.mjs`。

`scripts/build-db.mjs` 与采集脚本同一套哲学：**断言而非降级**。层级数量对不上
（`22 / 87 / 258 / 463`）、父子前缀不成立、或某家公司的 `classCode` 不在树里，任一
条都直接中止。它的幂等是**查询结果一致**，不是文件字节一致——SQLite 内部页序不保证，
所以用 `DROP`+`CREATE` 重建而不是删文件（Windows 上另一连接占用时 unlink 会 `EBUSY`）。

### 接口

只读、只允许 `GET`。代码、id、`q`、limit 一律先过白名单校验再进 SQL；非法入参返回
`400`，单个请求出错也不会把进程带崩。

| 路由 | 返回 |
|---|---|
| `/api/health` | `{ ok, companies, isicNodes, coveredClasses, builtAt }` —— 探测用 |
| `/api/stats` | 各层级节点数、公司数、国家数、已覆盖小类数 |
| `/api/companies` | 按 `section` / `division` / `group` / `class` 过滤，另有 `q`、`limit`、`offset` |
| `/api/companies/:id` | 单家公司 |
| `/api/isic` | `?parent=<code>` 的子节点；不传则给门类 |
| `/api/isic/tree` | 全树一次给全（约 90 KB） |
| `/api/isic/:code/companies` | 该代码下的全部公司（任意层级） |
| `/api/search/companies` | 名称子串搜索，`q` + `limit` |

### 宕机回落

`src/lib/api.ts` **每次页面加载只探测一次** `/api/health`，之后不再发多余请求。探测失败
就永久走本地内存路径，API 等同于不存在。每次调用还会判 `res.ok` 与 `content-type`，
带 3s 超时，任何失败返回 `null`，由调用方回落到 `src/data/companies.ts`。

「只探测一次」而不是「每次调用 try/catch」是有原因的：API 没起时 Vite 的 proxy 返回的
是**空 body 的 500**，不是断连。只看网络异常会把这个 500 误当成功，还会让终端刷一片
proxy error。`NodeCard` 与 `SearchBar` 各自回落到本地查询；关掉 API 后图表、下钻、
详情、搜索全部正常，**控制台零错误**。

## 目录结构

```
src/data/isicRev5.generated.ts   UN 官方结构（生成）
src/data/isicRev5.zh.ts          中文名（生成）
src/data/isic.ts                 分类树 + O(1) 上级查询
src/data/companies.generated.json  富化后的公司（生成）
src/data/companies.ts            类型化读取 + 范围查询
src/lib/sankeyModel.ts           节点/边 + 带宽语义
src/lib/sankeyOption.ts          ECharts option
src/lib/api.ts                   API 客户端 + 一次性探测（可选）
src/App.tsx                      focus 状态机、面包屑、面板
src/components/                  图表、公司列表、详情、表格视图
scripts/                         离线采集管线
scripts/build-db.mjs             SQLite 建库（重断言、幂等）
server/index.mjs                 库之上的只读 JSON API
```

## 许可

分析代码可自由参考；ISIC 结构版权归联合国统计司。公司数据归各自登记机构所有。
