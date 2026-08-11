import { createAdvancedPanel } from './advanced-panel.js';
import { createPerformancePanel } from './performance-panel.js';

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

export class SettingsPanel {
    constructor({ settings, onSettingChange, onPerformanceChange, onRerender, onRepair, getStatus }) {
        this.settings = settings;
        this.onSettingChange = onSettingChange;
        this.onPerformanceChange = onPerformanceChange;
        this.onRerender = onRerender;
        this.onRepair = onRepair;
        this.getStatus = getStatus;
        this.root = null;
        this.advanced = null;
        this.performance = null;
    }

    mount() {
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
        body.className = 'inline-drawer-content cla-body';

        const status = document.createElement('div');
        status.className = 'cla-overall-status';
        const dot = document.createElement('span');
        dot.className = 'cla-status-dot';
        const statusText = document.createElement('span');
        statusText.dataset.claOverallStatus = '';
        statusText.textContent = '运行正常';
        status.append(dot, statusText);

        body.append(
            status,
            createSwitch('pageAcceleration', '页面加载加速', '让酒馆第二次打开更快', this.settings.pageAcceleration, this.onSettingChange),
            createSwitch('chatOptimization', '聊天与重美化优化', '减少长聊天、人物面板和复杂正则造成的卡顿', this.settings.chatOptimization, this.onSettingChange),
            createSwitch('interactionOptimization', '界面操作优化', '生成时可立即切换预设，并自愈手机透明遮罩', this.settings.interactionOptimization, this.onSettingChange),
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
        this.advanced = createAdvancedPanel();
        body.append(this.performance.element, actions, repairBox, this.advanced.element);
        header.append(title, body);
        root.append(header);
        host.append(root);
        this.root = root;
        void this.refresh();
        return true;
    }

    async refresh() {
        if (!this.root) return;
        const status = await this.getStatus();
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
