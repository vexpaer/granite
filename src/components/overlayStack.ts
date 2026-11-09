const overlays: symbol[] = [];

export function registerOverlay() {
  const token = Symbol('granite-overlay');
  overlays.push(token);
  return {
    token,
    dispose() {
      const index = overlays.indexOf(token);
      if (index >= 0) overlays.splice(index, 1);
    },
  };
}

export function isTopOverlay(token: symbol | undefined) {
  return Boolean(token && overlays[overlays.length - 1] === token);
}
