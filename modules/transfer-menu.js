// The native wand menu is appended to body. Keep the entry available while
// leaving the transfer, reader and editor implementations off the ready path.
export class TransferMenu {
    constructor(options) {
        this.options = options;
        this.onClick = event => { event.preventDefault(); void this.open(); };
        this.onKey = event => {
            if (event.key === 'Enter' || event.key === ' ') this.onClick(event);
        };
    }

    start() {
        if (this.observer) return;
        this.observer = new MutationObserver(() => {
            if (!this.menu?.isConnected) this.mount();
        });
        this.observer.observe(document.body, { childList: true });
        this.mount();
    }

    mount() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || this.menu?.isConnected) return;
        this.menu?.removeEventListener('click', this.onClick);
        this.menu?.removeEventListener('keydown', this.onKey);
        const item = document.createElement('div');
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.id = 'cla-transfer-menu';
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-copy';
        const label = document.createElement('span');
        label.textContent = '条目转移';
        item.append(icon, label);
        item.addEventListener('click', this.onClick);
        item.addEventListener('keydown', this.onKey);
        this.menu = item;
        menu.append(item);
    }

    async open() {
        if (!this.observer || this.opening) return;
        const open = this.opening = {};
        try {
            const { TransferTools } = await import('./transfer-tools.js');
            if (this.opening !== open) return;
            const tools = this.tools = new TransferTools(this.options);
            await tools.open();
        } catch (error) {
            if (this.opening === open) globalThis.toastr?.error?.(error.message || '转移工具暂时不可用', '云酒馆加速器');
        } finally {
            if (this.opening === open) this.opening = this.tools = null;
        }
    }

    stop() {
        this.observer?.disconnect();
        this.observer = null;
        this.menu?.removeEventListener('click', this.onClick);
        this.menu?.removeEventListener('keydown', this.onKey);
        this.menu?.remove();
        this.menu = null;
        this.opening = null;
        this.tools?.stop();
        this.tools = null;
    }
}
