import connection from '@ohos.net.connection';
import type { BusinessError } from '@kit.BasicServicesKit';

interface NetworkRegistration {
  connection: connection.NetConnection;
  registered: boolean;
}

export class NetworkMonitor {
  private current?: NetworkRegistration;

  start(callback: () => void): void {
    if (this.current !== undefined) return;
    const registration: NetworkRegistration = {
      connection: connection.createNetConnection(), registered: false
    };
    this.current = registration;
    const notify = (): void => {
      if (this.current === registration) callback();
    };
    try {
      registration.connection.on('netAvailable', (_handle: connection.NetHandle): void => { notify(); });
      registration.connection.on('netLost', (_handle: connection.NetHandle): void => { notify(); });
      registration.connection.on('netUnavailable', notify);
      registration.connection.register((error: BusinessError<void>, _value: void): void => {
        if (error !== null && error !== undefined) {
          if (this.current === registration) this.current = undefined;
          return;
        }
        registration.registered = true;
        // A stopped registration still owns its eventual successful acquisition.
        if (this.current !== registration) this.release(registration);
      });
    } catch (_error) {
      if (this.current === registration) this.current = undefined;
      this.release(registration);
    }
  }

  stop(): void {
    const registration = this.current;
    this.current = undefined;
    if (registration !== undefined) this.release(registration);
  }

  private release(registration: NetworkRegistration): void {
    if (!registration.registered) return;
    registration.registered = false;
    try {
      registration.connection.unregister((_error: BusinessError<void>, _value: void): void => {});
    } catch (_error) {
      // The stopped registration cannot deliver events to any replacement.
    }
  }
}
