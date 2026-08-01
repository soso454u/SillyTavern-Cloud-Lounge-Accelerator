import { CLIENT_VERSION } from '../client-core.js';

function row(label, key) {
    const element = document.createElement('div');
    element.className = 'cla-advanced-row';
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('span');
    value.dataset.claAdvanced = key;
    value.textContent = '检测中…';
    element.append(name, value);
    return element;
}

export function createAdvancedPanel() {
    const details = document.createElement('details');
    details.className = 'cla-advanced';
    const summary = document.createElement('summary');
    summary.textContent = '高级信息';
    const body = document.createElement('div');
    body.className = 'cla-advanced-body';
    body.append(
        row('插件版本', 'version'),
        row('页面缓存', 'cache'),
        row('服务端插件', 'server'),
        row('已缓存资源', 'entries'),
        row('聊天优化', 'chat'),
        row('界面操作', 'interaction'),
    );
    details.append(summary, body);

    return {
        element: details,
        update(status = {}) {
            const values = {
                version: CLIENT_VERSION,
                cache: status.cache || '检测中…',
                server: status.server || '检测中…',
                entries: Number.isFinite(status.entries) ? String(status.entries) : '—',
                chat: status.chat || '自动',
                interaction: status.interaction || '自动',
            };
            for (const [key, value] of Object.entries(values)) {
                const target = body.querySelector(`[data-cla-advanced="${key}"]`);
                if (target) target.textContent = value;
            }
        },
    };
}
