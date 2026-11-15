// A camera can advance while pose inference is running. Read its pixels once
// so the detector and any JPEG selected by onFrame describe the same image.
// The returned canvas is reusable: consumers must read it during onFrame.
export function copyCameraFrame(source, width, height, canvas) {
  if (!source || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if ('readyState' in source && source.readyState < 2) return null;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}
