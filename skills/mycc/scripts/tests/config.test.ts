/**
 * 配置管理测试
 *
 * 测试 loadConfig, deleteConfig, getConfigDir 等函数
 * 以及 generateCode, generateDeviceId, generateToken
 *
 * 迁移自 2-Projects/P08-cc小程序/tests/backend/config.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { loadConfig, deleteConfig, getConfigDir } from '../src/config.js'
import { generateCode, generateDeviceId, generateToken } from '../src/utils.js'
import type { DeviceConfig } from '../src/types.js'

// 测试目录设置
const TEST_DIR = join(tmpdir(), 'mycc-test-' + Date.now())
const CONFIG_DIR = join(TEST_DIR, '.claude', 'skills', 'mycc')
const CONFIG_PATH = join(CONFIG_DIR, 'current.json')

describe('配置管理', () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('getConfigDir', () => {
    it('找到 cwd/.claude/skills/mycc 目录', () => {
      const dir = getConfigDir(TEST_DIR)
      expect(dir).toBe(CONFIG_DIR)
    })
  })

  describe('loadConfig', () => {
    it('配置文件不存在时返回 null', () => {
      const result = loadConfig(TEST_DIR)
      expect(result).toBeNull()
    })

    it('配置文件存在时正确读取', () => {
      const config: DeviceConfig = {
        deviceId: 'test123abc',
        pairCode: 'ABC123',
        routeToken: 'XYZ789',
        createdAt: '2026-01-28T00:00:00Z'
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(config))

      const result = loadConfig(TEST_DIR)
      expect(result).not.toBeNull()
      expect(result?.deviceId).toBe('test123abc')
      expect(result?.pairCode).toBe('ABC123')
      expect(result?.routeToken).toBe('XYZ789')
    })

    it('缺少 deviceId 时返回 null', () => {
      const config = {
        pairCode: 'ABC123',
        createdAt: '2026-01-28T00:00:00Z'
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(config))

      const result = loadConfig(TEST_DIR)
      expect(result).toBeNull()
    })

    it('缺少 pairCode 时返回 null', () => {
      const config = {
        deviceId: 'test123abc',
        createdAt: '2026-01-28T00:00:00Z'
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(config))

      const result = loadConfig(TEST_DIR)
      expect(result).toBeNull()
    })

    it('JSON 格式错误时返回 null', () => {
      writeFileSync(CONFIG_PATH, 'not valid json')

      const result = loadConfig(TEST_DIR)
      expect(result).toBeNull()
    })
  })

  describe('deleteConfig', () => {
    it('删除存在的配置文件', () => {
      writeFileSync(CONFIG_PATH, '{}')
      expect(existsSync(CONFIG_PATH)).toBe(true)

      deleteConfig(TEST_DIR)
      expect(existsSync(CONFIG_PATH)).toBe(false)
    })

    it('文件不存在时不报错', () => {
      expect(() => deleteConfig(TEST_DIR)).not.toThrow()
    })
  })
})

describe('Token 格式验证', () => {
  describe('generateCode', () => {
    it('生成 6 位连接码', () => {
      const code = generateCode()
      expect(code).toHaveLength(6)
      expect(code).toMatch(/^[A-Z0-9]{6}$/)
    })

    it('不包含易混淆字符 (I, O, 0, 1)', () => {
      for (let i = 0; i < 100; i++) {
        const code = generateCode()
        expect(code).not.toMatch(/[IO01]/)
      }
    })
  })

  describe('generateToken', () => {
    it('生成 6 位 token（与 generateCode 相同）', () => {
      const token = generateToken()
      expect(token).toHaveLength(6)
      expect(token).toMatch(/^[A-Z0-9]{6}$/)
    })
  })

  describe('generateDeviceId', () => {
    it('生成 12 位设备 ID', () => {
      const deviceId = generateDeviceId()
      expect(deviceId).toHaveLength(12)
      expect(deviceId).toMatch(/^[a-z0-9]{12}$/)
    })
  })
})

describe('设备持久化逻辑', () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('首次启动：生成新配置', () => {
    const existingConfig = loadConfig(TEST_DIR)
    expect(existingConfig).toBeNull()

    const isFirstRun = existingConfig === null
    expect(isFirstRun).toBe(true)
  })

  it('后续启动：复用配置', () => {
    const config: DeviceConfig = {
      deviceId: 'existing123',
      pairCode: 'OLD456',
      routeToken: 'TOKEN99',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    const existingConfig = loadConfig(TEST_DIR)
    expect(existingConfig).not.toBeNull()
    expect(existingConfig?.deviceId).toBe('existing123')
    expect(existingConfig?.pairCode).toBe('OLD456')

    const isFirstRun = existingConfig === null
    expect(isFirstRun).toBe(false)
  })

  it('--reset 后：重新生成配置', () => {
    const config: DeviceConfig = {
      deviceId: 'existing123',
      pairCode: 'OLD456',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    deleteConfig(TEST_DIR)

    const existingConfig = loadConfig(TEST_DIR)
    expect(existingConfig).toBeNull()
  })
})

describe('authToken 持久化', () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('loadConfig 正确读取 authToken', () => {
    const config: DeviceConfig = {
      deviceId: 'test123abc',
      pairCode: 'ABC123',
      routeToken: 'XYZ789',
      authToken: '3PQT5D',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    const result = loadConfig(TEST_DIR)
    expect(result).not.toBeNull()
    expect(result?.authToken).toBe('3PQT5D')
  })

  it('authToken 存在时表示已配对', () => {
    const config: DeviceConfig = {
      deviceId: 'test123abc',
      pairCode: 'ABC123',
      routeToken: 'XYZ789',
      authToken: 'TOKEN123',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    const result = loadConfig(TEST_DIR)
    const isPaired = !!result?.authToken
    expect(isPaired).toBe(true)
  })

  it('authToken 不存在时表示未配对', () => {
    const config: DeviceConfig = {
      deviceId: 'test123abc',
      pairCode: 'ABC123',
      routeToken: 'XYZ789',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    const result = loadConfig(TEST_DIR)
    const isPaired = !!result?.authToken
    expect(isPaired).toBe(false)
  })

  it('后端重启后正确恢复配对状态', () => {
    const config: DeviceConfig = {
      deviceId: 'device123',
      pairCode: 'PAIR01',
      routeToken: 'ROUTE1',
      authToken: 'AUTH99',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    const loadedConfig = loadConfig(TEST_DIR)

    expect(loadedConfig?.deviceId).toBe('device123')
    expect(loadedConfig?.pairCode).toBe('PAIR01')
    expect(loadedConfig?.routeToken).toBe('ROUTE1')
    expect(loadedConfig?.authToken).toBe('AUTH99')

    const shouldRestorePaired = !!loadedConfig?.authToken
    expect(shouldRestorePaired).toBe(true)
  })

  it('--reset 后 authToken 也被清除', () => {
    const config: DeviceConfig = {
      deviceId: 'device123',
      pairCode: 'PAIR01',
      routeToken: 'ROUTE1',
      authToken: 'AUTH99',
      createdAt: '2026-01-28T00:00:00Z'
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config))

    deleteConfig(TEST_DIR)

    const result = loadConfig(TEST_DIR)
    expect(result).toBeNull()
  })
})
