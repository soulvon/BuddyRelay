#!/usr/bin/env node
/**
 * G11: 扩展图标门控
 * 1) package.json 根级 icon 字段必须存在（扩展列表/详情页图标的唯一来源）
 * 2) 指向的文件必须存在
 * 3) relay.svg 必须与 Kite icon.svg 哈希一致（防图标资产被悄悄替换/丢失）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KITE_ICON = 'E:\\project\\Kite\\resources\\icon.svg';

let failed = 0;
function gate(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (detail || '')}`);
  if (!ok) failed++;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 1. 根级 icon 字段存在
gate('G11a 根级 icon 字段存在', typeof pkg.icon === 'string' && pkg.icon.length > 0);

// 2. 必须是 PNG（vsce 拒绝 SVG 作为扩展图标，打包会直接失败）
gate('G11b 图标必须为 PNG（vsce 硬性要求）', typeof pkg.icon === 'string' && pkg.icon.endsWith('.png'));

// 3. 指向的文件存在
const iconPath = path.join(ROOT, pkg.icon || '__missing__');
const iconExists = fs.existsSync(iconPath);
gate('G11c 图标文件存在', iconExists, iconPath);

// 4. 内容与 Kite 图标基线一致（PNG 基线哈希）
const KITE_PNG_MD5 = '41e9cd1cf0da471c78836705bc261876';
if (iconExists) {
  const mine = crypto.createHash('md5').update(fs.readFileSync(iconPath)).digest('hex');
  gate('G11d 图标为 Kite 生产资产（哈希一致）', mine === KITE_PNG_MD5, `mine=${mine} expected=${KITE_PNG_MD5}`);
} else {
  gate('G11d 图标为 Kite 生产资产（哈希一致）', false, '文件缺失无法比对');
}

// 5. 活动栏 icon 指向 relay.svg（运行时 mask 用，SVG 合法）
gate(
  'G11e 活动栏图标指向 relay.svg',
  pkg.contributes?.viewsContainers?.activitybar?.[0]?.icon === 'resources/relay.svg'
);

process.exit(failed > 0 ? 1 : 0);
