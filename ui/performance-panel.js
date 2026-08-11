const OPTIONS = Object.freeze([
    {
        key: 'keepAlive',
        title: 'HTTP Keep-Alive',
        description: '减少后端 HTTP/HTTPS 重复建连；若出现 ECONNRESET、连接中断等网络异常，请关闭。',
        warning: '开启 HTTP Keep-Alive 可能减少后端请求的重复建连，但部分网络环境可能出现 ECONNRESET 或连接中断。仍要开启吗？',
    },
    {
        key: 'lazyCharacters',
        title: '角色卡懒加载',
        description: '大角色库可明显缩短初始化；部分旧扩展可能不兼容，高级模糊搜索将只按角色名搜索。',
        warning: '开启角色卡懒加载后，部分旧扩展可能不兼容，高级模糊搜索也将只按角色名搜索。仍要开启吗？',
    },
]);

function createOption(option, onChange) {
    const row = document.createElement('label');
    row.className = 'cla-switch cla-performance-switch';
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = option.title;
    const note = document.createElement('small');
    note.textContent = option.description;
    text.append(name, note);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.claPerformance = option.key;
    input.disabled = true;
    input.addEventListener('change', async () => {
        const enabled = input.checked;
        if (enabled && !globalThis.confirm?.(option.warning)) {
            input.checked = false;
            return;
        }
        input.disabled = true;
        try {
            const result = await onChange(option.key, enabled);
            globalThis.toastr?.success?.(
                result.changed
                    ? `config.yaml 已安全保存（备份：${result.backup}），重启 SillyTavern 后生效`
                    : '配置已经是这个状态，无需修改',
                '云酒馆加速器',
            );
        } catch (error) {
            input.checked = !enabled;
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '云酒馆加速器');
        } finally {
            input.disabled = false;
        }
    });
    row.append(text, input);
    return row;
}

export function createPerformancePanel(onChange) {
    const section = document.createElement('section');
    section.className = 'cla-performance';
    const heading = document.createElement('div');
    heading.className = 'cla-performance-heading';
    const title = document.createElement('strong');
    title.textContent = '启动性能优化';
    const state = document.createElement('small');
    state.dataset.claPerformanceState = '';
    state.textContent = '正在读取 config.yaml…';
    heading.append(title, state);
    section.append(heading, ...OPTIONS.map(option => createOption(option, onChange)));

    return {
        element: section,
        update(status = {}) {
            const available = status.available === true;
            const writable = status.writable !== false;
            if (!available) {
                state.textContent = status.error?.includes('config.yaml')
                    ? '服务端无法读取 config.yaml'
                    : '需要安装并连接服务端插件';
            } else if (!writable) {
                state.textContent = 'config.yaml 只读 · 无法修改';
            } else {
                state.textContent = status.restartRequired
                    ? '配置已保存 · 待重启生效'
                    : '修改后需重启 SillyTavern 生效';
            }
            state.dataset.pending = status.restartRequired ? 'true' : 'false';
            for (const option of OPTIONS) {
                const input = section.querySelector(`[data-cla-performance="${option.key}"]`);
                if (!input) continue;
                input.checked = status.settings?.[option.key] === true;
                input.disabled = !available || !writable;
            }
        },
    };
}
