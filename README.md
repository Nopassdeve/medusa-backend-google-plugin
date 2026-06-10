# medusa-backend-google-plugin

Medusa v2 插件：一键备份整个网站（数据库 + 代码）到 Google Drive，支持 OAuth 2.0 授权、定时自动备份、一键恢复，以及多店铺 GitHub Webhook 自动部署。

## 功能

| 功能 | 说明 |
|------|------|
| 🗂️ **完整备份** | 数据库（pg_dump）+ 代码文件打包上传，解压后可完整还原 |
| ☁️ **Google Drive** | OAuth 2.0 授权，备份存到你自己的 Google Drive |
| ⏰ **定时备份** | Cron 配置，默认每天凌晨 3 点自动备份 |
| 🔄 **保留策略** | 自动删除超过设定天数的旧备份 |
| ♻️ **一键恢复** | 从 Google Drive 下载并自动恢复数据库和文件 |
| 🏪 **多店铺部署** | GitHub Webhook 触发，`git push` 后所有店铺自动拉取并重启 |
| 🎛️ **管理面板** | Medusa Admin 内置管理界面，无需命令行操作 |

---

## 安装

```bash
npm install github:Nopassdeve/medusa-backend-google-plugin
```

或本地开发时：

```bash
npm install file:../medusa-backend-google-plugin
```

---

## 配置（medusa-config.ts）

```typescript
module.exports = defineConfig({
  modules: [
    {
      resolve: "medusa-backend-google-plugin",
      options: {},
    },
  ],
  admin: {
    extensions: [
      {
        name: "backup-plugin-admin",
        resolve: "medusa-backend-google-plugin/src/admin/index",
      },
    ],
  },
})
```

---

## 获取 Google OAuth Refresh Token

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) → API 和服务 → 凭据
2. 创建 **OAuth 2.0 客户端 ID**（类型选 **Web 应用**）
3. 在「已获授权的重定向 URI」填入：
   ```
   https://你的后台域名/admin/oauth-callback
   ```
4. 启用 **Google Drive API**
5. 在 Medusa Admin → 备份与部署 → 设置中：
   - 填入 Client ID 和 Client Secret
   - 点击「**获取 Token**」按钮，完成 Google 授权
   - 将回调页面显示的 Refresh Token 粘贴回输入框
6. 填入 Google Drive 文件夹 ID，点击「保存并启动定时备份」

---

## 备份内容

解压后的目录结构：

```
lurpes-backup-xxx.tar.gz
├── database.sql            ← 完整数据库（pg_dump）
└── files.zip
    ├── backend/            ← 后端源码、配置、静态文件
    │   ├── src/
    │   ├── medusa-config.ts
    │   ├── package.json
    │   ├── .env
    │   └── static/         ← 产品图片等上传文件
    ├── storefront/         ← 前端源码、配置
    │   ├── src/
    │   ├── next.config.js
    │   └── package.json
    └── server/             ← 服务器配置（Nginx 等）
        └── etc/nginx/...
```

---

## 本地还原步骤

```bash
# 1. 解压
tar -xzf backup-xxx.tar.gz
unzip files.zip

# 2. 恢复数据库（需本地已安装 PostgreSQL）
createdb medusa
psql medusa < database.sql

# 3. 修改 backend/.env（只改本地连接）
# DATABASE_URL=postgres://用户名:密码@localhost:5432/medusa
# REDIS_URL=redis://localhost:6379

# 4. 安装依赖并构建
cd backend && npm install && npm run build
cd ../storefront && npm install && npm run build

# 5. 启动
cd backend && npm start                    # 后台 :9000
cd ../storefront && npm start -- -p 8000   # 前台 :8000
```

**本地依赖：** Node.js 20+、PostgreSQL 14+、Redis

---

## 多店铺自动部署

插件启动时自动通过 GitHub API 注册 Webhook。你只需：

1. 在设置中填入 GitHub Personal Access Token（需要 `admin:repo_hook` 权限）和仓库地址
2. 之后只需 `git push`，所有已安装此插件的店铺自动拉取更新并重启，无需手动登录

---

## 开发

```bash
git clone https://github.com/Nopassdeve/medusa-backend-google-plugin.git
cd medusa-backend-google-plugin
npm install
npm run build    # 编译 src/ → dist/
npm run watch    # 监听模式
```

---

## License

MIT
