import { PromptToggleAdapter } from '../adapters/prompt-toggle.js';
import { InteractionRecoveryGuard } from './interaction-recovery-guard.js';
import { InputRevealGuard, restoreNativeInputLayout } from './native-input.js';
import { MobileInteractionGuard } from './mobile-interaction-guard.js';
import { UiRenderOptimizer } from './ui-render-optimizer.js';

const RENDER_PROFILE_LABELS = Object.freeze({
    desktop: '桌面流畅',
    balanced: '触屏流畅',
    webkit: 'WebKit 流畅',
});

export class InteractionOptimizer {
    constructor({ isGenerating, eventSource, eventTypes, onStatus = null } = {}) {
        this.onStatus = onStatus;
        this.promptToggle = new PromptToggleAdapter({ isGenerating, eventSource, eventTypes });
        this.mobileGuard = new MobileInteractionGuard({
            onRecovered: diagnostic => this.reportRecovery(diagnostic),
        });
        this.recoveryGuard = new InteractionRecoveryGuard({
            onRecovered: diagnostic => this.reportRecovery(diagnostic),
        });
        this.inputReveal = new InputRevealGuard();
        this.uiRender = new UiRenderOptimizer();
        this.features = null;
        this.lastRecovery = null;
        this.recoveryCount = 0;
        this.started = false;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        restoreNativeInputLayout();
        const [promptToggleActive, recoveryGuardActive, mobileGuardActive, inputRevealActive, renderProfile] = await Promise.all([
            this.promptToggle.start(),
            this.recoveryGuard.start(),
            this.mobileGuard.start(),
            this.inputReveal.start(),
            this.uiRender.start(),
        ]);
        if (!this.started) {
            this.stopFeatures();
            return;
        }
        this.features = { promptToggleActive, recoveryGuardActive, mobileGuardActive, inputRevealActive, renderProfile };
        this.emitStatus();
    }

    reportRecovery(diagnostic = {}) {
        this.recoveryCount += 1;
        this.lastRecovery = {
            reason: diagnostic.reason || '交互阻塞',
            blocker: diagnostic.blocker || null,
        };
        this.emitStatus();
    }

    emitStatus() {
        if (!this.started) return;
        const {
            promptToggleActive,
            recoveryGuardActive,
            mobileGuardActive,
            inputRevealActive,
            renderProfile,
        } = this.features || {};
        const status = [
            promptToggleActive ? '预设即时切换' : null,
            RENDER_PROFILE_LABELS[renderProfile],
            recoveryGuardActive ? '全平台自愈' : null,
            mobileGuardActive ? '触控保护' : null,
            '原生输入布局',
            inputRevealActive ? 'iOS 输入显现' : null,
            this.lastRecovery
                ? `已恢复 ${this.lastRecovery.reason}${this.lastRecovery.blocker ? `（${this.lastRecovery.blocker}）` : ''} ×${this.recoveryCount}`
                : null,
        ].filter(Boolean).join(' · ');
        this.onStatus?.('interaction', status || '原生');
    }

    stopFeatures() {
        this.promptToggle.stop();
        this.recoveryGuard.stop();
        this.mobileGuard.stop();
        this.inputReveal.stop();
        restoreNativeInputLayout();
        this.uiRender.stop();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.stopFeatures();
        this.features = null;
        this.lastRecovery = null;
        this.recoveryCount = 0;
    }
}
