<div align="center">

# Walnut CMS

**专为 Cloudflare Workers、D1 与 R2 打造的轻量级边缘原生 CMS。**

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-v0.9.0--beta.1-orange.svg)](#当前状态)
[![Runtime](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020.svg)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#开源协议)

[项目官网](https://walnut.meirgoo.com) · [在线演示](https://walnut-demo.meirgoo.com) · [反馈问题](https://github.com/meirgoo/walnut-cms/issues)

</div>

> **Beta 提示 (`v0.9.0-beta.1`)**：Walnut CMS 社区版当前处于公测阶段。核心引擎、多站点架构与官方 `Univers` 主题已在线上稳定运行，部分文档与交互细节仍在持续打磨中，欢迎试用并提交 Issue 反馈。

<!-- 部署演示站后在此替换为实际亮/暗模式截图 -->
<!-- ![Walnut CMS 预览](./docs/screenshots/preview-light.png) -->

---

## 为什么做 Walnut CMS？

传统自托管 CMS 往往需要长期维护一台 VPS、数据库与脆弱的插件生态；而静态站点生成器（SSG）又把每一次轻量记录都变成了拉仓、构建、推送的繁琐流程。

**Walnut CMS** 基于 Cloudflare 边缘生态从零设计，坚持**低维护、高自洽、数据与样式彻底解耦**的产品理念：

- **边缘原生，极低资源开销**：完全运行在 Cloudflare Workers + D1 + R2 上，零 VPS 维护成本。常规运行内存稳定在 **4 MB 以内**，P99 CPU 耗时 **< 10 ms**，公开页无缓存整页传输体积仅 **约 58 KB**，对 Cloudflare 免费额度极为友好。
- **三位一体的混合内容模型**：在一个工作台里自然融合三种互补的内容形态：
  - **长文 (Articles)**：支持 Markdown 扩展容器、自动目录大纲（TOC）、版本快照、多语种互译组与 `[[Wiki]]` 双向内链。
  - **微内容 (Micros)**：无需标题与独立路由的轻量动态与闪念流，支持自由文本 `progress` 状态徽章。
  - **数据集 (Datasets)**：基于 D1 JSON1 的自定义结构化 Schema，轻松管理开源项目、作品集、工具目录或书影音清单。
- **数据与主题解耦 + 槽位装配**：主题仅声明骨架插槽（`header` / `subnav` / `main` / `sidebar` / `footer`）与组件契约，业务数据通过 `@api:` 协议与母版页（`@slot:page_content`）自由装配。支持 ZIP 与 Git 仓库（含私有令牌）一键导入换皮，切换主题零数据迁移成本。
- **社区版无限制多站点**：单个 Worker 实例即可同时托管你的个人主页、项目官网与演示站，各站点域名、路由缓存、媒体资产与主题配置彼此隔离。
- **开箱即用的安全基线**：首次初始化（`/admin/setup`）与后台访问原生强制对接 **Cloudflare Access（零信任鉴权）**，内置 RBAC 权限控制、CSRF 防护与租户隔离。

---

## 内置 `@api:` 数据直连协议

无需编写额外胶水接口，在页面编辑器中即可将实时数据绑定至任意主题组件：

| 协议语法 | 说明 |
| :--- | :--- |
| `@api:articles:limit=6` | 拉取最新已发布文章（支持 `locale`、`folder` 等过滤参数） |
| `@api:micro:limit=6` | 拉取最新无标题微内容动态 |
| `@api:dataset:schema=projects&limit=12` | 按自定义 Schema 标识查询结构化数据集条目 |
| `@api:feed:types=article,micro&limit=20` | 聚合混排多类型内容并按时间倒序输出时间线 |
| `@api:media:limit=3` | 拉取 R2 中的站点公开媒体资产 |

---

## 快速开始

### 前置条件

- 拥有一个 [Cloudflare](https://dash.cloudflare.com/) 账号（已开通 Workers、D1、R2 与 Zero Trust Access；Zero Trust 免费档自带 50 个活跃用户席位，个人使用免费）
- 本地安装 Node.js `>= 20`

### 第一步：配置 Cloudflare Access（初始化必填）

为保证无服务器架构下的后台安全，Walnut CMS 在首次进入 `/admin/setup` 及管理后台时**强制校验 Cloudflare Access 身份令牌**。

1. 在 Cloudflare 控制台提前点开 Workers & Pages → Analytics Engine 启用

1. 进入 **Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted**。
2. 在 **Public Hostname** 填入你的站点域名，并将 **Path（路径）** 填写为 **`admin`** *（注意：切勿写成 `/admin*` 或带 `*` 通配符；Cloudflare Access 默认即为前缀匹配，加上 `*` 会导致无法匹配 `/admin/setup`）*。
3. 在 **Policies** 新建一条策略，将 **Action** 设为 **Allow** *（不要选 Bypass）*，并在 Include 规则中填入你的邮箱。
4. 记录你的 **Team Name**（`CF_ACCESS_TEAM_NAME`，**只填前缀**，例如 `myteam.cloudflareaccess.com` 只需填 `myteam`，不要带 `https://` 或后缀）。
5. 在应用的 **Overview** 页面复制 **Application Audience (AUD) Tag**（`CF_ACCESS_AUD`）*（强烈建议配置，用于将 JWT 验签严格锁定至当前应用，防止同团队下其他应用串权）*。

> **多站点小技巧**：如果同一个 Worker 托管了多个站点，只需在**同一个** Access 应用的 Public Hostnames 里添加对应域名（路径均填 `admin`），即可共用同一套 `CF_ACCESS_AUD`。

### 第二步：一键部署或源码启动

#### 方式一：使用发行包一键部署（推荐）

前往 [Releases](https://github.com/meirgoo/walnut-cms/releases) 下载并解压 `walnut-cms-community.tar.gz`，在根目录运行零依赖交互式部署向导：

```bash
node deploy.mjs          # 自动识别系统语言 (zh / en)
node deploy.mjs --lang=zh
```

向导会自动完成登录状态检查、D1/R2 资源创建或复用、已有密钥保留、增量数据库迁移与主题静态资产同步。

#### 方式二：从源码本地开发与手动部署

```bash
git clone [https://github.com/](https://github.com/)meirgoo/walnut-cms.git
cd walnut-cms
npm install

# 将官方 Univers 主题静态资产同步至本地 R2
node scripts/sync-theme-assets.mjs --local

# 启动本地开发服务
npm run dev
```

从源码手动部署至远程 Cloudflare：

```bash
npm run deploy
# 确保远程 R2 已同步官方主题静态资产
node scripts/sync-theme-assets.mjs --remote
```

修改 `wrangler.jsonc` 绑定后如需重新生成 TypeScript 类型定义：

```bash
npm run cf-typegen
```

### 第三步：完成初始化并开始定制

1. 访问 `https://你的域名/admin/setup`（经由 Cloudflare Access 验证通过后）完成管理员创建与默认域名认领。
2. 开箱内置官方全功能旗舰主题 **`Univers`**（亮/暗模式自适应、19 个单职责自适应组件、5 套页面蓝图）以及一套可直接交互的向导内容。
3. 所有预置示例文章、页面与微内容均归类在 `folder: guide` 下，熟悉系统后可在后台按目录筛选并一键批量清理。

---

## 社区版与 Open-Core 规划

Walnut CMS 采用务实的 **Open-Core** 模式，以确保项目在低运维前提下长期独立演进：

- **社区版（免费开源）**：完整的内容引擎（长文 / 微内容 / 数据集）、无限制多站点托管、可视化槽位装配、组件 `@api:` 直连、Git/ZIP 主题导入、表单提交与基础 Webhook 转发，以及官方 `Univers` 主题。
- **商业扩展与精品主题（规划中）**：高级自动化业务流、对外开放 API 网关、白标定制、R2 自动备份还原工作流，以及通过私有 Git/ZIP 交付的独立精品主题包。

---

## 当前状态

- 当前公测版本：**`v0.9.0-beta.1`**
- 如在部署、R2 静态资源同步或日常使用中遇到问题，欢迎提交 [Issue](https://github.com/meirgoo/walnut-cms/issues)。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
