'use strict';
// 数据目录地基（ADR-0001，术语见 CONTEXT.md）：
// 服务全部可变状态（知识库配置 / 课程配置 / 对话元数据）的家，位于 ~/.lanbook/，
// LANBOOK_HOME 环境变量可覆盖（开发 / 测试隔离）。源码模式与安装模式读写同一
// 数据目录，不按运行身份分叉；安装目录只读，服务不向自己代码所在处写任何数据。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR_NAME = '.lanbook';

// 数据目录定位：LANBOOK_HOME（非空时）优先，缺省 ~/.lanbook/
function resolveDataDir() {
  const override = process.env.LANBOOK_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), DATA_DIR_NAME);
}

// 旧位置（安装目录，1.1 布局）→ 数据目录 的迁移清单（CONTEXT.md「迁移」）。
// 迁移是单向、一次性的：拷入数据目录后旧文件原地改名 *.migrated.bak 留底；
// 数据目录已有同名目标文件时跳过该项（幂等保护，不覆盖新数据，旧文件原地不动）。
function migrateLegacyFiles(dataDir, installDir) {
  const items = [
    { label: 'knowledge.config.json', from: path.join(installDir, 'knowledge.config.json'), to: 'knowledge.config.json' },
    { label: 'teach.config.json', from: path.join(installDir, 'teach.config.json'), to: 'teach.config.json' },
    { label: 'docs/.metadata.json', from: path.join(installDir, 'docs', '.metadata.json'), to: path.join('docs', '.metadata.json') },
  ];
  const migrated = [];
  for (const item of items) {
    let fromIsFile = false;
    try { fromIsFile = fs.statSync(item.from).isFile(); } catch {}
    if (!fromIsFile) continue;
    const to = path.join(dataDir, item.to);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(item.from, to);
    fs.renameSync(item.from, item.from + '.migrated.bak');
    migrated.push(item.label);
  }
  return migrated;
}

// 启动初始化：建目录 → 迁移旧位置文件 → 缺省配置落盘。
// 顺序关键：必须先迁移再写默认配置，否则空默认文件会挡住旧配置的迁移。
function initDataDir(dataDir, installDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'docs'), { recursive: true });
  const migrated = migrateLegacyFiles(dataDir, installDir);
  for (const name of ['knowledge.config.json', 'teach.config.json']) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ roots: [] }, null, 2), 'utf-8');
    }
  }
  return { dataDir, migrated };
}

module.exports = { DATA_DIR_NAME, resolveDataDir, initDataDir, migrateLegacyFiles };
