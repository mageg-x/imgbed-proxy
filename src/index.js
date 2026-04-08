/**
 * Cloudflare Worker 代理服务
 *
 * 提供三种代理功能：
 * 1. 下载代理 (/{base58_encoded_host}/...) - 转发 HTTP GET 请求，添加缓存头
 * 2. 上传代理 (/proxy/{base58_encoded_host}/...) - 转发 multipart/form-data 上传请求
 * 3. S3 代理 (/s3-proxy) - 接收 S3 签名请求，重新签名后转发到 S3/R2/COS
 *
 * 目标主机通过 Base58 编码混淆，支持 Telegram、Discord 等多种存储后端
 */

import { AwsClient } from 'aws4fetch';

// ==================== Base58 编解码 ====================

/** Base58 字母表（不含 0OIl 容易混淆的字符） */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = ALPHABET.length;

/** 字符到值的映射，用于解码 */
const CHAR_TO_VALUE = new Map();
for (let i = 0; i < ALPHABET.length; i++) {
    CHAR_TO_VALUE.set(ALPHABET[i], i);
}

/**
 * Base58 解码
 * @param {string} str - Base58 编码的字符串
 * @returns {string} 解码后的原始字符串
 * @throws {Error} 遇到无效字符时抛出
 */
function base58Decode(str) {
    let result = 0n;
    for (const ch of str) {
        const val = CHAR_TO_VALUE.get(ch);
        if (val === undefined) {
            throw new Error(`invalid char: ${ch}`);
        }
        result = result * BigInt(BASE) + BigInt(val);
    }
    const bytes = [];
    while (result > 0n) {
        bytes.unshift(Number(result & 0xFFn));
        result >>= 8n;
    }
    // 处理前导 1（代表零字节）
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
        bytes.unshift(0);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

// ==================== 下载代理 ====================

/**
 * 处理下载请求
 *
 * URL 格式: /{base58_encoded_host}/{file_path}
 * 示例: /AXJnNj1p7gNFB24iwS1NQ1rucwwcJEtSS/images/logo.png
 *
 * 功能：
 * - 解码目标主机
 * - 转发请求到目标服务器
 * - 添加缓存头（Cache-Control: public, max-age=31536000）
 * - 添加 CORS 头（Access-Control-Allow-Origin: *）
 *
 * @param {URL} url - 解析后的请求 URL
 * @returns {Response} 代理响应
 */
async function handleDownload(url) {
    // 解析 URL 路径: /{encoded_host}/{file_path}
    const pathname = url.pathname.slice(1);  // 去掉开头的 /
    const parts = pathname.split('/');

    if (parts.length < 2) {
        console.error(`download: insufficient path parts, pathname=${pathname}`);
        return new Response('path format: /{encoded_host}/{file_path}', { status: 400 });
    }

    const encodedHost = parts[0];
    const filePath = parts.slice(1).join('/');

    // Base58 解码目标主机
    let targetHost;
    try {
        targetHost = base58Decode(encodedHost);
    } catch (e) {
        console.error(`download: base58 decode failed, encoded=${encodedHost}, error=${e.message}`);
        return new Response(`base58 decode failed: ${e.message}`, { status: 400 });
    }

    // 构造目标 URL
    // 去掉 targetHost 末尾的斜杠，拼接文件路径
    const targetUrl = targetHost.replace(/\/$/, '') + '/' + filePath + (url.search || '');

    // 发起请求
    let response;
    try {
        response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Cloudflare-Worker-Proxy' }
        });
    } catch (e) {
        console.error(`download: fetch failed, target=${targetUrl}, error=${e.message}`);
        return new Response(`fetch failed: ${e.message}`, { status: 502 });
    }

    // 构造代理响应，保留原响应体和状态
    const proxyResponse = new Response(response.body, response);
    proxyResponse.headers.set('Cache-Control', 'public, max-age=31536000');
    proxyResponse.headers.set('Access-Control-Allow-Origin', '*');

    return proxyResponse;
}

// ==================== 上传代理 ====================

/**
 * 需要移除的请求头（Cloudflare 相关或敏感的代理信息）
 *
 * 这些头字段不应该传递给目标服务器：
 * - host: 目标服务器地址，已通过 URL 传递
 * - cf-*: Cloudflare 内部头
 * - x-forwarded-*: 代理相关头
 */
