export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface PopupPositionInput {
  platform: NodeJS.Platform | string;
  trayBounds: RectLike | null;
  workArea: RectLike;
  width: number;
  height: number;
  margin?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Windows tray popups sit above the taskbar. macOS tray popups sit directly
 * below the menu-bar item and are horizontally centred on it.
 */
export function computePopupBounds(input: PopupPositionInput): RectLike {
  const margin = input.margin ?? 12;
  const wa = input.workArea;
  const maxX = wa.x + wa.width - input.width - margin;
  const maxY = wa.y + wa.height - input.height - margin;

  if (input.platform === 'darwin') {
    const desiredX = input.trayBounds
      ? input.trayBounds.x + input.trayBounds.width / 2 - input.width / 2
      : wa.x + wa.width - input.width - margin;
    const desiredY = input.trayBounds
      ? input.trayBounds.y + input.trayBounds.height + 6
      : wa.y + 8;
    return {
      x: Math.round(clamp(desiredX, wa.x + margin, maxX)),
      y: Math.round(clamp(Math.max(desiredY, wa.y + 8), wa.y + 8, maxY)),
      width: input.width,
      height: input.height,
    };
  }

  return {
    x: Math.round(maxX),
    y: Math.round(maxY),
    width: input.width,
    height: input.height,
  };
}
