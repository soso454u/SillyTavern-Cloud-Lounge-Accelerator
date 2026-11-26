import { createAdvancedPanel } from './advanced-panel.js';
import { createPerformancePanel } from './performance-panel.js';
import { CHAT_PAGE_SIZE_MAX, CHAT_PAGE_SIZE_MIN, normalizeChatPageSize } from '../client-core.js';

import { WorldInfoPageSize, WORLD_INFO_PAGE_SIZES, WORLD_INFO_DEFAULT_PAGE_SIZE, WORLD_INFO_PAGER_SELECTOR } from '../modules/worldinfo-page-size.js';

const ROOT_ID = 'cloud-lounge-accelerator-settings';

function createSwitch(key, title, description, checked, onChange) {
    const row = document.createElement('label');
    row.className = 'cla-switch';
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = title;
    const note = document.createElement('small');
    note.textContent = description;
    text.append(name, note);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.claSetting = key;
    input.addEventListener('change', async () => {
        input.disabled = true;
        try {
            await onChange(key, input.checked);
        } catch (error) {
            input.checked = !input.checked;
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '云酒馆加速器');
        } finally {
            input.disabled = false;
        }
    });
    row.append(text, input);
    return row;
}

function createButton(label, icon, onClick, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button ${className}`.trim();
    if (icon) {
        const iconNode = document.createElement('i');
        iconNode.className = icon;
        button.append(iconNode);
    }
    button.append(document.createTextNode(label));
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await onClick();
        } catch (error) {
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '云酒馆加速器');
        } finally {
            button.disabled = false;
        }
    });
    return button;
}

function createTabs(pages) {
    const tabs = document.createElement('div');
    tabs.className = 'cla-tabs';
    tabs.setAttribute('role', 'tablist');
    const activate = key => {
        for (const item of pages) {
            const active = item.key === key;
            item.button.classList.toggle('active', active);
            item.button.setAttribute('aria-selected', String(active));
            item.page.hidden = !active;
        }
    };
    for (const item of pages) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button cla-tab';
        button.setAttribute('role', 'tab');
        button.textContent = item.label;
        button.addEventListener('click', () => activate(item.key));
        item.button = button;
        tabs.append(button);
    }
    activate(pages[0].key);
    return tabs;
}

function createPageSizeRow(title, description, control) {
    const row = document.createElement('label');
    row.className = 'cla-number-setting';
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = title;
    const note = document.createElement('small');
    note.textContent = description;
    text.append(name, note);
    control.className = 'text_pole cla-page-size-input';
    row.append(text, control);
    return { row, note };
}

function createWorldInfoPageSizeSetting(controller) {
    const select = document.createElement('select');
    const recommendation = '默认 25 条；大型世界书推荐 10–25 条。';
    const { row, note } = createPageSizeRow('每页渲染世界书条目', recommendation, select);
    select.dataset.claSetting = 'worldInfoPageSize';
    for (const size of WORLD_INFO_PAGE_SIZES) {
        const option = document.createElement('option');
        option.value = String(size);
        option.textContent = String(size);
        select.append(option);
    }
    select.value = String(WORLD_INFO_DEFAULT_PAGE_SIZE);
    select.disabled = true;

    let disposed = false, busy = false, revision = 0;
    const refresh = async () => {
        const request = ++revision;
        try {
            const value = await controller.read();
            if (disposed || busy || revision !== request) return;
            select.value = String(value);
            select.disabled = false;
            note.textContent = recommendation;
        } catch {
            if (disposed || busy || revision !== request) return;
            select.disabled = true;
            note.textContent = '当前酒馆不支持原生世界书分页设置';
        }
    };
    select.addEventListener('change', async () => {
        if (disposed || busy) return;
        busy = true;
        revision++;
        select.disabled = true;
        try {
            const value = Number(select.value);
            await controller.write(value);
            if (!disposed) globalThis.toastr?.success?.(`已改为每页渲染 ${value} 条世界书条目`, '云酒馆加速器');
        } catch (error) {
            if (!disposed) globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '云酒馆加速器');
        } finally {
            busy = false;
            if (!disposed) await refresh();
        }
    });
    // Native page size changes are persisted in its delegated change handler.
    // Capture before that handler (which stops bubbling) and read afterwards.
    const nativeRoot = document.getElementById('world_info_pagination');
    const onNativeChange = event => {
        if (event.target?.matches?.(WORLD_INFO_PAGER_SELECTOR)) queueMicrotask(() => { if (!disposed && !busy) void refresh(); });
    };
    nativeRoot?.addEventListener('change', onNativeChange, true);

    return { element: row, refresh, dispose() {
        disposed = true;
        nativeRoot?.removeEventListener('change', onNativeChange, true);
    } };
}

function createChatDisplayPage(settings, onSettingChange, worldInfoControl) {
    const page = document.createElement('section');
    page.className = 'cla-page cla-chat-display-page';
    page.dataset.claPage = 'chat-display';

    const heading = document.createElement('div');
    heading.className = 'cla-page-heading';
    const title = document.createElement('strong');
    title.textContent = '聊天显示';
    const description = document.createElement('small');
    description.textContent = '单独调整聊天与世界书每页显示的数量';
    heading.append(title, description);

    const input = document.createElement('input');
    input.type = 'number';
    const { row: setting } = createPageSizeRow('每页渲染消息',
        `可选 ${CHAT_PAGE_SIZE_MIN}–${CHAT_PAGE_SIZE_MAX} 条；iPhone / iPad 推荐 3–5 条`, input);
    input.min = String(CHAT_PAGE_SIZE_MIN);
    input.max = String(CHAT_PAGE_SIZE_MAX);
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = String(settings.chatPageSize);
    input.addEventListener('change', async () => {
        const previous = settings.chatPageSize;
        const value = normalizeChatPageSize(input.value, previous);
        input.value = String(value);
        input.disabled = true;
        try {
            await onSettingChange('chatPageSize', value);
            settings.chatPageSize = value;
            globalThis.toastr?.success?.(`已改为每页渲染 ${value} 条消息，下次打开聊天时生效`, '云酒馆加速器');
        } catch (error) {
            input.value = String(previous);
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '云酒馆加速器');
        } finally {
            input.disabled = false;
        }
    });
    const boundary = document.createElement('p');
    boundary.className = 'cla-setting-note';
    boundary.textContent = '仅调整页面显示数量，不影响聊天上下文、世界书条目内容及触发规则。聊天分页在下次打开聊天时生效。';
    page.append(heading, setting, worldInfoControl.element, boundary);
    return page;
}

export class SettingsPanel {
    constructor({ settings, onSettingChange, onPerformanceChange, onRerender, onRepair, onCopyDiagnostics, performanceDiagnostics, getStatus, worldInfoPageSize = new WorldInfoPageSize() }) {
        this.settings = settings;
        this.onSettingChange = onSettingChange;
        this.onPerformanceChange = onPerformanceChange;
        this.onRerender = onRerender;
        this.onRepair = onRepair;
        this.onCopyDiagnostics = onCopyDiagnostics;
        this.performanceDiagnostics = performanceDiagnostics;
        this.getStatus = getStatus;
        this.worldInfoPageSize = worldInfoPageSize;
        this.worldInfoControl = null;
        this.root = null;
        this.advanced = null;
        this.performance = null;
        this.refreshPromise = null;
    }

    mount() {
        if (this.root?.isConnected) return true;
        if (this.root) this.performanceDiagnostics?.stop();
        const host = document.querySelector('#extensions_settings2');
        if (!host) return false;
        document.getElementById(ROOT_ID)?.remove();
        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'extension_container cla-panel';
        const header = document.createElement('div');
        header.className = 'inline-drawer';
        const title = document.createElement('div');
        title.className = 'inline-drawer-toggle inline-drawer-header';
        title.innerHTML = '<b>云酒馆加速器</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>';
        this.drawerIcon = title.querySelector('.inline-drawer-icon');
        // SillyTavern toggles the icon in its delegated document click handler.
        title.addEventListener('click', () => {
            if (this.drawerIcon?.classList.contains('down')) void this.refresh({ opening: true });
        });
        const body = document.createElement('div');
        body.className = 'inline-drawer-content';
        const content = document.createElement('div');
        content.className = 'cla-body';

        const status = document.createElement('div');
        status.className = 'cla-overall-status';
        const dot = document.createElement('span');
        dot.className = 'cla-status-dot';
        const statusText = document.createElement('span');
        statusText.dataset.claOverallStatus = '';
        statusText.textContent = '运行正常';
        status.append(dot, statusText);

        const mainPage = document.createElement('section');
        mainPage.className = 'cla-page';
        mainPage.dataset.claPage = 'main';
        mainPage.append(
            createSwitch('pageAcceleration', '页面加载加速', '让酒馆第二次打开更快', this.settings.pageAcceleration, this.onSettingChange),
            createSwitch('chatOptimization', '聊天与重美化优化', '减少长聊天、人物面板和复杂正则造成的卡顿', this.settings.chatOptimization, this.onSettingChange),
            createSwitch('interactionOptimization', '界面操作优化', '让抽屉、弹窗、输入与拖动保持流畅可用', this.settings.interactionOptimization, this.onSettingChange),
        );

        const actions = document.createElement('div');
        actions.className = 'cla-actions';
        actions.append(createButton('重新渲染当前聊天', 'fa-solid fa-wand-magic-sparkles', async () => {
            const result = await this.onRerender();
            if (result.unavailable) {
                globalThis.toastr?.warning?.('当前酒馆不支持局部刷新，已保留聊天；下次打开聊天时应用', '云酒馆加速器');
                return;
            }
            if (result.cancelled || result.skipped) {
                globalThis.toastr?.info?.('聊天状态已变化或正在生成，已停止本次刷新', '云酒馆加速器');
                return;
            }
            globalThis.toastr?.success?.(`已刷新 ${result.completed || 0} 条消息`, '云酒馆加速器');
        }));
        const repairBox = document.createElement('div');
        repairBox.className = 'cla-repair';
        const repairText = document.createElement('span');
        repairText.textContent = '遇到显示异常？';
        repairBox.append(repairText, createButton('修复插件', 'fa-solid fa-screwdriver-wrench', async () => {
            const result = await this.onRepair();
            globalThis.toastr?.success?.(`修复完成，已预热 ${result?.warmed || 0} 个资源`, '云酒馆加速器');
        }, 'cla-repair-button'));
        this.performance = createPerformancePanel(this.onPerformanceChange);
        this.advanced = createAdvancedPanel({
            onCopyDiagnostics: this.onCopyDiagnostics, performanceDiagnostics: this.performanceDiagnostics,
        });
        mainPage.append(this.performance.element, actions, repairBox, this.advanced.element);
        this.worldInfoControl?.dispose();
        this.worldInfoControl = createWorldInfoPageSizeSetting(this.worldInfoPageSize);
        const chatDisplayPage = createChatDisplayPage(this.settings, this.onSettingChange, this.worldInfoControl);
        const miniPage = document.createElement('section');
        miniPage.className = 'cla-page'; miniPage.dataset.claPage = 'mini-features';
        for (const [key, title, description] of [
            ['regexCollections', '正则分类与多选', '直接在合集里勾选、按住名称划选和拖动归组'],
            ['transferTools', '世界书 / 正则 / 预设转移', '双栏复制与移动，可连续阅读世界书和已启用的预设条目'],
            ['presetEntryActions', '预设条目分类与操作', '多层文件夹、长按多选与原始顺序，以及行内新建与复制'],
            ['presetTokenPreview', '预设实时 token', '编辑条目时即时统计原文 token'],
            ['secretKeyBatch', '密钥批量删除', '在密钥管理弹窗里多选删除'],
            ['chatHistoryBatch', '聊天批量操作', '在聊天记录中多选删除，保护当前聊天'],
            ['autoConnect', '自动连接 API', '进入酒馆或切换密钥后连接一次；手动取消后不自动重试'],
        ]) miniPage.append(createSwitch(key, title, description, this.settings[key], this.onSettingChange));
        const pages = [
            { key: 'main', label: '常用', page: mainPage },
            { key: 'chat-display', label: '聊天显示', page: chatDisplayPage },
            { key: 'mini-features', label: '小功能', page: miniPage },
        ];
        content.append(status, createTabs(pages), mainPage, chatDisplayPage, miniPage);
        body.append(content);
        header.append(title, body);
        root.append(header);
        host.append(root);
        this.root = root;
        void this.worldInfoControl.refresh();
        return true;
    }

    refresh({ opening = false } = {}) {
        if (!this.root || (!opening && this.drawerIcon?.classList.contains('down'))) return;
        if (opening) void this.worldInfoControl?.refresh();
        if (this.refreshPromise) return this.refreshPromise;
        const root = this.root;
        const promise = this.refreshStatus(root).finally(() => {
            if (this.refreshPromise === promise) this.refreshPromise = null;
        });
        this.refreshPromise = promise;
        return promise;
    }

    async refreshStatus(root) {
        const status = await this.getStatus();
        if (this.root !== root || !root.isConnected) return;
        this.performance?.update(status.performance);
        this.advanced?.update(status);
        const label = this.root.querySelector('[data-cla-overall-status]');
        const problem = status.warning === true || status.cache === '错误' || status.chat === '错误' || status.interaction === '错误';
        this.root.dataset.state = problem ? 'warning' : 'ok';
        if (label) label.textContent = status.overall || (problem ? '部分功能需要修复' : '运行正常');
    }

    remove() {
        this.performanceDiagnostics?.stop();
        this.worldInfoControl?.dispose();
        this.worldInfoControl = null;
        this.root?.remove();
        this.root = this.drawerIcon = this.advanced = this.performance = null;
    }
}
