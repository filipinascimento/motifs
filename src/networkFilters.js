export const MIN_NETWORK_COMPONENT_SIZE = 4

/**
 * Prune small components after all active Helios node and edge rules.
 * render+layout keeps the visible graph and layout topology identical.
 */
export function applyNetworkTopologyFilter(helios, minimumSize = MIN_NETWORK_COMPONENT_SIZE) {
  const filters = helios?.behavior?.filters
  if (!filters?.setScope || !filters?.setMinComponentSize) {
    throw new Error('Helios filters behavior is unavailable')
  }
  filters.setScope('render+layout')
  filters.setMinComponentSize(minimumSize)
  return filters.getPublicState?.() || null
}
