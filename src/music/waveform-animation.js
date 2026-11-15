// Audio controls the motion directly. Keep sampling and SVG transforms out of
// React so animation frames do not re-render the timeline or its controls.
export function animateWaveform(svg, exerciseId, readSpectrum, {
  windowImpl = window, documentImpl = document,
} = {}) {
  const bars = [...svg.querySelectorAll('rect')];
  const spectrum = new Uint8Array(32);
  const reducedMotion = windowImpl.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = null;
  let disposed = false;
  let animated = false;

  function reset() {
    if (!animated) return;
    for (const bar of bars) { bar.style.removeProperty('transform'); bar.style.removeProperty('opacity'); }
    animated = false;
  }
  function tick() {
    frame = null;
    if (disposed || documentImpl.hidden || reducedMotion.matches) { reset(); return; }
    if (readSpectrum(exerciseId, spectrum)) {
      const peak = Math.max(...spectrum) / 255;
      for (let index = 0; index < bars.length; index++) {
        const energy = spectrum[Math.floor(index * spectrum.length / bars.length)] / 255;
        // Keep the section's original waveform visible as it responds to the
        // instrument's overall pulse and the energy in each frequency band.
        bars[index].style.transform = `scaleY(${(0.5 + peak * 0.45 + energy * 0.2).toFixed(3)})`;
        bars[index].style.opacity = (0.55 + peak * 0.3 + energy * 0.15).toFixed(3);
      }
      animated = true;
    } else reset();
    frame = windowImpl.requestAnimationFrame(tick);
  }
  function synchronize() {
    if (frame !== null) windowImpl.cancelAnimationFrame(frame);
    frame = null;
    if (disposed || documentImpl.hidden || reducedMotion.matches) reset();
    else frame = windowImpl.requestAnimationFrame(tick);
  }
  documentImpl.addEventListener('visibilitychange', synchronize);
  reducedMotion.addEventListener('change', synchronize);
  synchronize();
  return () => {
    disposed = true;
    if (frame !== null) windowImpl.cancelAnimationFrame(frame);
    documentImpl.removeEventListener('visibilitychange', synchronize);
    reducedMotion.removeEventListener('change', synchronize);
    reset();
  };
}
