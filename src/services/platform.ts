import { hostCall, nativeHost } from "./host";
import type { ImportResult } from "../types";
interface PlatformApp {
  history: unknown[];
  route: { name: string };
  settings: { reader: { keepAwake: boolean } };
  importResults:ImportResult[];
  back(): void;
  pauseSession(reason: string): void;
  importInputs(files: { name: string; bytes: Uint8Array }[]): Promise<void>;
  notify(message: string): void;
}
export const androidHost = () =>
  nativeHost && /Android/i.test(navigator.userAgent);
export async function updatePlatform(app: PlatformApp) {
  if (!androidHost()) return;
  await hostCall("lifecycle.back", {
    enabled: app.history.length > 0 || app.route.name === "reader",
  });
  await hostCall("lifecycle.immersive", {
    enabled: app.route.name === "reader",
  });
  await hostCall("lifecycle.keepAwake", {
    enabled: app.route.name === "reader" && app.settings.reader.keepAwake,
  });
}
export async function initializePlatform(app: PlatformApp) {
  if (!androidHost()) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("granite://android-back", () => {
    const event = new CustomEvent("granite:back", { cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) app.back();
  });
  const consume = async () => {
    try {
      const files =
        await hostCall<{ id:string; name: string; bytes: number[] }[]>("share.consume");
      if (files?.length){
        await app.importInputs(
          files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) })),
        );
        const acknowledged=files.filter(file=>app.importResults.some(result=>result.filename===file.name&&['success','duplicate'].includes(result.status))).map(file=>file.id);
        if(acknowledged.length)await hostCall('share.ack',{ids:acknowledged});
      }
    } catch (e) {
      app.notify(`分享导入失败：${String(e)}`);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) app.pauseSession("background");
    else void consume();
  });
  await updatePlatform(app);
  await consume();
}