const HEADERS_TO_REMOVE = [
    'host',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'cf-worker',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip'
];

/**
 * 处理上传请求（multipart/form-data）
 *
 * URL 格式: /proxy/{base58_encoded_host}/{request_path}
 * 示例: /proxy/AXJnNj1p7gNFB24iwS1NQ1rucwwcJEtSS/botTOKEN/sendDocument?chat_id=123
 *
 * 功能：
 * - 解码目标主机
 * - 转发所有请求头（除敏感字段）
 * - 透传请求方法和请求体
 * - 添加 CORS 头
 *
 * @param {Request} request - 原始请求
 * @param {URL} url - 解析后的请求 URL
 * @returns {Response} 代理响应
 */
async function handleUpload(request, url) {
    // 解析 URL 路径: /proxy/{encoded_host}/{request_path}
    const pathname = url.pathname.slice('/proxy/'.length);
    const parts = pathname.split('/');

    if (parts.length < 2) {
        console.error(`upload: insufficient path parts, pathname=${pathname}`);
        return new Response('path format: /proxy/{encoded_host}/{path}', { status: 400 });
    }

    const encodedHost = parts[0];
    const requestPath = parts.slice(1).join('/');

    // Base58 解码目标主机
    let targetHost;
    try {
        targetHost = base58Decode(encodedHost);
    } catch (e) {
        console.error(`upload: base58 decode failed, encoded=${encodedHost}, error=${e.message}`);
        return new Response(`base58 decode failed: ${e.message}`, { status: 400 });
    }

    // 构造目标 URL
    const targetUrl = targetHost.replace(/\/$/, '') + '/' + requestPath + (url.search || '');

    // 构建代理请求头，过滤敏感字段
    const proxyHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
        if (!HEADERS_TO_REMOVE.includes(key.toLowerCase())) {
            proxyHeaders.set(key, value);
        }
    }
    proxyHeaders.set('User-Agent', 'Cloudflare-Worker-Proxy');

    // 发起请求
    let response;
    try {
        response = await fetch(targetUrl, {
            method: request.method,
            headers: proxyHeaders,
            body: request.body,
        });
    } catch (e) {
        console.error(`upload: fetch failed, target=${targetUrl}, error=${e.message}`);
        return new Response(`fetch failed: ${e.message}`, { status: 502 });
    }

    // 构造代理响应，透传所有响应头
    const proxyResponse = new Response(response.body, response);
    for (const [key, value] of response.headers.entries()) {
        proxyResponse.headers.set(key, value);
    }
    proxyResponse.headers.set('Access-Control-Allow-Origin', '*');

    // 移除 Cloudflare 特有的响应头，避免污染
    proxyResponse.headers.delete('cf-cache-status');
    proxyResponse.headers.delete('cf-ray');

    return proxyResponse;
}

// ==================== S3 代理 ====================

/**
 * 处理 S3/R2/COS 对象存储上传请求
 *
 * URL 格式: /s3-proxy
 *
 * 请求头（由 Go 端 S3ProxyTransport 设置）：
 * - X-Target-Url: 目标 S3 URL
 * - X-Aws-Access-Key: AWS Access Key
 * - X-Aws-Secret-Key: AWS Secret Key
 * - X-Aws-Region: AWS 区域（默认 auto）
 * - X-Aws-Service: AWS 服务名（默认 s3）
 * - Content-Type: 请求内容类型
 *
 * 功能：
 * - 解析目标 URL，提取 bucket 和 key
 * - 使用 aws4fetch 计算 AWS SigV4 签名
 * - 发送签名后的 PUT 请求到 S3
 * - 返回 S3 标准的 XML 响应
 *
 * @param {Request} request - 原始请求
 * @returns {Response} S3 响应或错误信息
 */
