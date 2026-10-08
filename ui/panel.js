import { createAdvancedPanel } from './advanced-panel.js';
import { createPerformancePanel } from './performance-panel.js';
import { CHAT_PAGE_SIZE_MAX, CHAT_PAGE_SIZE_MIN, normalizeChatPageSize } from '../client-core.js';

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

function createChatDisplayPage(settings, onSettingChange) {
    const page = document.createElement('section');
    page.className = 'cla-page cla-chat-display-page';
    page.dataset.claPage = 'chat-display';

    const heading = document.createElement('div');
    heading.className = 'cla-page-heading';
    const title = document.createElement('strong');
    title.textContent = '聊天显示';
    const description = document.createElement('small');
    description.textContent = '单独调整每次显示的消息数量';
    heading.append(title, description);

    const setting = document.createElement('label');
    setting.className = 'cla-number-setting';
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = '每页渲染消息';
    const note = document.createElement('small');
    note.textContent = `可选 ${CHAT_PAGE_SIZE_MIN}–${CHAT_PAGE_SIZE_MAX} 条；iPhone / iPad 推荐 3–5 条`;
    text.append(name, note);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'text_pole cla-page-size-input';
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
            globalThis.toastr?.success?.(`已改为每页渲染 ${value} 条消息`, '云酒馆加速器');
        } catch (error) {
            input.value = String(previous);
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '云酒馆加速器');
        } finally {
            input.disabled = false;
        }
    });
    setting.append(text, input);

    const boundary = document.createElement('p');
    boundary.className = 'cla-setting-note';
    boundary.textContent = '这只改变页面首次显示和“显示更多”的数量；不删除聊天，也不会减少发给模型的历史上下文。数量越大，复杂美化和正则越可能让手机卡顿。';
    page.append(heading, setting, boundary);
    return page;
}

export class SettingsPanel {
    constructor({ settings, onSettingChange, onPerformanceChange, onRerender, onRepair, onCopyDiagnostics, getStatus }) {
        this.settings = settings;
        this.onSettingChange = onSettingChange;
        this.onPerformanceChange = onPerformanceChange;
        this.onRerender = onRerender;
        this.onRepair = onRepair;
        this.onCopyDiagnostics = onCopyDiagnostics;
        this.getStatus = getStatus;
        this.root = null;
        this.advanced = null;
        this.performance = null;
        this.refreshPromise = null;
    }

    mount() {
        if (this.root?.isConnected) return true;
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
        this.advanced = createAdvancedPanel({ onCopyDiagnostics: this.onCopyDiagnostics });
        mainPage.append(this.performance.element, actions, repairBox, this.advanced.element);
        const chatDisplayPage = createChatDisplayPage(this.settings, this.onSettingChange);
        const pages = [
            { key: 'main', label: '常用', page: mainPage },
            { key: 'chat-display', label: '聊天显示', page: chatDisplayPage },
        ];
        content.append(status, createTabs(pages), mainPage, chatDisplayPage);
        body.append(content);
        header.append(title, body);
        root.append(header);
        host.append(root);
        this.root = root;
        void this.refresh();
        return true;
    }

    refresh() {
        if (!this.root) return;
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
        this.root?.remove();
        this.root = null;
    }
}
