import { AsyncLocalStorage } from 'async_hooks';
import { EntityManager } from 'typeorm';

export interface RlsContextData {
  tenantId?: string;
  entityManager?: EntityManager;
  isAdmin?: boolean;
}

export const rlsContext = new AsyncLocalStorage<RlsContextData>();

/**
 * Returns the request-scoped transaction-bound EntityManager if available,
 * otherwise falls back to the default fallback EntityManager.
 */
export function getManager(fallback: EntityManager): EntityManager {
  const store = rlsContext.getStore();
  if (store && store.entityManager) {
    return store.entityManager;
  }
  return fallback;
}
