import { PromptToggleAdapter } from '../adapters/prompt-toggle.js';
import { InteractionRecoveryGuard } from './interaction-recovery-guard.js';
import { KeyboardOverlayGuard } from './keyboard-overlay-guard.js';
import { MobileInteractionGuard } from './mobile-interaction-guard.js';
import { UiRenderOptimizer } from './ui-render-optimizer.js';

export class InteractionOptimizer {
    constructor({ isGenerating, eventSource, eventTypes, onStatus = null } = {}) {
        this.onStatus = onStatus;
        this.promptToggle = new PromptToggleAdapter({ isGenerating, eventSource, eventTypes });
        this.mobileGuard = new MobileInteractionGuard({
            onRecovered: diagnostic => this.reportRecovery(diagnostic),
        });
        this.keyboardOverlay = new KeyboardOverlayGuard();
        this.recoveryGuard = new InteractionRecoveryGuard({
            onRecovered: diagnostic => this.reportRecovery(diagnostic),
        });
        this.uiRender = new UiRenderOptimizer();
        this.features = null;
        this.lastRecovery = null;
        this.recoveryCount = 0;
        this.started = false;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        const [promptToggleActive, recoveryGuardActive, mobileGuardActive, keyboardOverlayActive, renderProfile] = await Promise.all([
            this.promptToggle.start(),
            this.recoveryGuard.start(),
            this.mobileGuard.start(),
            this.keyboardOverlay.start(),
            this.uiRender.start(),
        ]);
        if (!this.started) {
            this.promptToggle.stop();
            this.recoveryGuard.stop();
            this.mobileGuard.stop();
            this.keyboardOverlay.stop();
            this.uiRender.stop();
            return;
        }
        this.features = { promptToggleActive, recoveryGuardActive, mobileGuardActive, keyboardOverlayActive, renderProfile };
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
            keyboardOverlayActive,
            renderProfile,
        } = this.features || {};
        const status = [
            promptToggleActive ? '预设即时切换' : null,
            renderProfile === 'webkit'
                ? 'WebKit 流畅'
                : (renderProfile === 'balanced' ? '触屏流畅' : (renderProfile === 'desktop' ? '桌面流畅' : null)),
            recoveryGuardActive ? '全平台自愈' : null,
            mobileGuardActive ? '触控保护' : null,
            keyboardOverlayActive ? '键盘防遮挡' : null,
            this.lastRecovery
                ? `已恢复 ${this.lastRecovery.reason}${this.lastRecovery.blocker ? `（${this.lastRecovery.blocker}）` : ''} ×${this.recoveryCount}`
                : null,
        ].filter(Boolean).join(' · ');
        this.onStatus?.('interaction', status || '原生');
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.promptToggle.stop();
        this.recoveryGuard.stop();
        this.mobileGuard.stop();
        this.keyboardOverlay.stop();
        this.uiRender.stop();
        this.features = null;
        this.lastRecovery = null;
        this.recoveryCount = 0;
    }
}
