import { useSyncExternalStore } from 'react';
const subscribe = () => () => {};
// Portals can use document once the client has hydrated.
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
