import { defineConfig } from 'vitest/config'

// 前端单元测试独立于 Vite 构建配置:被测模块均为纯逻辑(realtime 协议层、
// utils),不经 DOM/资源管线。引入 DOM 依赖的组件测试时再切 environment。
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
