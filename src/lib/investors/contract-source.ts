import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { TenantTransaction } from "@/lib/auth/guards";
import { investmentContractors, type investments, type investors } from "@/lib/db/schema";
import type { Address } from "./address";
import { contractFingerprint, type ContractorData, type ContractSource } from "./contract";
import { investorAddress, type InvestmentStatus, type PaymentFrequency, type RatePeriod, type RedemptionRule } from "./rules";

type ContractorRow = typeof investmentContractors.$inferSelect;

export function contractorData(row: ContractorRow | undefined | null): ContractorData | null {
  if (!row) return null;
  const address: Address = {
    Cep: row.addressCep, Street: row.addressStreet, Number: row.addressNumber, Complement: row.addressComplement,
    District: row.addressDistrict, City: row.addressCity, State: row.addressState,
  };
  return {
    legalName: row.legalName, document: row.document, address, representativeName: row.representativeName,
    representativeDocument: row.representativeDocument, confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

// Dados da empresa contratante do tenant do investimento (sempre o tenant do próprio investimento, nunca o do formulário).
export async function loadContractor(tx: TenantTransaction, tenantId: string) {
  const [row] = await tx.select().from(investmentContractors).where(eq(investmentContractors.tenantId, tenantId));
  return row ?? null;
}

export function contractSource(investment: typeof investments.$inferSelect, investor: typeof investors.$inferSelect, contractor: ContractorRow | null): ContractSource {
  return {
    contractor: contractorData(contractor),
    investor: { name: investor.name, document: investor.document, address: investorAddress(investor) },
    investment: {
      id: investment.id, amountCents: investment.amountCents, agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod as RatePeriod,
      startDate: investment.startDate, maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: investment.notes, status: investment.status as InvestmentStatus,
      paymentFrequency: investment.paymentFrequency as PaymentFrequency | null, yieldPaymentCents: investment.yieldPaymentCents,
      redemptionRule: investment.redemptionRule as RedemptionRule | null, redemptionDays: investment.redemptionDays,
    },
  };
}

export const contractDataHash = (source: ContractSource, includeNotes: boolean) => createHash("sha256").update(contractFingerprint(source, includeNotes)).digest("hex");
