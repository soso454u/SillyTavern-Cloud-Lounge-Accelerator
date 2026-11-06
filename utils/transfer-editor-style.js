// Keep editor layout with its controller: an older cached extension stylesheet
// must not turn the expanded dialog into a small, unstyled browser dialog.
const editorStyles = `
#cla-transfer-editor { text-align: left; min-width: 0; }
#cla-transfer-editor > label { display: flex; flex-direction: column; gap: 5px; margin: 8px 0; }
#cla-transfer-editor :is(input, textarea, select) { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; margin: 0; font: inherit; }
#cla-transfer-editor textarea { display: block; height: clamp(180px, 30vh, 360px); min-height: 180px; resize: vertical; }
#cla-transfer-editor [hidden] { display: none !important; }
#cla-transfer-editor .cla-transfer-world-fields { display: grid !important; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px 8px; margin: 10px 0; }
#cla-transfer-editor .cla-transfer-world-fields > label { display: flex; flex-direction: column; gap: 3px; min-width: 0; margin: 0; font-size: .85em; }
#cla-transfer-editor .cla-transfer-world-fields :is(input, select) { height: 32px; min-height: 32px; padding: 3px 6px; }
#cla-transfer-editor .cla-transfer-position { grid-column: span 2; }
#cla-transfer-editor .cla-transfer-keywords { display: grid !important; grid-template-columns: minmax(0, 1fr) 90px minmax(0, 1fr); align-items: start; gap: 8px; margin: 10px 0; }
#cla-transfer-editor .cla-transfer-keywords > label { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 0; font-size: .85em; }
#cla-transfer-editor .cla-transfer-keywords textarea { display: block; height: 3.3em; min-height: 3.3em; padding: 4px 6px; }
#cla-transfer-editor .cla-transfer-keywords select { height: 32px; min-height: 32px; padding: 3px 6px; }
:is(#cla-transfer-editor, #cla-transfer-expanded-editor) .cla-transfer-field-heading { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: 6px; min-width: 0; }
:is(#cla-transfer-editor, #cla-transfer-expanded-editor) button.cla-transfer-expand { appearance: none; display: inline-flex; flex: 0 0 26px; align-items: center; justify-content: center; width: 26px; min-width: 26px; max-width: 26px; height: 26px; min-height: 26px; margin: 0; padding: 3px; border: 0; border-radius: 4px; box-shadow: none; background: transparent; color: inherit; cursor: pointer; line-height: 1; }
:is(#cla-transfer-editor, #cla-transfer-expanded-editor) .cla-transfer-expand svg { display: block; width: 16px; height: 16px; pointer-events: none; }
:is(#cla-transfer-editor, #cla-transfer-expanded-editor) .cla-transfer-expand:focus-visible { outline: 2px solid var(--SmartThemeQuoteColor, #7594df); }
#cla-transfer-expanded-editor[open] { display: flex !important; flex-direction: column; position: fixed !important; inset: 10px !important; width: calc(100vw - 20px) !important; max-width: none !important; height: calc(100dvh - 20px) !important; max-height: none !important; min-width: 0; min-height: 0; box-sizing: border-box; gap: 8px; margin: 0 !important; padding: 12px; overflow: hidden; border: 1px solid var(--SmartThemeBorderColor, #888); border-radius: 12px; background: var(--cla-editor-surface, #20242c) !important; color: var(--cla-editor-text, #ddd); opacity: 1; transform: none !important; backdrop-filter: none; }
#cla-transfer-expanded-editor::backdrop { background: #0008; backdrop-filter: none; }
#cla-transfer-expanded-editor > textarea { display: block !important; flex: 1 1 0; width: 100% !important; max-width: 100%; height: 0; min-height: 0 !important; margin: 0; padding: 8px; resize: none; box-sizing: border-box; border: 1px solid var(--SmartThemeBorderColor, #888); border-radius: 8px; background: var(--cla-editor-surface, #20242c) !important; color: inherit; font: inherit; }
@media (max-width: 760px) {
    #cla-transfer-editor .cla-transfer-world-fields { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
    #cla-transfer-editor .cla-transfer-keywords { grid-template-columns: 80px minmax(0, 1fr); }
    #cla-transfer-editor .cla-transfer-keywords > label:first-child { grid-column: 1 / -1; }
}
`;

export function ensureTransferEditorStyles() {
    let style = document.getElementById('cla-transfer-editor-style');
    if (!style) { style = document.createElement('style'); style.id = 'cla-transfer-editor-style'; document.head.append(style); }
    if (style.textContent !== editorStyles) style.textContent = editorStyles;
}
