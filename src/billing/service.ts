import { randomUUID } from 'node:crypto';

import type { ServiceStore, Tier } from '../db/service/types.ts';
import { HttpError } from '../http/errors.ts';
import { getCreditPack } from './credit-packs.ts';

export interface TopUpRequest {
  /** Developer who owns the API key used for this request. */
  userId: string;
  packId: string;
  /** Optional echo of the pack price; rejected when it disagrees with the pack. */
  amountUsd?: number;
  /** Optional echo of the pack credits; rejected when it disagrees with the pack. */
  credits?: number;
  /**
   * Client-supplied idempotency key (for example an external payment id).
   * When omitted a unique reference is generated so repeated purchases still
   * accumulate. Replaying the same reference is rejected with 409.
   */
  referenceId?: string | null;
}

export interface TopUpResult {
  developer_id: string;
  previous_balance: number;
  added_credits: number;
  new_balance: number;
  transaction_id: string;
}

export interface BillingService {
  getTiers(): Promise<Tier[]>;
  topUpCredits(request: TopUpRequest): Promise<TopUpResult>;
}

export function createBillingService(store: ServiceStore): BillingService {
  return {
    async getTiers(): Promise<Tier[]> {
      return store.withSnapshot((reader) => reader.findAllTiers());
    },

    async topUpCredits(request: TopUpRequest): Promise<TopUpResult> {
      const pack = getCreditPack(request.packId);
      if (!pack) {
        throw new HttpError(400, 'INVALID_PACK', `Unknown credit pack: ${request.packId}`);
      }

      assertPackAmount(request.amountUsd, pack.amountUsd, 'amount_usd');
      assertPackCredits(request.credits, pack.credits);

      const user = await store.withSnapshot((reader) => reader.findUserById(request.userId));
      if (!user) {
        throw new HttpError(404, 'NOT_FOUND', 'Developer not found');
      }

      const referenceId = resolveReferenceId(request.referenceId, pack.id);
      const mutation = await store.applyCreditTransaction(
        request.userId,
        pack.credits,
        'topup',
        referenceId
      );

      return {
        developer_id: request.userId,
        previous_balance: mutation.previousBalance,
        added_credits: pack.credits,
        new_balance: mutation.newBalance,
        transaction_id: mutation.transaction.id,
      };
    },
  };
}

function assertPackAmount(amountUsd: number | undefined, expected: number, field: string): void {
  if (amountUsd === undefined) return;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new HttpError(400, 'INVALID_AMOUNT', `${field} must be a positive number`);
  }
  if (amountUsd !== expected) {
    throw new HttpError(400, 'INVALID_AMOUNT', `${field} must be ${expected} for this pack`);
  }
}

function assertPackCredits(credits: number | undefined, expected: number): void {
  if (credits === undefined) return;
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new HttpError(400, 'INVALID_CREDITS', 'credits must be a positive integer');
  }
  if (credits !== expected) {
    throw new HttpError(400, 'INVALID_CREDITS', `credits must be ${expected} for this pack`);
  }
}

function resolveReferenceId(referenceId: string | null | undefined, packId: string): string {
  const trimmed = referenceId?.trim();
  if (trimmed) return trimmed;
  return `${packId}:${randomUUID()}`;
}
