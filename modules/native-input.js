// Remove only our retired keyboard overlay state. The browser and SillyTavern
// own layout, scrolling, focus, selection, and the soft keyboard lifecycle.
export function restoreNativeInputLayout(documentRef = globalThis.document) {
    const form = documentRef?.querySelector?.('#form_sheld');
    for (const element of [form, documentRef?.body]) {
        element?.classList?.remove?.('cla-keyboard-overlay', 'cla-keyboard-closing');
        element?.style?.removeProperty?.('--cla-keyboard-shift');
    }
}
