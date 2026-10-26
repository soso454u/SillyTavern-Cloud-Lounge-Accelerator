const TARGETS = '#world_popup_entries_list, #saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts, [id$="prompt_manager_list"]';

export class DrawerAnimationAdapter {
    constructor() {
        this.onClick = this.onClick.bind(this);
    }

    start() {
        document.addEventListener('click', this.onClick, true);
    }

    stop() {
        document.removeEventListener('click', this.onClick, true);
    }

    onClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        const toggle = target?.closest('.inline-drawer-toggle');
        if (!toggle || target.closest('.text_pole') || !toggle.closest(TARGETS)) return;
        const drawer = toggle.closest('.inline-drawer');
        const content = drawer?.querySelector(':scope > .inline-drawer-content');
        if (!(content instanceof HTMLElement)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        const opening = getComputedStyle(content).display === 'none';
        icon?.classList.toggle('down', !opening);
        icon?.classList.toggle('up', opening);
        icon?.classList.toggle('fa-circle-chevron-down', !opening);
        icon?.classList.toggle('fa-circle-chevron-up', opening);
        drawer.dispatchEvent(new CustomEvent('inline-drawer-toggle', { bubbles: true }));

        if (opening) {
            content.style.display = '';
            if (getComputedStyle(content).display === 'none') content.style.display = 'block';
            content.animate?.([
                { opacity: 0, transform: 'translateY(-4px)' },
                { opacity: 1, transform: 'translateY(0)' },
            ], { duration: 120, easing: 'ease-out' });
            requestAnimationFrame(() => {
                for (const textarea of content.querySelectorAll('textarea.autoSetHeight')) {
                    textarea.style.height = 'auto';
                    textarea.style.height = `${textarea.scrollHeight}px`;
                }
            });
        } else {
            const animation = content.animate?.([
                { opacity: 1, transform: 'translateY(0)' },
                { opacity: 0, transform: 'translateY(-4px)' },
            ], { duration: 90, easing: 'ease-in' });
            if (animation) {
                const hide = () => { content.style.display = 'none'; };
                animation.finished.then(hide, hide);
            }
            else content.style.display = 'none';
        }
    }
}
