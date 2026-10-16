import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { engineRuntime } from '../engine/EngineRuntime';

const DOMAIN = 0x5543;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want): void {
    engineRuntime.acceptIncomingWant(want);
  }

  onNewWant(want: Want): void {
    engineRuntime.acceptIncomingWant(want);
  }

  onDestroy(): void {
    engineRuntime.shutdown().catch(() => {
      hilog.error(DOMAIN, 'UniClipboard', 'Shutdown failed');
    });
  }

  onForeground(): void {
    engineRuntime.onForeground();
  }

  onBackground(): void {
    engineRuntime.onBackground();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    try {
      windowStage.loadContent('pages/Index', (error) => {
        if (error.code !== 0) {
          hilog.error(DOMAIN, 'UniClipboard', 'Failed to load the main page: %{public}d', error.code);
        }
      });
    } catch (_error) {
      hilog.error(DOMAIN, 'UniClipboard', 'Failed to request the main page');
    }
  }
}
