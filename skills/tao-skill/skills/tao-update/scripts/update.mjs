#!/usr/bin/env node
/**
 * tao skill 自动更新脚本
 *
 * 从 GitHub 开源仓库 xiaomo-agi/xiaomo-skills 拉取最新版 tao 系列 skill，
 * 对比本地版本号，自动更新有变化的 skill，新增本地没有的 skill。
 *
 * 用法：
 *   node update.mjs              # 检查并更新（交互式确认）
 *   node update.mjs --check      # 只检查，不写入（dry-run）
 *   node update.mjs --yes        # 检查并直接更新，不确认
 *   node update.mjs --target <dir>   # 指定 skill 安装目录（默认自动探测）
 *
 * 无第三方依赖，依赖 Node 18+ 内置 fetch。
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = 'xiaomo-agi/xiaomo-skills';
const BRANCH = 'main';
const REMOTE_TAO_DIR = 'skills/tao-skill/skills'; // 仓库内 tao 系列所在路径
const API_BASE = `https://api.github.com/repos/${REPO}/contents`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 参数解析 ──
const args = process.argv.slice(2);
const flagCheck = args.includes('--check');
const flagYes = args.includes('--yes');
const targetIdx = args.indexOf('--target');
const targetOverride = targetIdx !== -1 ? args[targetIdx + 1] : null;

// ── 探测本地 skill 安装目录 ──
// 脚本位于 <skills>/tao-update/scripts/update.mjs，所以 skills 根目录是上两级
function detectSkillsRoot() {
  if (targetOverride) return path.resolve(targetOverride);
  return path.resolve(__dirname, '..', '..'); // .../skills/
}

// ── 从 frontmatter 提取 version ──
function parseVersion(content) {
  const m = content.match(/^version:\s*["']?([\d.]+)["']?/m);
  return m ? m[1] : null;
}

// ── 比较语义版本号 a > b ? ──
function versionGreater(a, b) {
  if (!a) return false;
  if (!b) return true;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tao-update-script', 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tao-update-script' } });
  if (!res.ok) throw new Error(`fetch ${res.status}: ${url}`);
  return res.text();
}

async function main() {
  const skillsRoot = detectSkillsRoot();
  console.log(`📂 本地 skill 目录：${skillsRoot}`);
  console.log(`🌐 远程仓库：${REPO}@${BRANCH}/${REMOTE_TAO_DIR}\n`);

  // 1. 列出远程 tao 系列 skill
  let remoteDirs;
  try {
    const listing = await fetchJson(`${API_BASE}/${REMOTE_TAO_DIR}?ref=${BRANCH}`);
    remoteDirs = listing.filter(item => item.type === 'dir').map(item => item.name);
  } catch (e) {
    console.error(`❌ 无法读取远程 skill 列表：${e.message}`);
    console.error(`   检查网络，或确认仓库 ${REPO} 的 ${REMOTE_TAO_DIR} 路径存在。`);
    process.exit(1);
  }

  if (remoteDirs.length === 0) {
    console.error('❌ 远程没有找到任何 tao skill。');
    process.exit(1);
  }
  console.log(`远程发现 ${remoteDirs.length} 个 tao skill：${remoteDirs.join(', ')}\n`);

  // 2. 逐个对比版本
  const plan = []; // { name, action: 'new'|'update'|'skip', localVer, remoteVer, content }
  for (const name of remoteDirs) {
    const remoteUrl = `${RAW_BASE}/${REMOTE_TAO_DIR}/${name}/SKILL.md`;
    let remoteContent;
    try {
      remoteContent = await fetchText(remoteUrl);
    } catch (e) {
      console.log(`⚠️  ${name}：拉取远程失败，跳过（${e.message}）`);
      continue;
    }
    const remoteVer = parseVersion(remoteContent);
    const localPath = path.join(skillsRoot, name, 'SKILL.md');

    if (!existsSync(localPath)) {
      plan.push({ name, action: 'new', localVer: null, remoteVer, content: remoteContent, localPath });
      continue;
    }
    const localContent = await readFile(localPath, 'utf8');
    const localVer = parseVersion(localContent);

    // 只按版本号判断：远程版本号更高才更新。
    // 这样在开发机（本地领先远程）上不会误把新内容覆盖成旧内容。
    // 因此内容更新必须提升 frontmatter 的 version，否则用户拉不到。
    if (versionGreater(remoteVer, localVer)) {
      plan.push({ name, action: 'update', localVer, remoteVer, content: remoteContent, localPath });
    } else {
      plan.push({ name, action: 'skip', localVer, remoteVer, content: null, localPath });
    }
  }

  // 3. 汇报计划
  const toNew = plan.filter(p => p.action === 'new');
  const toUpdate = plan.filter(p => p.action === 'update');
  const toSkip = plan.filter(p => p.action === 'skip');

  console.log('=== 更新计划 ===');
  for (const p of toNew) console.log(`  🆕 新增 ${p.name}（远程 v${p.remoteVer}）`);
  for (const p of toUpdate) console.log(`  ⬆️  更新 ${p.name}（本地 v${p.localVer || '无'} → 远程 v${p.remoteVer}）`);
  for (const p of toSkip) console.log(`  ✓  最新 ${p.name}（v${p.localVer}）`);
  console.log('');

  if (toNew.length === 0 && toUpdate.length === 0) {
    console.log('🎉 所有 tao skill 都是最新版，无需更新。');
    return;
  }

  if (flagCheck) {
    console.log(`📋 dry-run 模式：发现 ${toNew.length} 个新增 + ${toUpdate.length} 个更新，未写入。`);
    console.log('   去掉 --check 或加 --yes 执行实际更新。');
    return;
  }

  if (!flagYes) {
    console.log(`⚠️  即将写入 ${toNew.length + toUpdate.length} 个文件。`);
    console.log('   这是非交互脚本，请用 --yes 确认执行，或 --check 仅预览。');
    return;
  }

  // 4. 执行写入
  let done = 0;
  for (const p of [...toNew, ...toUpdate]) {
    await mkdir(path.dirname(p.localPath), { recursive: true });
    await writeFile(p.localPath, p.content, 'utf8');
    console.log(`  ✅ 已写入 ${p.name}/SKILL.md`);
    done++;
  }
  console.log(`\n🎉 完成：${toNew.length} 个新增 + ${toUpdate.length} 个更新，共 ${done} 个文件。`);
  console.log('   提示：如果你在 .claude/skills 和 .agents/skills 双目录使用，记得同步另一个目录。');
}

main().catch(e => {
  console.error(`❌ 更新失败：${e.message}`);
  process.exit(1);
});
