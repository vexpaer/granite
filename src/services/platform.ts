import { hostCall, nativeHost } from "./host";
import type { ImportResult } from "../types";
interface PlatformApp {
  history: unknown[];
  route: { name: string };
  settings: { reader: { keepAwake: boolean } };
  importResults:ImportResult[];
  back(): void;
  pauseSession(reason: string): void;
  importInputs(
    files: { name: string; bytes: Uint8Array }[],
    options?: { notify?: boolean },
  ): Promise<ImportResult[]>;
  notify(message: string): void;
}
export function successfulShareAcknowledgementIds(
  files: { id: string; name: string }[],
  results: ImportResult[],
): string[] {
  return files.flatMap((file, index) => {
    const status = results[index]?.status;
    return status === "success" || status === "duplicate" ? [file.id] : [];
  });
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
  let consuming = false;
  const consume = async () => {
    if (consuming) return;
    consuming = true;
    try {
      const files = await hostCall<{ id: string; name: string; size: number }[]>("share.consume");
      if (!files?.length) return;

      let imported = 0;
      let duplicates = 0;
      let failed = 0;
      let cancelled = 0;
      let interrupted = "";

      for (const file of files) {
        let payload: { id: string; name: string; bytes: number[] };
        try {
          payload = await hostCall<{ id: string; name: string; bytes: number[] }>("share.read", { id: file.id });
        } catch (error) {
          interrupted = String(error);
          break;
        }

        let results: ImportResult[];
        try {
          results = await app.importInputs(
            [{ name: payload.name, bytes: new Uint8Array(payload.bytes) }],
            { notify: false },
          );
        } catch (error) {
          interrupted = String(error);
          break;
        }

        const result = results[0];
        const acknowledged = successfulShareAcknowledgementIds([file], results);
        if (acknowledged.length) {
          await hostCall("share.ack", { ids: acknowledged });
          if (result?.status === "success") imported += 1;
          else duplicates += 1;
        } else if (result?.status === "error") {
          failed += 1;
        } else {
          cancelled += 1;
        }
      }

      if (interrupted) {
        app.notify(`分享导入中断：${interrupted}`);
      } else {
        app.notify(
          `分享导入完成：${imported} 本新增，${duplicates} 本重复，${failed} 项失败${cancelled ? `，${cancelled} 项取消` : ""}`,
        );
      }
    } catch (error) {
      app.notify(`分享导入失败：${String(error)}`);
    } finally {
      consuming = false;
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) app.pauseSession("background");
    else void consume();
  });
  await updatePlatform(app);
  await consume();
}
