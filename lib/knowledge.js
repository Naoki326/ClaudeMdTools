'use strict';
// 知识库领域模块（工单 #5 prefactor）：扫描 / 树 / 标题缓存 / 监听 / 失效的
// 唯一真相。server.js 的 /api/knowledge*、/kb*、/kbfile 路由只做委托——
// 树数据（与标题缓存）只由本模块生产，后续树级缓存 / 目录级剪枝 / view 复用
// 以此为共同地基。
//
// 工单 #6 在此之上加树级缓存：整棵树快照 + single-flight 异步重建 + 失效去抖
// （见下方「树级缓存」一节）。
//
// 工单 #7 缺陷 B：监听剪枝改「路径优先 / 目录级」——ignored 谓词先做纯路径
// 判定（目录名黑名单命中即整棵子树不进监听，chokidar 对目录的 ignored 命中
// 不再递归），文档判断只用路径后缀，stats 仅作「路径无法判定文件/目录」时的
// 兜底；解析后的根目录做父子归并（子根被父根吸收、重复根去重），扫描与监听
// 都只覆盖一次（mergedRootEntries 两条路径共用）。
//
// 工单 #8 消费端收尾：/view 的「同根全部文档路径收集」由树快照提供
// （rootDocPaths，不再每请求全根重扫）；扫描过程统计非排除文件总数，
// 对文档占比极低的根目录打一条告警日志（规模防御，见「低文档密度告警」）。
//
// 接缝：
// - dataDir            数据目录（knowledge.config.json 的家，ADR-0001）
// - baseDir            安装目录（LOCAL_EXCLUDE_DIRS 按绝对路径排除其中的 docs/）
// - resolveRoot        配置 root 字符串 → 绝对路径（~ 展开 + resolve；课程配置
//                      共用同一规则，真源留在 server.js，此处注入）
// - onKnowledgeChange  知识库文档变化回调（server.js 注入 WebSocket 广播，
//                      payload 固定 { type: 'knowledge-change', event }）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const chokidar = require('chokidar');

// /kbfile 静态托管允许的文件类型（HTML 文档及其相对资源）
const KB_STATIC_EXTS = ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf'];

