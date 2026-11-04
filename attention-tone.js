// Shared by the workspace and optional Chrome offscreen document. No network.
let tabPilotAudioContext;
async function tabPilotAttentionTone({ unlockOnly = false } = {}) {
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return false;
    tabPilotAudioContext ??= new Audio();
    await tabPilotAudioContext.resume();
    if (tabPilotAudioContext.state !== "running") return false;
    if (unlockOnly) return true;
    const now = tabPilotAudioContext.currentTime;
    for (const [offset, frequency] of [
      [0, 660],
      [0.19, 880],
    ]) {
      const oscillator = tabPilotAudioContext.createOscillator(),
        gain = tabPilotAudioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.065, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.16);
      oscillator.connect(gain);
      gain.connect(tabPilotAudioContext.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.18);
    }
    return true;
  } catch {
    return false;
  }
}
