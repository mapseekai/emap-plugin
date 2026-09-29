import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './style.css';
interface Profile { id: string; label: string; host: string; port: number; database: string; user: string; tls: string; ca?: string; rememberPassword?: boolean; }
interface Grant { origin: string; connectionId: string; }
interface Snapshot { connections: Profile[]; savedProfiles: Profile[]; pending: { requestId: string; origin: string; expiresAt: number; sessionDurationMs?: number; preferredConnectionId?: string }[]; grants: Grant[]; sessions: (Grant & { expiresAt: number })[]; port: number; }
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => el<HTMLInputElement>(id);
function text(tag: string, content: string, className = ''): HTMLElement {
  const node = document.createElement(tag); node.textContent = content; if (className) node.className = className; return node;
}
function button(label: string, action: () => Promise<unknown>, danger = false): HTMLButtonElement {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (danger) b.className = 'danger';
  b.addEventListener('click', () => void run(action, b)); return b;
}
function message(value?: unknown, kind: 'error' | 'success' = 'error'): void {
  const m = el('message'); m.hidden = !value; m.textContent = value ? String(value) : '';
  m.dataset.kind = kind; m.setAttribute('role', kind === 'success' ? 'status' : 'alert');
}
async function run(action: () => Promise<unknown>, control?: HTMLButtonElement): Promise<void> {
  if (control) control.disabled = true; message();
  try { await action(); previous = ''; await refresh(); }
  catch (error) { message(error); }
  finally { if (control) control.disabled = false; }
}
let previous = ''; let refreshing = false;
const deleting = new Set<string>();
const choices = new Map<string, { connectionId: string; remember: boolean }>();
function edit(profile?: Profile): void {
  el('formSection').hidden = false; el('newConnection').setAttribute('aria-expanded', 'true'); el('formTitle').textContent = profile ? '重新配置连接（原授权会撤销）' : '添加数据库';
  field('profileId').value = profile?.id ?? ''; field('label').value = profile?.label ?? '';
  field('host').value = profile?.host ?? ''; field('port').value = String(profile?.port ?? 5432);
  field('database').value = profile?.database ?? ''; field('user').value = profile?.user ?? '';
  field('password').value = ''; field('tls').value = profile?.tls ?? 'verify'; field('ca').value = profile?.ca ?? '';
  field('rememberPassword').checked = profile?.rememberPassword ?? true;
  el('formSection').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }); field(profile ? 'password' : 'label').focus({ preventScroll: true });
}
async function refresh(): Promise<void> {
  if (refreshing) return; refreshing = true;
  try {
    const s = await invoke<Snapshot>('snapshot');
    el('status').textContent = `运行中 · ${s.sessions.length} 个会话`; el('status').dataset.state = 'ready'; el('status').title = '仅监听本机，网页访问需授权';
    const encoded = JSON.stringify(s); if (encoded === previous) return; previous = encoded;
    const ids = new Set(s.pending.map(p => p.requestId)); for (const id of choices.keys()) if (!ids.has(id)) choices.delete(id);
    el('approvalSection').hidden = s.pending.length === 0; const approvals = el('approvals'); approvals.replaceChildren();
    for (const p of s.pending) {
      const card = text('div', '', 'card'); card.append(text('div', p.origin, 'origin'), text('p', `配对编号 ${p.requestId.slice(-6)} · 授权 ${(p.sessionDurationMs ?? 3600000) / 60000} 分钟`, 'muted'));
      const select = document.createElement('select'); select.setAttribute('aria-label', '授权数据库');
      for (const c of s.connections) { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.label} · ${c.database}`; select.append(o); }
      const choice = choices.get(p.requestId) ?? { connectionId: p.preferredConnectionId ?? s.connections[0]?.id ?? '', remember: false };
      if (!s.connections.some(c => c.id === choice.connectionId)) choice.connectionId = s.connections[0]?.id ?? '';
      choices.set(p.requestId, choice); select.value = choice.connectionId; select.addEventListener('change', () => { choice.connectionId = select.value; });
      const label = text('label', '', 'check'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = choice.remember;
      check.addEventListener('change', () => { choice.remember = check.checked; }); label.append(check, text('span', '记住此站点与数据库的授权关系'));
      const actions = text('div', '', 'actions'); const allow = button('允许查询', () => invoke('approve', { requestId: p.requestId, connectionId: choice.connectionId, remember: choice.remember }));
      allow.className = 'primary'; allow.disabled = !s.connections.length;
      actions.append(allow, button('拒绝', () => invoke('deny', { requestId: p.requestId })));
      card.append(select, label, actions);
      if (!s.connections.length) card.append(text('p', '请先添加数据库，或为已保存连接重新输入密码。', 'muted'));
      approvals.append(card);
    }
    const connections = el('connections'); connections.replaceChildren();
    const merged = new Map(s.savedProfiles.map(p => [p.id, p])); for (const p of s.connections) if (!merged.has(p.id)) merged.set(p.id, p);
    if (!merged.size) connections.append(text('p', '尚未配置数据库。点击“添加连接”开始。', 'muted'));
    for (const p of merged.values()) {
      const available = s.connections.some(c => c.id === p.id); const card = text('div', '', 'card');
      const title = text('div', '', 'connection-row');
      const state = text('span', available ? '就绪' : '待解锁', 'connection-state'); state.dataset.available = String(available);
      state.title = available ? '凭据已加载；使用“测试连接”检查数据库可达性。' : '需重新输入密码或解锁系统凭据存储。';
      title.append(text('div', p.label, 'name'), state);
      card.append(title, text('div', `${p.host}:${p.port} / ${p.database} · ${p.user}`, 'muted connection-meta'));
      if (!available) card.append(text('p', '请重新输入密码，或解锁系统凭据存储。', 'muted'));
      const actions = text('div', '', 'actions'); const test = button('测试连接', async () => {
        const result = await invoke<{ postgisVersion: string }>('test_connection', { connectionId: p.id }); message(`连接成功 · PostGIS ${result.postgisVersion}`, 'success');
      }); test.disabled = !available;
      const remove = button(deleting.has(p.id) ? '再次点击确认删除' : '删除连接', async () => {
        if (!deleting.has(p.id)) { deleting.add(p.id); return; }
        await invoke('delete_connection', { connectionId: p.id }); deleting.delete(p.id);
      }, true);
      actions.append(test, button('重新配置', async () => edit(p)), remove); card.append(actions); connections.append(card);
    }
    const grants = el('grants'); grants.replaceChildren();
    if (!s.grants.length) grants.append(text('p', '没有长期授权。每次连接由你确认。', 'muted'));
    for (const g of s.grants) {
      const card = text('div', '', 'card'); card.append(text('div', g.origin, 'origin'), text('p', merged.get(g.connectionId)?.label ?? g.connectionId, 'muted'),
        button('撤销授权并中止会话', () => invoke('revoke', g as unknown as Record<string, unknown>), true)); grants.append(card);
    }
    const sessions = el('sessions'); sessions.replaceChildren();
    if (!s.sessions.length) sessions.append(text('p', '当前没有网页会话。', 'muted'));
    const grouped = new Map<string, Grant>(); for (const session of s.sessions) grouped.set(JSON.stringify([session.origin, session.connectionId]), session);
    for (const session of grouped.values()) {
      const card = text('div', '', 'card'); card.append(text('div', session.origin, 'origin'), text('p', merged.get(session.connectionId)?.label ?? session.connectionId, 'muted'),
        button('断开并撤销此连接授权', () => invoke('revoke', { origin: session.origin, connectionId: session.connectionId }), true)); sessions.append(card);
    }
  } catch (error) { el('status').textContent = String(error); el('status').dataset.state = 'error'; }
  finally { refreshing = false; }
}
function closeForm(): void {
  field('password').value = ''; el('formSection').hidden = true;
  el('newConnection').setAttribute('aria-expanded', 'false'); el('newConnection').focus();
}
el('newConnection').addEventListener('click', () => edit());
el('cancelForm').addEventListener('click', closeForm);
el('quit').addEventListener('click', () => void invoke('quit'));
el<HTMLFormElement>('connectionForm').addEventListener('submit', event => {
  event.preventDefault(); const submit = el('connectionForm').querySelector<HTMLButtonElement>('button[type=submit]')!;
  const input = { id: field('profileId').value || null, label: field('label').value.trim(), host: field('host').value.trim(), port: Number(field('port').value),
    database: field('database').value, user: field('user').value, password: field('password').value, tls: field('tls').value,
    ca: field('ca').value.trim(), rememberPassword: field('rememberPassword').checked };
  void run(async () => {
    await invoke('save_connection', { input }); input.password = ''; closeForm();
  }, submit).finally(() => { input.password = ''; });
});
void listen<{ event: string }>('connector-event', ({ payload }) => { if (payload.event === 'registration-warning') message('无法注册网页唤起协议。请重新安装连接器，或在本机手动打开。'); void refresh(); });
void refresh(); const poll = setInterval(() => void refresh(), 2000);
window.addEventListener('pagehide', () => { clearInterval(poll); field('password').value = ''; });
