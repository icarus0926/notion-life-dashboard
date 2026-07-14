// 端到端自测:mock 掉 Notion fetch,起真实服务,验证 401/200/数据解析/写回映射
process.env.NOTION_TOKEN = 'fake';
process.env.DASH_PASSWORD = 'pw123';
process.env.PORT = '8899';
for (const k of ['DB_GOALS','DB_GROWTH_POOL','DB_WORK_POOL','DB_MONTHLY','DB_WEEKLY','DB_DAILY']) process.env[k] = 'fakedb_' + k;

const notionCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  if (typeof url === 'string' && url.includes('api.notion.com')) {
    notionCalls.push({ url, method: opt?.method, body: opt?.body });
    if (url.includes('/query')) {
      return { ok: true, json: async () => ({ has_more: false, results: [{
        id: 'PAGE1', properties: {
          '目标': { title: [{ plain_text: '测试目标' }] },
          '领域': { select: { name: '投资理财' } },
          '成功标准': { rich_text: [{ plain_text: '标准X' }] },
          '当前进度': { number: 42 },
          '状态': { status: { name: '进行中' } },
          '任务': { title: [{ plain_text: '测试任务' }] },
          '优先级': { select: { name: 'P1' } },
          '事项': { title: [{ plain_text: '测试事项' }] },
          '类型': { select: { name: '工作' } },
          '完成度': { number: 30 },
          '周次': { rich_text: [{ plain_text: '26W27' }] },
          '完成情况': { checkbox: true },
          '开始日期': { date: { start: '2026-07-01' } },
          '结束日期': { date: { start: '2026-07-05' } },
        } }] }) };
    }
    if (url.includes('/pages/')) return { ok: true, json: async () => ({}) };
  }
  return { ok: false, status: 404, text: async () => 'nf' };
};

require('./server.js');
const base = 'http://127.0.0.1:8899';

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m));
  await new Promise(r => setTimeout(r, 300));

  // 1. 无口令 -> 401
  let r = await realFetch(base + '/api/data');
  ok(r.status === 401, '无口令访问 /api/data 返回 401');

  // 2. 错口令 -> 401
  r = await realFetch(base + '/api/data', { headers: { 'x-dash-key': 'wrong' } });
  ok(r.status === 401, '错口令返回 401');

  // 3. 正确口令 -> 200 且解析正确
  r = await realFetch(base + '/api/data', { headers: { 'x-dash-key': 'pw123' } });
  ok(r.status === 200, '正确口令返回 200');
  const d = await r.json();
  ok(d.goals[0].n === '测试目标' && d.goals[0].p === 42 && d.goals[0].s === '进行中', '年度目标解析(标题/进度/状态)正确');
  ok(d.weekly[0].done === true && d.weekly[0].w === '26W27' && d.weekly[0].s === '2026-07-01', '周计划解析(勾选/周次/日期)正确');
  ok(d.monthly[0].p === 30 && d.monthly[0].type === '工作', '月度解析(完成度/类型)正确');

  // 4. 写回 checkbox
  notionCalls.length = 0;
  r = await realFetch(base + '/api/update', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dash-key': 'pw123' },
    body: JSON.stringify({ pageId: 'PAGE1', property: '完成情况', propType: 'checkbox', value: true }) });
  const patch = notionCalls.find(c => c.method === 'PATCH');
  ok(r.status === 200, '写回请求返回 200');
  ok(patch && JSON.parse(patch.body).properties['完成情况'].checkbox === true, 'checkbox 写回映射正确');

  // 5. 写回 number
  notionCalls.length = 0;
  await realFetch(base + '/api/update', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dash-key': 'pw123' },
    body: JSON.stringify({ pageId: 'PAGE1', property: '当前进度', propType: 'number', value: 55 }) });
  let pt = notionCalls.find(c => c.method === 'PATCH');
  ok(pt && JSON.parse(pt.body).properties['当前进度'].number === 55, 'number 写回映射正确');

  // 6. 写回 select
  notionCalls.length = 0;
  await realFetch(base + '/api/update', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dash-key': 'pw123' },
    body: JSON.stringify({ pageId: 'PAGE1', property: '状态', propType: 'select', value: '已完成' }) });
  pt = notionCalls.find(c => c.method === 'PATCH');
  ok(pt && JSON.parse(pt.body).properties['状态'].select.name === '已完成', 'select 写回映射正确');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
