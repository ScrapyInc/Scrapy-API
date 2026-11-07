/**
 * Stage 2 credit pack catalog.
 *
 * Packs are intentionally hardcoded for now. The API contract only exposes
 * `pack_id`, so moving the catalog into a database table later will not change
 * the HTTP surface.
 */
export interface CreditPack {
  /** Public identifier sent by clients. */
  id: string;
  /** Price in US dollars. */
  amountUsd: number;
  /** Credits granted when the pack is purchased. */
  credits: number;
}

export const CREDIT_PACKS: readonly CreditPack[] = Object.freeze([
  Object.freeze({ id: 'pack_10usd', amountUsd: 10, credits: 10000 }),
  Object.freeze({ id: 'pack_50usd', amountUsd: 50, credits: 55000 }),
  Object.freeze({ id: 'pack_100usd', amountUsd: 100, credits: 115000 }),
]);

const CREDIT_PACKS_BY_ID = new Map(CREDIT_PACKS.map((pack) => [pack.id, pack]));

/** Returns the pack with this id, or null when the id is unknown. */
export function getCreditPack(packId: string): CreditPack | null {
  return CREDIT_PACKS_BY_ID.get(packId) ?? null;
}

/** Returns every purchasable pack in catalog order. */
export function listCreditPacks(): CreditPack[] {
  return [...CREDIT_PACKS];
}
