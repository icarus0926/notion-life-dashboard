/**
 * 人生规划 · Notion 双向联动后端
 * - GET  /api/data       读取 5 个数据库,聚合成前端用的 JSON(含每行 Notion page id)
 * - POST /api/update     把网页上的改动写回 Notion(勾选/进度/状态)
 * - 静态托管 public/ 下的仪表盘
 *
 * 密钥全部走环境变量,绝不写进代码。见同目录 .env.example
 * 需 Node 18+(内置全局 fetch)
 */
try { require('dotenv').config(); } catch (e) { /* 未装 dotenv 时忽略,改用系统环境变量 */ }
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const TOKEN = process.env.NOTION_TOKEN;              // Notion internal integration token
const KEY   = process.env.DASH_PASSWORD || '';       // 访问网页的口令(强烈建议设置)
const PORT  = process.env.PORT || 8787;
const NV    = '2022-06-28';

// 数据库 ID 全部走环境变量(见 .env.example;各库 schema 见 docs/notion-schema.json)
const DBS = {
  goals:      process.env.DB_GOALS,        // 年度目标
  growthPool: process.env.DB_GROWTH_POOL,  // 个人成长任务池
  workPool:   process.env.DB_WORK_POOL,    // 主业任务池
  monthly:    process.env.DB_MONTHLY,      // 月度计划
  weekly:     process.env.DB_WEEKLY,       // 周计划
  daily:      process.env.DB_DAILY,        // 每日执行
};
{
  const required = { NOTION_TOKEN: TOKEN, DB_GOALS: DBS.goals, DB_GROWTH_POOL: DBS.growthPool,
    DB_WORK_POOL: DBS.workPool, DB_MONTHLY: DBS.monthly, DB_WEEKLY: DBS.weekly, DB_DAILY: DBS.daily };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('缺少环境变量: ' + missing.join(', ') + '\n请复制 .env.example 为 .env 并填写(数据库 schema 见 docs/notion-schema.json 与 README)');
    process.exit(1);
  }
}

const nheaders = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'Notion-Version': NV,
  'Content-Type': 'application/json',
});

// ISO 周标签,如 '2026-06-29' -> '26W27'(UTC 计算,周一为周首)
function isoWeekLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;            // 周一=0
  d.setUTCDate(d.getUTCDate() - day + 3);          // 移到本周四
  const isoYear = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 24 * 3600 * 1000));
  return String(isoYear).slice(2) + 'W' + String(week).padStart(2, '0');
}

