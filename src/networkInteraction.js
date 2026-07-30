export async function switchNetworkMode({
  helios,
  button,
  currentMode,
  onModeChange,
  isCurrent = () => true,
  onError = () => {},
}) {
  const previousMode = currentMode === '2d' ? '2d' : '3d'
  const nextMode = previousMode === '2d' ? '3d' : '2d'
  onModeChange(nextMode)
  if (button) {
    button.textContent = nextMode.toUpperCase()
    button.disabled = true
  }
  try {
    await helios.setMode(nextMode)
    if (isCurrent()) await helios.frameNetwork({ animate: true, durationMs: 350, paddingRatio: .05 })
    return { mode: nextMode, applied: true }
  } catch (error) {
    if (isCurrent()) {
      onModeChange(previousMode)
      if (button?.isConnected !== false) button.textContent = previousMode.toUpperCase()
      onError(error)
    }
    return { mode: isCurrent() ? previousMode : nextMode, applied: false, error }
  } finally {
    if (button?.isConnected !== false) button.disabled = false
  }
}
