# imgbed-proxy

imgbed-proxy 代理脚本；支持 Cloudflare Worker 和 Vercel Edge Functions 部署。

## 功能

- **下载代理** - `/{base58_encoded_host}/{file_path}` 转发 HTTP GET 请求，添加缓存头
- **上传代理** - `/proxy/{base58_encoded_host}/{path}` 转发 multipart/form-data 上传请求
- **S3 代理** - `/s3-proxy` 接收 S3 签名请求，重新签名后转发到 S3/R2/COS

## 项目结构

```
imgbed-proxy/
├── src/
│   ├── index.js           # 核心业务逻辑（平台无关）
│   ├── entry-cf.js        # Cloudflare Worker 入口
│   └── entry-vercel.js    # Vercel Edge Functions 入口
├── api/
│   └── [[...path]].js     # Vercel 路由捕获
├── dist/
│   └── bundle.js          # CF 构建输出
├── wrangler.toml          # Cloudflare 配置
├── vercel.json            # Vercel 配置
└── package.json
```

## 部署

### 前置要求

```bash
npm install
```

### 部署到 Cloudflare Worker

#### 方式一：Wrangler CLI

1. 安装 Wrangler CLI 并登录：
```bash
npx wrangler login
```

2. 部署：
```bash
npm run deploy:cf
```

部署完成后，访问 `https://imgbed-proxy.<your-subdomain>.workers.dev`


### 部署到 Vercel

#### 方式一：Vercel CLI

1. 安装 Vercel CLI：
```bash
npm i -g vercel
```

2. 登录并部署：
```bash
vercel login
npm run deploy:vercel
```

#### 方式二：Git 集成（推荐）

1. 将代码推送到 GitHub/GitLab/Bitbucket
2. 在 [Vercel Dashboard](https://vercel.com/dashboard) 导入项目
3. Vercel 会自动检测配置并部署

部署完成后，访问 `https://imgbed-proxy.<your-username>.vercel.app`

## 本地开发

### Cloudflare Worker 本地调试

```bash
npx wrangler dev
```

### Vercel 本地调试

```bash
npx vercel dev
```

## 配置说明

### Cloudflare Worker 配置

配置文件：`wrangler.toml`

```toml
name = "imgbed-proxy"
main = "dist/bundle.js"
compatibility_date = "2026-04-08"
```

### Vercel 配置

配置文件：`vercel.json`

```json
{
  "functions": {
    "api/**/*.js": {
      "runtime": "edge"
    }
  }
}
```

## NPM Scripts

| 命令 | 说明 |
|------|------|
| `npm run build:cf` | 构建 Cloudflare Worker |
| `npm run build:vercel` | Vercel 无需构建（自动处理） |
| `npm run deploy:cf` | 部署到 Cloudflare Worker |
| `npm run deploy:vercel` | 部署到 Vercel |
