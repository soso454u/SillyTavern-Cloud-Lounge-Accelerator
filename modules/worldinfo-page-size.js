// Use the same account-scoped preference and pagination control as native
// SillyTavern. Do not duplicate this setting in extension_settings.
export const WORLD_INFO_PAGE_SIZES = Object.freeze([10, 25, 50, 100, 500, 1000]);
export const WORLD_INFO_DEFAULT_PAGE_SIZE = 25;
const STORAGE_KEY = 'WI_PerPage';
export const WORLD_INFO_PAGER_SELECTOR = '#world_info_pagination .J-paginationjs-size-select';

export class WorldInfoPageSize {
    constructor({
        documentRef = globalThis.document,
        importStorage = () => import('../../../../util/AccountStorage.js'),
    } = {}) {
        this.document = documentRef;
        this.importStorage = importStorage;
        this.storagePromise = null;
    }

    async storage() {
        this.storagePromise ??= this.importStorage().then(({ accountStorage }) => {
            if (typeof accountStorage?.getItem !== 'function' || typeof accountStorage?.setItem !== 'function') {
                throw new Error('当前酒馆不支持原生世界书分页设置');
            }
            return accountStorage;
        }).catch(error => {
            this.storagePromise = null;
            throw error;
        });
        return this.storagePromise;
    }

    async read() {
        const storage = await this.storage();
        const value = Number(storage.getItem(STORAGE_KEY));
        return WORLD_INFO_PAGE_SIZES.includes(value) ? value : WORLD_INFO_DEFAULT_PAGE_SIZE;
    }

    async write(value) {
        if (!WORLD_INFO_PAGE_SIZES.includes(value)) throw new Error('无效的世界书分页数量');
        const storage = await this.storage();
        const pager = this.document?.querySelector(WORLD_INFO_PAGER_SELECTOR);
        // If a native book is already loaded, let the native paginator update
        // its own page size, current page, editor rows and storage. Otherwise
        // the preference is picked up on the next native render.
        if (pager && pager.value !== String(value)
            && Array.from(pager.options || []).some(option => option.value === String(value))) {
            pager.value = String(value);
            const EventClass = pager.ownerDocument?.defaultView?.Event ?? globalThis.Event;
            pager.dispatchEvent(new EventClass('change', { bubbles: true }));
        }
        // The native change handler normally saves synchronously. Only write if
        // it did not (or the editor has not been initialized yet).
        const saved = Number(storage.getItem(STORAGE_KEY)) || WORLD_INFO_DEFAULT_PAGE_SIZE;
        if (saved !== value) storage.setItem(STORAGE_KEY, String(value));
    }
}
