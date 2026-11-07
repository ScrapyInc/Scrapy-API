export interface User {
  id: string;
  email: string;
  passwordHash: string;
  refreshTokenHash: string | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKey {
  id: string;
  userId: string;
  keyId: string;
  keyType: 'live' | 'test';
  keyLast4: string;
  keyHash: string;
  isActive: boolean;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  allowedIps: string[] | null;
  allowedOrigins: string[] | null;
  restrictionMode: 'none' | 'ip' | 'origin' | 'both';
}

export interface Tier {
  id: string;
  name: string;
  dailySearchCap: number | null;
  monthlySearchCap: number | null;
  creditPerSearch: number;
  creditPerBatchQuery: number;
  createdAt: Date;
}

export interface CreditBalance {
  userId: string;
  balance: number;
  updatedAt: Date;
}

export type CreditTransactionReason = 'topup' | 'x402_topup' | 'api_call';

export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number;
  reason: CreditTransactionReason;
  referenceId: string | null;
  createdAt: Date;
}

export interface CreditMutationResult {
  transaction: CreditTransaction;
  previousBalance: number;
  newBalance: number;
}

export interface ServiceReader {
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserByRefreshTokenHash(refreshTokenHash: string): Promise<User | null>;
  findApiKeyByKeyId(keyId: string): Promise<ApiKey | null>;
  findApiKeysByUserId(userId: string): Promise<ApiKey[]>;
  findAllTiers(): Promise<Tier[]>;
  findTierById(id: string): Promise<Tier | null>;
  findCreditBalanceByUserId(userId: string): Promise<CreditBalance | null>;
  getCreditBalance(userId: string): Promise<CreditBalance | null>;
  createCreditBalance(userId: string): Promise<CreditBalance>;
  addCreditTransaction(
    userId: string,
    amount: number,
    reason: CreditTransactionReason,
    referenceId: string | null
  ): Promise<CreditTransaction>;
  findCreditTransactionsByUserId(userId: string, limit: number): Promise<CreditTransaction[]>;
  findCreditTransactionsByUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<CreditTransaction[]>;
}

export interface ServiceStore {
  withSnapshot<T>(fn: (reader: ServiceReader) => Promise<T>): Promise<T>;
  createUser(email: string, passwordHash: string): Promise<User>;
  createApiKey(
    userId: string,
    keyId: string,
    keyType: 'live' | 'test',
    keyLast4: string,
    keyHash: string,
    expiresAt: Date | null
  ): Promise<ApiKey>;
  revokeApiKey(keyId: string): Promise<void>;
  updateRefreshToken(userId: string, refreshTokenHash: string, expiresAt: Date): Promise<void>;
  createCreditTransaction(
    userId: string,
    amount: number,
    reason: CreditTransactionReason,
    referenceId: string | null
  ): Promise<CreditTransaction>;
  updateCreditBalance(userId: string, amount: number): Promise<CreditBalance>;
  applyCreditTransaction(
    userId: string,
    amount: number,
    reason: CreditTransactionReason,
    referenceId: string | null
  ): Promise<CreditMutationResult>;
}