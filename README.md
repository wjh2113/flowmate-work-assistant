# FlowMate 工作助手（H5 / PWA）

一套代码兼容 Android、iPhone、iPad 和桌面浏览器。支持 AI 语音创建任务、个人完成情况、团队分派与跟进、每日工作总结和次日智能规划；可安装到手机主屏幕。

## 开发与构建

```bash
npm install
npm run dev
npm run build
npm start
```

## 配置 AI

复制 `.env.example` 为 `.env`，并填写阿里云百炼 API Key：

```env
DASHSCOPE_API_KEY=sk-your-bailian-key-here
QWEN_TEXT_MODEL=qwen3.7-plus
QWEN_ASR_MODEL=qwen3-asr-flash
```

密钥只由 `server/index.mjs` 读取，绝不能添加 `VITE_` 前缀或放进前端代码。开发环境执行 `npm run dev` 会同时启动 H5 和千问服务；生产环境先执行 `npm run build`，再执行 `npm start`。

也可以在应用中进入「我的 → 设置」选择管理员配置好的内置模型。API Key 只在独立的 `/admin` 后台填写，不会出现在工作台。

AI 语音流程：浏览器录音 → 服务端发送 Base64 音频给 `qwen3-asr-flash` → `qwen3.7-plus` 提取任务内容、负责人、截止时间和优先级。浏览器原生识别仅作为服务异常时的临时回退。

AI 工作复盘每天自动生成一次并缓存在本机，也可以手动重新生成；建议的明日事项可一键加入任务列表。

## 本地存储：PostgreSQL

必须配置 `DATABASE_URL`。先确保 PostgreSQL 已启动，再执行：

1. `npm run setup:postgres`（可用 `PG_ADMIN_URL`、`FLOWMATE_DB_PASSWORD` 覆盖默认值）
2. 把脚本打印的 `DATABASE_URL=...` 写入 `.env`
3. `npm start`；`GET /api/health` 中 `storage.mode` 应为 `postgres`

```env
DATABASE_URL=postgres://flowmate:CHANGE_ME@127.0.0.1:5432/flowmate
# PG_ADMIN_URL=postgres://jonny@127.0.0.1:5432/postgres
# FLOWMATE_DB_PASSWORD=CHANGE_ME
```

部署要求 Node.js 22.13 或更高版本，推荐 Node.js 24。

### 管理后台

管理后台是独立站点，不和工作台共用登录态。打开 `/admin`，使用管理员账号单独登录。

- 用户在「设置 → 大模型」只选择内置模型；API Key 只在 `/admin` 的「模型权重」里配置
- 每次调用按接口返回的 token 自动计费：`积分 = Token × 权重`
- 可用环境变量：`ADMIN_EMAILS=a@b.com,c@d.com`（启动时升为管理员）、`DEFAULT_SIGNUP_POINTS=50000`

## 可选：Supabase 云端存储

项目使用 Supabase PostgreSQL、Auth 和 Realtime。配置步骤：

1. 创建一个 Supabase 项目。
2. 在 Supabase SQL Editor 中执行 `supabase/migrations/001_initial_schema.sql`。
   如果此前已经执行过初始脚本，再执行 `supabase/migrations/002_task_timing.sql`，为任务增加预估时间和开始时间字段。
3. 在项目的 API 设置中复制 Project URL 和 Anon/Publishable Key，写入 `.env`：

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
```

4. 在 Authentication → URL Configuration 中，将本地 `http://localhost:5173` 和正式网站 HTTPS 地址加入 Redirect URLs。
5. 重新执行 `npm run dev`。

配置后应用会先显示邮箱登录页。用户首次登录时会自动创建个人资料和团队工作区；任务、状态变化和 AI 日报以云端数据库为准，并通过 Realtime 同步到其他已登录设备。本地 `localStorage` 只作为离线缓存。

前端只允许使用 Anon/Publishable Key；不要把 Supabase `service_role` 密钥放入任何 `VITE_` 环境变量。数据库表均已启用 RLS，用户只能访问自己所属团队的数据。

生产部署时将 `dist/` 发布到任意 HTTPS 静态站点（Vercel、Cloudflare Pages、阿里云 OSS 等）。语音和 PWA 安装能力要求 HTTPS，本机 `localhost` 除外。

## 手机安装

- Android Chrome：浏览器菜单 → 安装应用 / 添加到主屏幕。
- iPhone Safari：分享 → 添加到主屏幕。

录音要求 HTTPS（本机 `localhost` 除外）。若未配置 Supabase，应用会以本地体验模式运行；配置后任务与日报使用云端存储。
