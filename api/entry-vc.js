/**
 * Vercel Edge Functions 入口
 * 复用 index.js 的核心逻辑
 */

import { handleRequest } from './index.js';

export default {
  async fetch(request) {
    return handleRequest(request);
  }
};