function createKnowledgeService({ dataDir, baseDir, resolveRoot, onKnowledgeChange }) {
  const KNOWLEDGE_CONFIG_FILE = path.join(dataDir, 'knowledge.config.json');

  // 内置默认排除的目录名（小写匹配）
  // 注意：'docs' 不在默认列表中 -- 大多数项目的 docs/ 里有有价值的文档。
  // 如需排除特定目录，通过 knowledge.config.json 的 excludeDirs 配置。
  // lanbook 自身的 docs/ 通过 LOCAL_EXCLUDE_DIRS 按绝对路径排除，避免误伤其他项目。
  const DEFAULT_EXCLUDED = [
    'node_modules', '.git', '.svn', 'bin', 'obj', 'dist', 'build',
    '.next', 'coverage', '__pycache__', '.venv', 'venv', '.idea',
    'target', 'out', 'logs', '.cache', '.vs', 'packages',
    '.vscode', '.claude', '.husky', '.turbo', '.gradle',
    // pi / 其它 agent 工具目录：内含瞬态任务锁文件（.pi/tasks/*.lock），
    // 若不排除，chokidar 会监听它们并在 Windows 上触发 EPERM 崩溃
    '.pi', '.pi-glla', '.zread',
    // 注意：.scratch 不在此列 —— 它是 agent 草稿区，常含需频繁查阅的文档
    // （审查报告、spec 草稿、图表产物），知识库需收录；其中的瞬态文件
    // （.log/.png/.lock 等）由 WATCHER_TRANSIENT_PATTERNS + knowledge
    // watcher 的文档级剪枝（ignored 回调）双重兜底，不会进监听
  ];

  // 瞬态文件/目录名（watcher 专用）：锁文件、临时文件、Office 占用锁等。
  // 这些文件被其它进程占用/删除时，Windows 上访问会 EPERM，必须从监听中排除。
  // 注意：这些不加入 DEFAULT_EXCLUDED，避免影响扫描（扫描只看文档扩展名，天然忽略）。
  const WATCHER_TRANSIENT_PATTERNS = [
    /\.lock$/i,        // 锁文件（pi tasks、git index.lock 等）
    /\.tmp$/i,         // 临时文件
    /~\$.*$/i,         // Office 占用锁（~$xxx.docx）
    /^\.#.*$/i,       // Emacs 自动保存锁
    /\/\.[^\/]+?\.sw[p-x]$/i, // Vim swap
  ];

  // 按绝对路径排除的目录（源码模式下本仓库的 docs/，防止管理文档在知识库视图中重复；
  // 与 1.1 行为保持一致）
  const LOCAL_EXCLUDE_DIRS = [path.join(baseDir, 'docs')];

  // 构建有效排除集合：内置默认 + 给定配置的 excludeDirs + 可选的额外目录。
  // 以显式传入的 config 为准（树缓存重建用的配置必须与缓存键同源，
  // 避免重建中途配置文件被改写导致扫描与键不一致）。
  function excludedSetFrom(config, extraDirs) {
    const fromConfig = (config.excludeDirs || []).map(d => String(d).toLowerCase());
    const fromArg = (extraDirs || []).map(d => String(d).toLowerCase());
    return new Set([...DEFAULT_EXCLUDED, ...fromConfig, ...fromArg]);
  }

  function getExcludedSet(extraDirs) {
    return excludedSetFrom(readConfig(), extraDirs);
  }

  // 判断路径是否应被排除：先查目录名黑名单，再查绝对路径黑名单
  function isExcluded(fullPath, dirName, excludedSet) {
    const excluded = excludedSet || getExcludedSet();
    if (dirName && excluded.has(dirName.toLowerCase())) return true;
    const norm = path.resolve(fullPath);
    return LOCAL_EXCLUDE_DIRS.some(d => norm === d || norm.startsWith(d + path.sep));
  }

  function readConfig() {
    try {
      if (fs.existsSync(KNOWLEDGE_CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(KNOWLEDGE_CONFIG_FILE, 'utf-8'));
      }
    } catch {}
    return { roots: [] };
  }

  function writeConfig(config) {
    fs.writeFileSync(KNOWLEDGE_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }

  // 从 Markdown 内容提取标题（# 标题）
  function titleFromMarkdown(content) {
    const m = content.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : null;
  }

  // 知识库文档扩展名：.md / .html / .htm
  function isKnowledgeDoc(fileName) {
    const n = String(fileName).toLowerCase();
    return n.endsWith('.md') || n.endsWith('.html') || n.endsWith('.htm');
  }

  // 是否为 HTML 文档
  function isHtmlDoc(fileName) {
    const n = String(fileName).toLowerCase();
    return n.endsWith('.html') || n.endsWith('.htm');
  }

  // 从 HTML 提取标题：<title> 优先，其次第一个 <h1>，都无则 null
  function titleFromHtml(content) {
    const t = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) { const s = t[1].replace(/<[^>]+>/g, '').trim(); if (s) return s; }
    const h = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h) { const s = h[1].replace(/<[^>]+>/g, '').trim(); if (s) return s; }
    return null;
  }

  // 从 Markdown 提取目录（标题列表）：只取 ## ~ ######（h1 视为文档标题不入目录）
  // 返回 [{ level, text }]
  // 注意：仅用于读取文档标题信息，实际锚点 id 由渲染页客户端基于 DOM 生成（与 index.html 一致）
  function tocFromMarkdown(content) {
    const toc = [];
    const lines = String(content || '').split(/\r?\n/);
    let inFence = false;
    for (const line of lines) {
      const fence = line.match(/^\s*(```+|~~~+)/);
      if (fence) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
      if (!m) continue;
      const level = m[1].length;
      const text = m[2].replace(/\\([`*_\[\]])/g, '$1').replace(/[*_~`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
      if (!text) continue;
      toc.push({ level, text });
    }
    return toc;
  }

  // 剥离 YAML frontmatter（文件以 --- 开头的元数据块），避免被 marked 误渲染为标题
  // 严格匹配：首行必须是 --- 且存在配对 ---，否则原样返回（不误伤水平线）
  function stripFrontmatter(content) {
    const s = String(content || '');
    const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (!m) return s;
    // frontmatter 内第二行通常是键值对（name:/description:/metadata:），防止把正文首行 --- 误判
    const fmBody = m[0].replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
    if (!fmBody || !/^[A-Za-z_][\w.-]*\s*:/.test(fmBody)) return s;
    return s.slice(m[0].length);
  }

  // 递归扫描目录下所有知识库文档（.md / .html / .htm，排除常见无关目录）。
  // stats（可选）顺带统计遍历到的全部文件数（目录黑名单剪枝后的可见文件），
  // 供预览接口与低文档密度告警计算文档占比（工单 #8）——同步版只服务预览
  // 路由与旧调用方，请求级路径一律走 scanTree（异步）。
  function scanKnowledgeFiles(dir, base, acc, excludedSet, stats) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full, e.name, excludedSet)) continue;
        scanKnowledgeFiles(full, base, acc, excludedSet, stats);
      } else if (e.isFile()) {
        if (stats) stats.totalFiles++;
        if (isKnowledgeDoc(e.name)) {
          acc.push({ abs: full, rel: path.relative(base, full).replace(/\\/g, '/') });
        }
      }
    }
  }

  // 文档标题缓存：abs 路径 → { mtime, title }。树重建时逐文档读全文提取标题
  // 是主要耗时（千级文档）；mtime 未变的文档直接复用上次标题，重建的 IO 从
  // 「读全文」降到「仅 stat」。该语义保留在树重建流程内部（工单 #6）。
  const titleCache = new Map();

  // 递归扫描目录构建树（全异步）：只保留含知识库文档（.md/.html/.htm）的分支
  // （空文件夹自动隐藏）。目录遍历与 stat / 读文件全部走 fs.promises——
  // 事件循环不被阻塞，扫描期间服务保持可响应（工单 #6 异步 IO）。
  // stats（可选）统计遍历到的全部文件数（目录黑名单剪枝后的可见文件），
  // 供低文档密度告警计算文档占比（工单 #8）。
  // 返回 children 数组，每个节点是 { type:'dir', name, children } 或 { type:'file', name, title, kind, mtime }
  async function scanTree(dir, base, excludedSet, stats) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
    // 先排序：目录在前，文件在后；各自按名称排
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    // Promise.all 保持输入顺序，children 有序；null（剪枝/非文档）最后滤除
    const children = await Promise.all(entries.map(async e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full, e.name, excludedSet)) return null;
        const sub = await scanTree(full, base, excludedSet, stats);
        return sub.length > 0 ? { type: 'dir', name: e.name, children: sub } : null;
      }
      if (e.isFile()) {
        if (stats) stats.totalFiles++;
        if (!isKnowledgeDoc(e.name)) return null;
        // 先 stat 拿 mtime：命中缓存（mtime 未变）则跳过全文读取
        let mtime = 0;
        try { mtime = (await fsp.stat(full)).mtimeMs; } catch {}
        const cached = titleCache.get(full);
        let title;
        if (cached && cached.mtime === mtime) {
          title = cached.title;
        } else {
          try {
            const content = await fsp.readFile(full, 'utf-8');
            title = isHtmlDoc(e.name)
              ? (titleFromHtml(content) || e.name.replace(/\.html?$/i, ''))
              : (titleFromMarkdown(content) || e.name.replace(/\.md$/i, ''));
          } catch { title = e.name.replace(/\.(md|html?)$/i, ''); }
          titleCache.set(full, { mtime, title });
        }
        return { type: 'file', name: e.name, title, kind: isHtmlDoc(e.name) ? 'html' : 'md', mtime };
      }
      return null;
    }));
    return children.filter(Boolean);
  }

  // ============================================================
  // 树级缓存（工单 #6）：整棵树快照 + single-flight 异步重建 + 失效去抖
  // ============================================================
  // 缓存键 = 配置身份（roots + excludeDirs 的 JSON）：根目录 / 排除配置变更
  // 改写键 → 下一次发现自动未命中；磁盘侧失效走显式失效（见 watcher）。
  // - 无变更时 /api/knowledge 直接回快照：请求路径零遍历，亚秒返回
  // - 重建：全异步扫描，single-flight——并发请求、去抖触发的后台重建共享
  //   同一次进行中的扫描（N 个客户端同时打开页面只引发一次全量扫描）
  // - 失效来源：
  //   (1) 知识监听器的文档增删改事件 → 「失效 + 重建 + 广播」整体去抖合并：
  //       连续快速编辑只引发一次失效、一次全量扫描、一次广播——客户端收到
  //       广播重拉 /api/knowledge 时与该次扫描 single-flight 合流，不再引发
  //       新扫描。不能逐事件立即失效 + 立即广播：前端收到 knowledge-change
  //       即 loadFileList() 重拉（无客户端去抖），逐事件失效把在飞扫描作废、
  //       重拉又起新扫，真实客户端路径会退化为逐事件全量重扫（重扫风暴）。
  //       代价：变更可见性推迟约一个去抖窗口
  //   (2) 根目录 / 排除配置 POST → refreshTreeCache()（立即失效 + 重建）
  //   (3) 根目录出现/消失 → 命中前按配置根逐个做存在性探测（每根一次 stat，
  //       代价与根数成正比、与树大小无关），与快照记录的存在性状态「不一致」
  //       才失效：消失即失效；缺失期间快照同样记录「缺失」，状态一致直接命中
  //       （否则缺失根让缓存永不收敛、每次请求都重建）；根恢复后状态翻转，
  //       一趟重建把该根带回树中（chokidar 不监视缺失路径，恢复无事件可言）
  const TREE_REBUILD_DEBOUNCE_MS = 500;
  let treeCache = null;        // { key, gen, roots, presence } 最近一次成功扫描的快照
  let rebuildPromise = null;   // 进行中的重建（single-flight 槽位）
  let rebuildDebounceTimer = null;
  // 失效代次：每次失效自增。重建开始时记下代次，落缓存时一并存入——扫描期间
  // 再有失效（又来了文档事件 / 配置变更）则代次已漂移，这趟结果视为过期，
  // 不作为有效快照命中（否则在飞扫描会「吃掉」它启动之后的失效事件）
  let cacheGeneration = 0;

  function configIdentity(config) {
    return JSON.stringify({ roots: config.roots || [], excludeDirs: config.excludeDirs || [] });
  }

  // 嵌套根目录归并（工单 #7 缺陷 B）：解析后的根路径做父子归并——被其它根
  // 严格包含的子根吸收进父根，完全相同的重复根保留首个。扫描与监听两条路径
  // 都以此为准：每份文档只被遍历一次、只被监听一次，/api/knowledge 中恰好
  // 出现一次。返回 [{ index, path }]（index = 在 config.roots 中的原位置，
  // 供 presence 与 /kbfile 的配置索引沿用）。归并与顺序无关：不论父根在配置
  // 中排前排后，子根一律被吸收。
  // Windows 路径大小写不敏感，包含判断按 win32 归一大小写比较；显示用的
  // path 保留原样。
  function mergedRootEntries(config) {
    const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
    const isInsideStrict = (child, ancestor) => {
      if (child === ancestor) return false;
      const c = norm(child);
      const a = norm(ancestor);
      return c.startsWith(a + path.sep);
    };
    const entries = (config.roots || []).map((r, index) => ({ index, path: path.resolve(resolveRoot(r)) }));
    // 重复根去重（首个胜出）：归一化后的完整路径为键
    const byPath = new Map();
    for (const e of entries) {
      const key = norm(e.path);
      if (!byPath.has(key)) byPath.set(key, e);
    }
    const unique = [...byPath.values()];
    // 子根吸收：被任一其它唯一根严格包含者出局
    return unique.filter(e => !unique.some(o => o !== e && isInsideStrict(e.path, o.path)));
  }

  // 根目录存在性探测（失效来源 3）：对每个配置根做一次 stat，返回与
  // config.roots 顺序一一对应的存在性数组。与快照记录的存在性做「状态比较」
  // 而非「有无缺失」——后者在根缺失期间恒真，缓存永不收敛（每次请求都重建），
  // 且根恢复后无失效路径（chokidar 不监视缺失路径），一直回缺根的陈旧快照。
  async function rootsPresence(config) {
    const roots = config.roots || [];
    return Promise.all(roots.map(async r => {
      try { await fsp.stat(resolveRoot(r)); return true; } catch { return false; }
    }));
  }

  // 存在性状态是否变化：快照与当前探测一一对应（key 相同 ⇒ roots 列表相同）
  function presenceChanged(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    return a.some((v, i) => v !== b[i]);
  }

  function countDocs(nodes) {
    let n = 0;
    const stack = [...nodes];
    while (stack.length) {
      const node = stack.pop();
      if (node.type === 'file') n++;
      else stack.push(...node.children);
    }
    return n;
  }

  // ============================================================
  // 低文档密度告警（工单 #8 规模防御）：把 7.8 万文件的原代码树加进来只为了
  // 18 个文档，不再无声发生——首扫对文档占比极低的根目录打一条告警日志。
  // ============================================================
  // 「占比极低」判定：根目录下非排除文件总数达到下限、且文档占比低于阈值。
  // 阈值参考母 spec #1 实测反例（78,028 个文件 / 18 个文档 ≈ 0.023%）：
  // 1% 占比 + 千文件下限，避免小目录误报（3 个文件 1 篇文档不该挨骂）。
  const LOW_DOC_DENSITY_RATIO = 0.01;     // 文档占比 < 1%
  const LOW_DOC_DENSITY_MIN_FILES = 1000; // 且根下非排除文件 ≥ 1000
  function isLowDocDensity(docCount, totalFiles) {
    return totalFiles >= LOW_DOC_DENSITY_MIN_FILES
      && docCount / totalFiles < LOW_DOC_DENSITY_RATIO;
  }

  // 已告警过的根（解析后的绝对路径）：同一根本进程只告警一次——重建随失效
  // 管道反复发生，逐次告警就是日志噪音；根移出配置再加回也不重复提醒
  //（配置动作本身就是用户的第二次知情）。
  const warnedLowDensityRoots = new Set();

  function warnLowDensityRootOnce(rootPath, docCount, totalFiles) {
    if (!isLowDocDensity(docCount, totalFiles) || warnedLowDensityRoots.has(rootPath)) return;
    warnedLowDensityRoots.add(rootPath);
    const pct = totalFiles > 0 ? (docCount / totalFiles * 100).toFixed(3) : '0';
    console.warn(`[knowledge] 文档占比极低: root=${rootPath} docs=${docCount}/files=${totalFiles}（${pct}%）——该根目录几乎不含知识文档，确认是否有意加入（可在配置中移除或用 excludeDirs 摘除无关子树）`);
  }

  // 全量扫描配置的 roots（重活入口，全异步）：先做存在性探测（每配置根一次
  // stat，结果兼作快照的 presence），再对归并后的根（工单 #7：子根被父根
  // 吸收、重复根去重）逐个扫描——每份文档只遍历一次。根目录消失则跳过该根
  // （与旧 existsSync 行为一致）。返回 { roots, presence }——presence 与
  // config.roots 顺序一一对应（含被吸收的子根：子根消失会翻转状态触发重建），
  // 随快照落缓存，供失效来源 (3) 做状态比较。逐根统计非排除文件总数，对文档
  // 占比极低的根打一次告警日志（工单 #8 规模防御）
  async function scanAllRoots(config) {
    const excludedSet = excludedSetFrom(config);
    const roots = [];
    const presence = await rootsPresence(config);
    for (const { path: rootPath, index } of mergedRootEntries(config)) {
      if (!presence[index]) continue;
      const stats = { totalFiles: 0 };
      const children = await scanTree(rootPath, rootPath, excludedSet, stats);
      if (children.length > 0) {
        roots.push({ name: path.basename(rootPath), path: rootPath.replace(/\\/g, '/'), index, children });
      }
      warnLowDensityRootOnce(rootPath, countDocs(children), stats.totalFiles);
    }
    return { roots, presence };
  }

  // 重建入口（single-flight）：已有在飞扫描则共享之；否则以当前配置身份新起
  // 一趟。完成后快照落缓存；失败时快照保持失效，下一次发现重试。
  // 扫描起止各打一行日志：这是「发生了几次全量扫描」的外部可观察缝
  // （single-flight / 去抖测试与现场排查都靠它）。
  function ensureRebuild() {
    if (rebuildPromise) return rebuildPromise;
    const config = readConfig();
    const key = configIdentity(config);
    const gen = cacheGeneration;
    const startedAt = Date.now();
    const scan = (async () => {
      console.log(`[knowledge] 树扫描开始: roots=${(config.roots || []).length}`);
      const { roots, presence } = await scanAllRoots(config);
      treeCache = { key, gen, roots, presence };
      console.log(`[knowledge] 树扫描完成: roots=${roots.length} docs=${countDocs(roots)} ${Date.now() - startedAt}ms`);
    })();
    rebuildPromise = scan.catch(err => {
      console.error('[knowledge] 树扫描失败:', err && err.message ? err.message : err);
      throw err;
    }).finally(() => { rebuildPromise = null; });
    return rebuildPromise;
  }

  // 立即失效 + 后台重建。两个入口共用：配置 POST（(2)）与去抖定时器（(1)）。
  // 失效推进代次：若此刻有在飞扫描（其内容不含本次失效背后的变更），落地时
  // 代次已漂移、结果作废——否则陈旧树会落成「新鲜」快照，变更被在飞扫描吃掉。
  function refreshTreeCache() {
    invalidateTreeSnapshot();
    // 后台触发无等待者：吞掉拒绝防 unhandledRejection（失败已日志，快照未落，
    // 下一次发现自动重试）
    ensureRebuild().catch(() => {});
  }

  // 立即失效（不重建）：丢弃快照并推进失效代次（在飞扫描的结果随之作废），
  // 下一次发现按需重建
  function invalidateTreeSnapshot() {
    treeCache = null;
    cacheGeneration++;
  }

  // 去抖合并的「失效 + 重建 + 广播」（(1)）：事件风暴期间只保留最后一个定时器，
  // 安静 TREE_REBUILD_DEBOUNCE_MS 后一次性失效 + 重建 + 广播——连续快速编辑
  // 合并为一次扫描；客户端收到广播重拉时与该次扫描 single-flight 合流，不再
  // 引发新扫描（防重扫风暴经客户端重拉路径复发，见模块头失效来源 (1)）
  function scheduleTreeRebuild(event) {
    if (rebuildDebounceTimer) clearTimeout(rebuildDebounceTimer);
    rebuildDebounceTimer = setTimeout(() => {
      rebuildDebounceTimer = null;
      refreshTreeCache();
      // 广播时机与 payload 形状保持不变（{ type: 'knowledge-change', event }）；
      // 风暴被合并时 event 取最后一条
      if (onKnowledgeChange) onKnowledgeChange({ type: 'knowledge-change', event });
    }, TREE_REBUILD_DEBOUNCE_MS);
  }

  // 发现知识库内容（树数据唯一生产入口，异步）：以配置的 root 为顶层，下面是
  // 完整目录树。命中快照直接返回；否则 single-flight 重建。扫描期间配置又变
  // （键漂移）时以新键再建一趟；连续漂移超过 3 趟退化为不落缓存的直接扫描
  // （极端高频配置改写下的有界兜底）。
  async function discover() {
    for (let pass = 0; pass < 3; pass++) {
      const config = readConfig();
      const key = configIdentity(config);
      // 先捕获快照引用再 await：探测期间若又发生失效（treeCache 被置空），
      // 返回的是已捕获的一致快照，不会解引用空值
      const cached = treeCache;
      const fresh = cached && cached.key === key && cached.gen === cacheGeneration;
      if (fresh && !presenceChanged(cached.presence, await rootsPresence(config))) {
        return cached.roots;
      }
      await ensureRebuild();
    }
    return (await scanAllRoots(readConfig())).roots;
  }

  // 同根全部文档相对路径（工单 #8）：从 discover() 的树快照展开 file 节点，
  // 替换 /view 原先每请求的全根同步重扫——查看一篇文档不再触发整个根目录的
  // 重扫，重扫只由缓存失效触发。根无文档（或尚未进入快照）时返回空数组，
  // 与旧逻辑在空根下的行为一致。变更可见性走树缓存的失效管道（约一个去抖
  // 窗口的延迟），与 /api/knowledge 同一语义。
  async function rootDocPaths(root) {
    const wanted = resolveRoot(String(root)).replace(/\\/g, '/');
    const entry = (await discover()).find(r => r.path === wanted);
    const rels = [];
    (function walk(nodes, prefix) {
      for (const n of nodes || []) {
        const rel = prefix ? `${prefix}/${n.name}` : n.name;
        if (n.type === 'file') rels.push(rel);
        else if (n.children) walk(n.children, rel);
      }
    })(entry ? entry.children : [], '');
    return rels;
  }

  // 解析知识库文件路径（安全检查：必须在某个 root 内）
  function resolvePath(root, relPath) {
    if (!root || !relPath) return null;
    const rootPath = resolveRoot(String(root));
    const config = readConfig();
    const inRoots = (config.roots || []).some(r => resolveRoot(r) === rootPath);
    if (!inRoots) return null;
    const abs = path.resolve(rootPath, String(relPath));
    if (abs !== rootPath && !abs.startsWith(rootPath + path.sep)) return null;
    if (!isKnowledgeDoc(abs)) return null;
    return abs;
  }

  // —— watcher 统一健壮性 ——
  // 1) ignored 规则：目录名黑名单（与扫描一致）+ 瞬态文件模式（锁/临时/Office）
  //    保证 chokidar 不监听 .pi/tasks/*.lock 这类会产生 EPERM 的路径
  // 2) error 兜底：Windows 上文件被占用/删除时 chokidar 可能 emit error，
  //    不处理会 Unhandled error 直接崩溃——记录日志，不终止服务
  function isWatcherIgnored(p, excludedSet) {
    if (typeof p !== 'string' || !p) return false;
    // 路径段级匹配：检查每一段是否命中目录名黑名单（node_modules/.git/.pi 等）。
    // chokidar 回调收到的是完整路径（如 root/node_modules/x/y.js），
    // 只匹配 basename 会漏掉嵌套目录（原 bug），必须逐段检查。
    const segments = p.split(/[\\/]+/).filter(Boolean);
    for (const seg of segments) {
      const name = seg.toLowerCase();
      if (DEFAULT_EXCLUDED.includes(name)) return true;
      if (excludedSet && excludedSet.has(name)) return true;
    }
    // 瞬态文件模式（锁文件、临时文件、Office 锁）——匹配完整路径
    if (WATCHER_TRANSIENT_PATTERNS.some(re => re.test(p))) return true;
    // 绝对路径黑名单
    const norm = path.resolve(p);
    return LOCAL_EXCLUDE_DIRS.some(d => norm === d || norm.startsWith(d + path.sep));
  }

  function onWatcherError(label, err) {
    // EPERM/ENOENT 等瞬时文件错误：记录并继续，不让单文件问题打死整个服务
    console.error(`[watcher:${label}] 监听错误（已忽略，服务继续运行）:`, err?.code || err?.message || err);
  }

  // 监听知识库根目录变化（server.js 注入 onKnowledgeChange 做广播；配置变更后
  // 由路由调 refreshWatcher 按新 roots 重建监听——失效入口收敛在本模块）
  let knowledgeWatcher = null;
  function refreshWatcher() {
    if (knowledgeWatcher) { try { knowledgeWatcher.close(); } catch {} knowledgeWatcher = null; }
    const config = readConfig();
    if (!config.roots.length) return;
    // 同一份配置快照同时供排除集合与根归并使用（工单 #7：excludeDirs 双路一致、
    // 嵌套根不重复监听）——与扫描侧 excludedSetFrom(config) 同源
    const excluded = excludedSetFrom(config);
    const watchPaths = mergedRootEntries(config).map(e => e.path);
    knowledgeWatcher = chokidar.watch(watchPaths, {
      // 路径优先 / 目录级剪枝（工单 #7）：先做纯路径判定——目录名黑名单
      // （内置默认 + excludeDirs）与瞬态模式只看路径即可命中，目录命中即整棵
      // 子树不进监听（chokidar 对目录的 ignored 命中不再递归），绝不逐文件
      // stat 后再剪。文档判断只用路径后缀，不依赖 stats。stats 仅作路径无法
      // 判定文件/目录时的兜底：能证明是文件的非文档路径不进监听（省
      // awaitWriteFinish 轮询与事件风暴，也避免 poll 独占文件触发 EPERM）；
      // 目录与无法判定者保留——目录里可能藏着文档。
      ignored: (p, stats) => {
        if (isWatcherIgnored(p, excluded)) return true;
        if (isKnowledgeDoc(p)) return false;
        if (!stats) return false;
        return stats.isFile();
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    knowledgeWatcher.on('error', (err) => onWatcherError('knowledge', err));
    knowledgeWatcher.on('all', (event, filePath) => {
      if (!isKnowledgeDoc(filePath)) return;
      // 失效去抖（工单 #6）：「失效 + 重建 + 广播」整体去抖合并（失效来源 (1)）。
      // 不能逐事件立即失效 + 立即广播：前端收到 knowledge-change 即 loadFileList()
      // 重拉 /api/knowledge（public/index.html，无客户端去抖），逐事件失效把
      // 在飞扫描作废、重拉又起新扫——真实客户端路径（N 个客户端 + 连续快速编辑）
      // 会退化为逐事件全量重扫。
      scheduleTreeRebuild(event);
    });
  }

  // 关闭监听（server.js 优雅关闭时调用）：顺带撤销未触发的去抖重建
  function close() {
    if (rebuildDebounceTimer) { clearTimeout(rebuildDebounceTimer); rebuildDebounceTimer = null; }
    if (knowledgeWatcher) { try { knowledgeWatcher.close(); } catch {} knowledgeWatcher = null; }
  }

  return {
    // 配置（knowledge.config.json 读写）
    readConfig, writeConfig,
    // 排除集合（知识库扫描与课程 workspace 发现共用）
    getExcludedSet, isExcluded,
    // 文档元数据提取（view / file 路由与渲染共用）
    isHtmlDoc, titleFromMarkdown, titleFromHtml, tocFromMarkdown, stripFrontmatter,
    // 扫描 / 树 / 路径解析（树数据的唯一生产入口；discover 为异步——命中树级
    // 缓存直接回快照，否则 single-flight 异步重建；rootDocPaths 由树快照提供
    // 同根文档路径清单，/view 不再每请求全根重扫——工单 #8）
    scanKnowledgeFiles, discover, rootDocPaths, resolvePath,
    // 规模防御（工单 #8）：低文档密度判定，预览接口的告警字段与扫描告警共用
    isLowDocDensity,
    // 树级缓存失效（工单 #6）：配置 POST 后调用，立即失效 + 后台重建
    refreshTreeCache,
    // 监听 / 失效（refreshWatcher 按配置重建监听；close 供优雅关闭）
    refreshWatcher, close, isWatcherIgnored, onWatcherError,
  };
}

module.exports = { createKnowledgeService, KB_STATIC_EXTS };