async function handleS3Proxy(request) {
    // 从请求头提取 AWS 凭证
    const accessKey = request.headers.get("X-Aws-Access-Key");
    const secretKey = request.headers.get("X-Aws-Secret-Key");
    const region = request.headers.get("X-Aws-Region") || "auto";
    const targetUrl = request.headers.get("X-Target-Url");
    const contentType = request.headers.get("Content-Type") || "application/octet-stream";

    // 验证必需参数
    if (!accessKey || !secretKey || !targetUrl) {
        console.error(`s3-proxy: missing credentials, accessKey=${!!accessKey}, secretKey=${!!secretKey}, targetUrl=${!!targetUrl}`);
        return new Response("missing credentials", { status: 400 });
    }

    // 解析目标 URL，提取 bucket 和 key
    let bucket, key;
    try {
        const target = new URL(targetUrl);
        const pathname = target.pathname;
        const host = target.host;

        // 根据主机名判断存储类型
        // 虚拟主机风格: bucket.s3.amazonaws.com, bucket.r2.cloudflarestorage.com, bucket.cos.myqcloud.com
        // 路径风格: s3.amazonaws.com/bucket/key
        if (host.includes(".cos.") || host.includes(".r2.") || host.includes(".s3.")) {
            // 虚拟主机风格（如 R2, COS）
            const parts = host.split(".");
            bucket = parts[0];
            key = pathname.slice(1);  // 去掉开头的 /
        } else {
            // 路径风格（如传统 S3）
            const parts = pathname.slice(1).split("/");
            bucket = parts[0];
            key = parts.slice(1).join("/");
        }
    } catch (e) {
        console.error(`s3-proxy: parse target url failed, targetUrl=${targetUrl}, error=${e.message}`);
        return new Response(`parse target url failed: ${e.message}`, { status: 400 });
    }

    // 读取请求体
    let bodyData;
    try {
        bodyData = await request.arrayBuffer();
    } catch (e) {
        console.error(`s3-proxy: read body failed, error=${e.message}`);
        return new Response(`read body failed: ${e.message}`, { status: 400 });
    }

    // 使用 aws4fetch 计算 AWS SigV4 签名
    const aws = new AwsClient({
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        region: region,
        service: "s3",
    });

    let signedRequest;
    try {
        signedRequest = await aws.sign(targetUrl, {
            method: "PUT",
            headers: {
                "Content-Type": contentType,
                "Content-Length": bodyData.byteLength,
            },
            body: bodyData,
        });
    } catch (e) {
        console.error(`s3-proxy: sign request failed, targetUrl=${targetUrl}, error=${e.message}`);
        return new Response(`sign request failed: ${e.message}`, { status: 500 });
    }

    // 发送签名后的请求到 S3
    let response;
    try {
        response = await fetch(signedRequest);
    } catch (e) {
        console.error(`s3-proxy: s3 fetch failed, targetUrl=${targetUrl}, error=${e.message}`);
        return new Response(`s3 fetch failed: ${e.message}`, { status: 502 });
    }

    // 处理 S3 响应
    if (response.ok) {
        // 构造 S3 标准的 PutObject 响应
        const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<PutObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Key>${key}</Key>
  <ETag>"${Date.now()}"</ETag>
</PutObjectResult>`;
        return new Response(xmlResponse, {
            status: 200,
            headers: {
                "Content-Type": "application/xml",
                "Access-Control-Allow-Origin": "*",
            },
        });
    } else {
        // 透传 S3 错误
        const errorText = await response.text();
        console.error(`s3-proxy: s3 returned error, status=${response.status}, body=${errorText}`);
        return new Response(errorText, {
            status: response.status,
            headers: {
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
}

// ==================== 请求路由 ====================

/**
 * 主请求处理函数
 *
 * 路由规则：
 * - /s3-proxy 或 /s3-proxy/* -> S3 代理
 * - /proxy/* -> 上传代理
 * - 其他 -> 下载代理
 *
 * @param {Request} request - 原始请求
 * @returns {Response} 响应
 */
async function handleRequest(request) {
    const url = new URL(request.url);

    // S3 代理（需要重新签名）
    if (url.pathname === "/s3-proxy" || url.pathname.startsWith("/s3-proxy/")) {
        return handleS3Proxy(request);
    }

    // 上传代理（multipart/form-data 透传）
    if (url.pathname.startsWith('/proxy/')) {
        return handleUpload(request, url);
    }

    // 下载代理（默认）
    return handleDownload(url);
}

// ==================== 导出 ====================

export { handleRequest };
