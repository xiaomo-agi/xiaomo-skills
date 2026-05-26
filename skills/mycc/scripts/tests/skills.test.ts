/**
 * Skills 模块测试
 *
 * 测试 parseFrontmatter, listSkills 等函数
 * TDD：先写测试，再实现模块
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseFrontmatter, listSkills } from '../src/skills.js'
import type { SkillItem } from '../src/skills.js'

// 测试目录设置
const TEST_DIR = join(tmpdir(), 'mycc-skills-test-' + Date.now())
const SKILLS_DIR = join(TEST_DIR, 'skills')

describe('parseFrontmatter', () => {
  it('正确解析 name 和 description', () => {
    const content = `---
name: morning
description: 每日早间例程
---

# Morning Routine
详细内容...`

    const result = parseFrontmatter(content)
    expect(result.name).toBe('morning')
    expect(result.description).toBe('每日早间例程')
  })

  it('没有 frontmatter 返回空对象', () => {
    const content = `# 没有 frontmatter 的文件
这里只是普通内容`

    const result = parseFrontmatter(content)
    expect(result).toEqual({})
  })

  it('只有 name 没有 description', () => {
    const content = `---
name: test-skill
---

# Test`

    const result = parseFrontmatter(content)
    expect(result.name).toBe('test-skill')
    expect(result.description).toBeUndefined()
  })

  it('空内容返回空对象', () => {
    const result = parseFrontmatter('')
    expect(result).toEqual({})
  })

  it('description 含特殊字符（中文、引号）', () => {
    const content = `---
name: special
description: "触发词：/morning、\"早安\""
---

内容`

    const result = parseFrontmatter(content)
    expect(result.name).toBe('special')
    expect(result.description).toContain('触发词')
  })

  it('只有一个 --- 不构成 frontmatter', () => {
    const content = `---
name: incomplete
没有结束标记`

    const result = parseFrontmatter(content)
    expect(result).toEqual({})
  })

  it('frontmatter 不在文件开头时忽略', () => {
    const content = `一些前置内容
---
name: wrong
description: 不应该被解析
---`

    const result = parseFrontmatter(content)
    expect(result).toEqual({})
  })

  it('description 含冒号但无引号', () => {
    const content = `---
name: tricky
description: 触发词：/morning、早安
---`

    const result = parseFrontmatter(content)
    expect(result.name).toBe('tricky')
    expect(result.description).toBe('触发词：/morning、早安')
  })
})

describe('listSkills', () => {
  beforeEach(() => {
    mkdirSync(SKILLS_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('正常扫描多个 skill 子目录', () => {
    // 创建 3 个 skill 子目录，每个包含 SKILL.md
    const skills = [
      { dir: 'morning', name: 'morning', desc: '早间例程' },
      { dir: 'evening', name: 'evening', desc: '晚间例程' },
      { dir: 'commit', name: 'commit', desc: '提交代码' },
    ]

    for (const s of skills) {
      const dir = join(SKILLS_DIR, s.dir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---
name: ${s.name}
description: ${s.desc}
---

# ${s.name}
`)
    }

    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(3)

    const names = result.map((s: SkillItem) => s.name)
    expect(names).toContain('morning')
    expect(names).toContain('evening')
    expect(names).toContain('commit')
  })

  it('没有 SKILL.md 的子目录被跳过', () => {
    // 有 SKILL.md 的目录
    const validDir = join(SKILLS_DIR, 'valid')
    mkdirSync(validDir, { recursive: true })
    writeFileSync(join(validDir, 'SKILL.md'), `---
name: valid
description: 有效的 skill
---
`)

    // 没有 SKILL.md 的目录
    const emptyDir = join(SKILLS_DIR, 'no-skill-md')
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(emptyDir, 'README.md'), '# Not a skill')

    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('valid')
  })

  it('非目录文件被跳过', () => {
    // 创建一个正常的 skill 目录
    const dir = join(SKILLS_DIR, 'real-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---
name: real-skill
description: 真正的 skill
---
`)

    // 在 skills 目录下放一个普通文件
    writeFileSync(join(SKILLS_DIR, 'not-a-dir.txt'), 'just a file')

    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('real-skill')
  })

  it('空目录返回空数组', () => {
    const result = listSkills(SKILLS_DIR)
    expect(result).toEqual([])
  })

  it('目录不存在时返回空数组', () => {
    const result = listSkills(join(TEST_DIR, 'nonexistent'))
    expect(result).toEqual([])
  })

  it('结果按 name 字母排序', () => {
    const skills = [
      { dir: 'zzz', name: 'zebra', desc: '最后' },
      { dir: 'aaa', name: 'alpha', desc: '最前' },
      { dir: 'mmm', name: 'middle', desc: '中间' },
    ]

    for (const s of skills) {
      const dir = join(SKILLS_DIR, s.dir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---
name: ${s.name}
description: ${s.desc}
---
`)
    }

    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('alpha')
    expect(result[1].name).toBe('middle')
    expect(result[2].name).toBe('zebra')
  })

  it('SKILL.md 缺少 name 时用目录名作为 fallback', () => {
    const dir = join(SKILLS_DIR, 'my-tool')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---
description: 没有 name 字段
---
`)

    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('my-tool')
    expect(result[0].description).toBe('没有 name 字段')
  })

  it('SKILL.md 为空文件时用目录名兜底', () => {
    const dir = join(SKILLS_DIR, 'empty-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '')

    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('empty-skill')
    expect(result[0].description).toBe('')
  })

  it('不递归扫描嵌套子目录', () => {
    // parent 目录下有 child 子目录，child 里有 SKILL.md
    const nested = join(SKILLS_DIR, 'parent', 'child')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'SKILL.md'), `---
name: nested
description: 嵌套的 skill
---
`)

    // parent 目录没有 SKILL.md，不应该被扫到
    // child 在第二层，也不应该被扫到
    const result = listSkills(SKILLS_DIR)
    expect(result).toHaveLength(0)
  })
})

describe('分页逻辑', () => {
  // 模拟 HTTP handler 的分页返回格式
  function paginate(items: SkillItem[], page: number, pageSize: number) {
    const total = items.length
    const start = (page - 1) * pageSize
    const end = start + pageSize
    const data = items.slice(start, end)
    const hasMore = end < total
    return { data, total, page, pageSize, hasMore }
  }

  it('page=1, pageSize=2 返回前 2 个', () => {
    const items: SkillItem[] = Array.from({ length: 5 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }))

    const result = paginate(items, 1, 2)
    expect(result.data).toHaveLength(2)
    expect(result.data[0].name).toBe('skill-0')
    expect(result.data[1].name).toBe('skill-1')
    expect(result.total).toBe(5)
    expect(result.hasMore).toBe(true)
  })

  it('page=2 返回后续数据', () => {
    const items: SkillItem[] = Array.from({ length: 5 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }))

    const result = paginate(items, 2, 2)
    expect(result.data).toHaveLength(2)
    expect(result.data[0].name).toBe('skill-2')
    expect(result.data[1].name).toBe('skill-3')
    expect(result.hasMore).toBe(true)
  })

  it('最后一页 hasMore 为 false', () => {
    const items: SkillItem[] = Array.from({ length: 5 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }))

    const result = paginate(items, 3, 2)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].name).toBe('skill-4')
    expect(result.hasMore).toBe(false)
  })

  it('total 始终返回完整列表长度', () => {
    const items: SkillItem[] = Array.from({ length: 7 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }))

    const page1 = paginate(items, 1, 3)
    const page2 = paginate(items, 2, 3)
    const page3 = paginate(items, 3, 3)

    expect(page1.total).toBe(7)
    expect(page2.total).toBe(7)
    expect(page3.total).toBe(7)

    expect(page1.data).toHaveLength(3)
    expect(page2.data).toHaveLength(3)
    expect(page3.data).toHaveLength(1)
  })

  it('页码超出范围返回空数组，hasMore 为 false', () => {
    const items: SkillItem[] = [
      { name: 'only', description: '唯一' },
    ]

    const result = paginate(items, 2, 3)
    expect(result.data).toHaveLength(0)
    expect(result.hasMore).toBe(false)
    expect(result.total).toBe(1)
  })

  it('空列表 total 为 0，hasMore 为 false', () => {
    const result = paginate([], 1, 3)
    expect(result.data).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('大 pageSize 一次返回所有数据', () => {
    const items: SkillItem[] = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }))

    const result = paginate(items, 1, 100)
    expect(result.data).toHaveLength(40)
    expect(result.hasMore).toBe(false)
    expect(result.total).toBe(40)
  })

  it('恰好整除时最后一页 hasMore 为 false', () => {
    const items: SkillItem[] = Array.from({ length: 6 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }))

    const result = paginate(items, 2, 3)
    expect(result.data).toHaveLength(3)
    expect(result.hasMore).toBe(false)
  })
})