// 查询单个数据库(自动翻页)
async function queryDB(id) {
  let results = [], cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const r = await fetch(`https://api.notion.com/v1/databases/${id}/query`,
      { method: 'POST', headers: nheaders(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`query ${id} -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results;
}

// 属性取值助手
const V = {
  title:  p => (p?.title || []).map(t => t.plain_text).join(''),
  text:   p => (p?.rich_text || []).map(t => t.plain_text).join(''),
  select: p => p?.select?.name || '',
  status: p => p?.status?.name || '',
  number: p => (p?.number ?? 0),
  check:  p => !!p?.checkbox,
  date:   p => p?.date?.start || '',
  relation: p => (p?.relation || []).map(r => r.id),
};

// 访问口令中间件(保护 /api)
app.use('/api', (req, res, next) => {
  if (KEY && req.get('x-dash-key') !== KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// 读取聚合数据
app.get('/api/data', async (req, res) => {
  try {
    const [g, gp, wp, mo, wk, dl] = await Promise.all(
      [DBS.goals, DBS.growthPool, DBS.workPool, DBS.monthly, DBS.weekly, DBS.daily].map(queryDB)
    );
    const P = x => x.properties;
    res.json({
      goals: g.map(x => ({ id: x.id, n: V.title(P(x)['目标']), d: V.select(P(x)['领域']),
        c: V.text(P(x)['成功标准']), p: V.number(P(x)['当前进度']), s: V.status(P(x)['状态']) })),
      growthPool: gp.map(x => ({ id: x.id, t: V.title(P(x)['任务']),
        pr: V.select(P(x)['优先级']), st: V.select(P(x)['状态']) })),
      workPool: wp.map(x => ({ id: x.id, t: V.title(P(x)['任务']),
        pr: V.select(P(x)['优先级']), st: V.select(P(x)['状态']) })),
      monthly: mo.map(x => {
        const relG = V.relation(P(x)['关联任务池']), relW = V.relation(P(x)['关联主业任务池']);
        return { id: x.id, n: V.title(P(x)['事项']), type: V.select(P(x)['类型']),
          pr: V.select(P(x)['优先级']), p: V.number(P(x)['完成度']), mon: V.select(P(x)['月份']),
          poolId: relG[0] || relW[0] || null, poolKind: relG[0] ? 'growth' : (relW[0] ? 'work' : null) };
      }),
      weekly: wk.map(x => ({ id: x.id, t: V.title(P(x)['任务']), w: V.text(P(x)['周次']),
        ord: P(x)['排序']?.number ?? null,
        type: V.select(P(x)['类型']), pr: V.select(P(x)['优先级']), done: V.check(P(x)['完成情况']),
        s: V.date(P(x)['开始日期']), e: V.date(P(x)['结束日期']),
        monthlyId: V.relation(P(x)['关联月度事项'])[0] || null })),
      daily: dl.map(x => {
        const [mId, bId] = (V.text(P(x)['关联步骤']) || '').split('|');
        return { id: x.id, t: V.title(P(x)['待办']), date: V.date(P(x)['日期']), done: V.check(P(x)['完成']),
          stepRef: (mId && bId) ? { monthlyId: mId, blockId: bId } : null };
      }),
      snapshot: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 写回单个属性
app.post('/api/update', async (req, res) => {
  try {
    const { pageId, property, propType, value } = req.body || {};
    if (!pageId || !property) return res.status(400).json({ error: 'missing pageId/property' });
    let pv;
    if (propType === 'checkbox')    pv = { checkbox: !!value };
    else if (propType === 'number') pv = { number: Number(value) };
    else if (propType === 'select') pv = { select: { name: value } };
    else if (propType === 'status') pv = { status: { name: value } };
    else if (propType === 'text')   pv = { rich_text: value ? [{ text: { content: String(value) } }] : [] };
    else if (propType === 'title')  pv = { title: [{ text: { content: String(value) } }] };
    else if (propType === 'date')   pv = { date: value ? { start: String(value) } : null };
    else return res.status(400).json({ error: 'bad propType' });
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`,
      { method: 'PATCH', headers: nheaders(), body: JSON.stringify({ properties: { [property]: pv } }) });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 拖动分配:把任务池条目分配到某月 —— 更新池状态 + 在月度计划新建一条并建立关联
app.post('/api/assign', async (req, res) => {
  try {
    const { poolPageId, poolType, title, priority, month } = req.body || {};
    if (!poolPageId || !poolType || !month) return res.status(400).json({ error: 'missing poolPageId/poolType/month' });

    // 1) 更新任务池条目:状态=已分配,分配月份=month
    const r1 = await fetch(`https://api.notion.com/v1/pages/${poolPageId}`, {
      method: 'PATCH', headers: nheaders(),
      body: JSON.stringify({ properties: {
        '状态': { select: { name: '已分配' } },
        '分配月份': { rich_text: [{ text: { content: month } }] },
      } }),
    });
    if (!r1.ok) return res.status(500).json({ error: '更新任务池失败: ' + await r1.text() });

    // 2) 在月度计划新建一条,并关联回任务池
    const typeName = poolType === 'work' ? '工作' : '个人成长';
    const relProp = poolType === 'work' ? '关联主业任务池' : '关联任务池';
    const props = {
      '事项': { title: [{ text: { content: title || '(未命名)' } }] },
      '月份': { select: { name: month } },
      '类型': { select: { name: typeName } },
      '完成度': { number: 0 },
      [relProp]: { relation: [{ id: poolPageId }] },
    };
    if (priority) props['优先级'] = { select: { name: priority } };

    const r2 = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: nheaders(),
      body: JSON.stringify({ parent: { database_id: DBS.monthly }, properties: props }),
    });
    if (!r2.ok) return res.status(500).json({ error: '创建月度条目失败: ' + await r2.text() });
    const created = await r2.json();
    res.json({ ok: true, monthlyId: created.id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 新增条目(年度目标 / 任务池 / 每日待办)
app.post('/api/create', async (req, res) => {
  try {
    const { target, title, domain, criteria, priority, date } = req.body || {};
    if (!target || !title || !title.trim()) return res.status(400).json({ error: 'missing target/title' });
    const t = title.trim();
    let dbId, props, shape;
    if (target === 'goal') {
      dbId = DBS.goals;
      props = { '目标': { title: [{ text: { content: t } }] }, '年份': { select: { name: '2026' } },
        '当前进度': { number: 0 }, '状态': { status: { name: '未开始' } } };
      if (domain) props['领域'] = { select: { name: domain } };
      if (criteria) props['成功标准'] = { rich_text: [{ text: { content: criteria } }] };
    } else if (target === 'growth' || target === 'work') {
      dbId = target === 'work' ? DBS.workPool : DBS.growthPool;
      props = { '任务': { title: [{ text: { content: t } }] }, '状态': { select: { name: '待分配' } } };
      if (priority) props['优先级'] = { select: { name: priority } };
    } else if (target === 'daily') {
      dbId = DBS.daily;
      props = { '待办': { title: [{ text: { content: t } }] }, '完成': { checkbox: false } };
      if (date) props['日期'] = { date: { start: date } };
      const sr = (req.body || {}).stepRef;
      if (sr && sr.monthlyId && sr.blockId)
        props['关联步骤'] = { rich_text: [{ text: { content: sr.monthlyId + '|' + sr.blockId } }] };
    } else if (target === 'weekly') {
      dbId = DBS.weekly;
      const { type, monthlyId, start, end } = req.body || {};
      props = { '任务': { title: [{ text: { content: t } }] }, '完成情况': { checkbox: false } };
      if (type) props['类型'] = { select: { name: type } };
      if (priority) props['优先级'] = { select: { name: priority } };
      if (start) props['开始日期'] = { date: { start } };
      if (end) props['结束日期'] = { date: { start: end } };
      if (start) props['周次'] = { rich_text: [{ text: { content: isoWeekLabel(start) } }] };
      if (monthlyId) props['关联月度事项'] = { relation: [{ id: monthlyId }] };
    } else return res.status(400).json({ error: 'bad target' });

    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: nheaders(),
      body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const c = await r.json();
    if (target === 'goal') shape = { id: c.id, n: t, d: domain || '', c: criteria || '', p: 0, s: '未开始' };
    else if (target === 'daily') { const sr = (req.body || {}).stepRef;
      shape = { id: c.id, t, date: date || '', done: false,
        stepRef: (sr && sr.monthlyId && sr.blockId) ? { monthlyId: sr.monthlyId, blockId: sr.blockId } : null }; }
    else if (target === 'weekly') { const { type, monthlyId, start, end } = req.body || {};
      shape = { id: c.id, t, w: start ? isoWeekLabel(start) : '', type: type || '', pr: priority || '',
        done: false, s: start || '', e: end || '', monthlyId: monthlyId || null }; }
    else shape = { id: c.id, t, pr: priority || '', st: '待分配' };
    res.json({ ok: true, item: shape });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 删除条目(归档到 Notion 回收站,可恢复)
app.post('/api/delete', async (req, res) => {
  try {
    const { pageId } = req.body || {};
    if (!pageId) return res.status(400).json({ error: 'missing pageId' });
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`,
      { method: 'PATCH', headers: nheaders(), body: JSON.stringify({ archived: true }) });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 取消分配:先把关联任务池条目改回待分配,再归档月度条目
// (顺序很重要:先改池再删月度,中途失败也只留安全可重试的状态,不会出现"月度已删+池卡在已分配")
app.post('/api/unassign', async (req, res) => {
  try {
    const { monthlyId, poolId } = req.body || {};
    if (!monthlyId) return res.status(400).json({ error: 'missing monthlyId' });
    // 1) 先还原任务池条目
    if (poolId) {
      const r1 = await fetch(`https://api.notion.com/v1/pages/${poolId}`, {
        method: 'PATCH', headers: nheaders(),
        body: JSON.stringify({ properties: { '状态': { select: { name: '待分配' } }, '分配月份': { rich_text: [] } } }),
      });
      if (!r1.ok) return res.status(500).json({ error: '还原任务池失败: ' + await r1.text() });
    }
    // 2) 再归档月度条目
    const r2 = await fetch(`https://api.notion.com/v1/pages/${monthlyId}`,
      { method: 'PATCH', headers: nheaders(), body: JSON.stringify({ archived: true }) });
    if (!r2.ok) return res.status(500).json({ error: '归档月度条目失败(任务池已还原,可重试): ' + await r2.text() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 完成本月计划条目:归档该月度条目 + 把关联任务池条目置为「已完成」
app.post('/api/complete-monthly', async (req, res) => {
  try {
    const { monthlyId, poolId } = req.body || {};
    if (!monthlyId) return res.status(400).json({ error: 'missing monthlyId' });
    const r1 = await fetch(`https://api.notion.com/v1/pages/${monthlyId}`,
      { method: 'PATCH', headers: nheaders(), body: JSON.stringify({ archived: true }) });
    if (!r1.ok) return res.status(500).json({ error: '归档月度条目失败: ' + await r1.text() });
    if (poolId) {
      const r2 = await fetch(`https://api.notion.com/v1/pages/${poolId}`, {
        method: 'PATCH', headers: nheaders(),
        body: JSON.stringify({ properties: { '状态': { select: { name: '已完成' } } } }),
      });
      if (!r2.ok) return res.status(500).json({ error: '标记任务池已完成失败: ' + await r2.text() });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 调整周任务时间(甘特图拖动):写开始/结束日期 + 重算周次
app.post('/api/set-weekly-schedule', async (req, res) => {
  try {
    const { pageId, start, end } = req.body || {};
    if (!pageId || !start || !end) return res.status(400).json({ error: 'missing pageId/start/end' });
    const week = isoWeekLabel(start);
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers: nheaders(),
      body: JSON.stringify({ properties: {
        '开始日期': { date: { start } },
        '结束日期': { date: { start: end } },
        '周次': { rich_text: [{ text: { content: week } }] },
      } }),
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    res.json({ ok: true, week, start, end });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ===== 月度任务步骤(Notion 页内 to-do 待办块)+ 完成度自动计算 =====
// 步骤排期标记:待办文字尾部的 " 📅YYYY-MM-DD→YYYY-MM-DD"。解析宽松(容变体选择符/->/单日期),写入严格
const STEP_MARK_RE = /\s*📅️?\s*(\d{4}-\d{2}-\d{2})(?:\s*(?:→|->)\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
function parseStepMark(plain) {
  const m = (plain || '').match(STEP_MARK_RE);
  if (!m) return { text: plain, s: null, e: null };
  return { text: plain.slice(0, m.index), s: m[1], e: m[2] || m[1] };
}
// 列出某页下的 to_do 子块
async function listTodos(pageId) {
  let results = [], cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : '');
    const r = await fetch(url, { headers: nheaders() });
    if (!r.ok) throw new Error(`list children ${pageId} -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results.filter(b => b.type === 'to_do').map(b => {
    const p = parseStepMark((b.to_do.rich_text || []).map(t => t.plain_text).join(''));
    return { id: b.id, text: p.text.trim() || '(未命名)', checked: !!b.to_do.checked, s: p.s, e: p.e };
  });
}
// 重算完成度并写回 完成度(number);total===0 时不改(交回手动)
async function recalc(pageId) {
  const steps = await listTodos(pageId);
  const total = steps.length, done = steps.filter(s => s.checked).length;
  const percent = total ? Math.round(done / total * 100) : 0;
  if (total > 0) {
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers: nheaders(),
      body: JSON.stringify({ properties: { '完成度': { number: percent } } }),
    });
  }
  return { steps, total, done, percent };
}

// 读取某任务的步骤清单
app.get('/api/steps', async (req, res) => {
  try {
    const pageId = req.query.pageId;
    if (!pageId) return res.status(400).json({ error: 'missing pageId' });
    const steps = await listTodos(pageId);
    const total = steps.length, done = steps.filter(s => s.checked).length;
    res.json({ steps, total, done, percent: total ? Math.round(done / total * 100) : 0 });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 添加步骤
app.post('/api/step-add', async (req, res) => {
  try {
    const { pageId, text } = req.body || {};
    if (!pageId || !text || !text.trim()) return res.status(400).json({ error: 'missing pageId/text' });
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH', headers: nheaders(),
      body: JSON.stringify({ children: [{ object: 'block', type: 'to_do',
        to_do: { rich_text: [{ type: 'text', text: { content: text.trim() } }], checked: false } }] }),
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const j = await r.json();
    const newBlock = (j.results || [])[0];
    const rc = await recalc(pageId);
    res.json({ step: { id: newBlock.id, text: text.trim(), checked: false }, total: rc.total, done: rc.done, percent: rc.percent });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 勾选/取消步骤
app.post('/api/step-toggle', async (req, res) => {
  try {
    const { pageId, blockId, checked } = req.body || {};
    if (!pageId || !blockId) return res.status(400).json({ error: 'missing pageId/blockId' });
    const r = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH', headers: nheaders(), body: JSON.stringify({ to_do: { checked: !!checked } }) });
    if (!r.ok) {
      const txt = await r.text();
      // 块已删 / 所在页已归档:告知前端"步骤已失效",不按服务器错误处理
      if (r.status === 404 || /archived/i.test(txt)) return res.json({ orphan: true });
      return res.status(500).json({ error: txt });
    }
    const rc = await recalc(pageId);
    res.json({ total: rc.total, done: rc.done, percent: rc.percent });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 删除步骤
app.post('/api/step-delete', async (req, res) => {
  try {
    const { pageId, blockId } = req.body || {};
    if (!pageId || !blockId) return res.status(400).json({ error: 'missing pageId/blockId' });
    const r = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, { method: 'DELETE', headers: nheaders() });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const rc = await recalc(pageId);
    res.json({ total: rc.total, done: rc.done, percent: rc.percent });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 任务全景图:批量拉取多个宿主页的步骤(并发≤3,单页失败置空不阻断)
app.post('/api/stepsmap', async (req, res) => {
  try {
    const ids = (req.body || {}).ids || [];
    if (!Array.isArray(ids) || ids.length > 100) return res.status(400).json({ error: 'bad ids' });
    const out = {};
    for (let i = 0; i < ids.length; i += 3) {
      await Promise.all(ids.slice(i, i + 3).map(async id => {
        try { out[id] = await listTodos(id); } catch (e) { out[id] = []; }
      }));
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 步骤改名:替换 to_do 文本,保留尾部 📅 排期标记与勾选状态
app.post('/api/step-rename', async (req, res) => {
  try {
    const { blockId, text } = req.body || {};
    if (!blockId || !text || !text.trim()) return res.status(400).json({ error: 'missing blockId/text' });
    const rGet = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, { headers: nheaders() });
    if (!rGet.ok) return res.status(500).json({ error: await rGet.text() });
    const blk = await rGet.json();
    if (blk.type !== 'to_do' || blk.archived) return res.status(400).json({ error: 'not a to_do block' });
    const plain = (blk.to_do.rich_text || []).map(t => t.plain_text).join('');
    const p = parseStepMark(plain);
    const rich = [{ type: 'text', text: { content: text.trim() } }];
    if (p.s && p.e) rich.push({ type: 'text', text: { content: ` 📅${p.s}→${p.e}` }, annotations: { color: 'gray' } });
    const rP = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH', headers: nheaders(), body: JSON.stringify({ to_do: { rich_text: rich } }) });
    if (!rP.ok) return res.status(500).json({ error: await rP.text() });
    res.json({ ok: true, text: text.trim() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 步骤排期:改写待办文字尾部的 📅 标记(在 rich_text 数组上做手术,保留 Notion 里的格式);start/end 均空 = 取消排期
app.post('/api/step-schedule', async (req, res) => {
  try {
    const { blockId } = req.body || {};
    let { start, end } = req.body || {};
    if (!blockId) return res.status(400).json({ error: 'missing blockId' });
    const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
    if (start || end) {
      if (!isDate(start)) return res.status(400).json({ error: 'bad start' });
      if (!end) end = start;
      if (!isDate(end)) return res.status(400).json({ error: 'bad end' });
      if (start > end) { const t = start; start = end; end = t; }
    } else { start = null; end = null; }

    const rGet = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, { headers: nheaders() });
    if (!rGet.ok) return res.status(500).json({ error: await rGet.text() });
    const blk = await rGet.json();
    if (blk.type !== 'to_do' || blk.archived) return res.status(400).json({ error: 'not a to_do block' });

    let rich = (blk.to_do.rich_text || []).slice();
    const plain = rich.map(t => t.plain_text).join('');
    const m = plain.match(STEP_MARK_RE);
    if (m) {
      const marker = plain.slice(m.index);
      const last = rich[rich.length - 1];
      if (last && last.type === 'text' && last.plain_text.endsWith(marker)) {
        // 标记完整落在最后一个 text 段:只截该段尾部
        const kept = last.plain_text.slice(0, last.plain_text.length - marker.length);
        if (kept) rich[rich.length - 1] = { ...last, plain_text: kept, text: { ...last.text, content: kept } };
        else rich.pop();
      } else {
        // 标记跨段(罕见,如用户在 Notion 里手动编辑过):降级为纯文本重建
        rich = m.index > 0 ? [{ type: 'text', text: { content: plain.slice(0, m.index) } }] : [];
      }
    }
    if (start && end) {
      rich.push({ type: 'text', text: { content: ` 📅${start}→${end}` }, annotations: { color: 'gray' } });
    }
    const rPatch = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH', headers: nheaders(), body: JSON.stringify({ to_do: { rich_text: rich } }),
    });
    if (!rPatch.ok) return res.status(500).json({ error: await rPatch.text() });
    res.json({ ok: true, start, end });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// HTML 不做缓存,浏览器每次都取最新(避免改版后看到旧页面)
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`人生规划仪表盘运行于 :${PORT}`));
