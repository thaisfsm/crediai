import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonthsAnchored, commercialState, nextDueAfterPayment, shouldSuspend, validateTerms } from "../src/lib/billing/rules.ts";

const active = (nextDueDate, extra = {}) => ({ isPlatformOwner: false, tenantStatus: "ACTIVE", subscriptionStatus: "ACTIVE", trialEndsAt: null, nextDueDate, graceDays: 5, ...extra });
const now = new Date("2026-10-06T15:00:00Z");

test("vencimento mensal mantém o dia escolhido", () => {
  assert.equal(addMonthsAnchored("2026-10-06", 1), "2026-11-06");
  assert.equal(addMonthsAnchored("2026-01-31", 1), "2026-02-28");
  assert.equal(nextDueAfterPayment("2026-02-28", "2026-01-31"), "2026-03-31");
  assert.equal(nextDueAfterPayment("2026-12-15", "2026-10-15"), "2027-01-15");
  assert.equal(addMonthsAnchored("2028-01-30", 1), "2028-02-29");
});

test("em dia, vencido na tolerância e tolerância esgotada", () => {
  assert.deepEqual(commercialState(active("2026-11-06"), "2026-10-06", now), { status: "ACTIVE", daysToDue: 31, daysOverdue: null, graceEndsOn: "2026-11-11" });
  assert.equal(commercialState(active("2026-10-06"), "2026-10-06", now).status, "ACTIVE", "no dia do vencimento ainda está em dia");
  for (let day = 1; day <= 5; day++) {
    const state = commercialState(active("2026-10-01"), `2026-10-0${1 + day}`, now);
    assert.equal(state.status, "PAST_DUE", `dia ${day} após o vencimento: Vencido com acesso`);
    assert.equal(state.daysOverdue, day);
    assert.equal(shouldSuspend(state), false);
  }
  const late = commercialState(active("2026-10-01"), "2026-10-07", now);
  assert.equal(late.status, "SUSPENSION_DUE");
  assert.equal(late.daysOverdue, 6);
  assert.equal(shouldSuspend(late), true);
  assert.equal(commercialState(active("2026-10-01", { graceDays: 0 }), "2026-10-02", now).status, "SUSPENSION_DUE");
});

test("teste, cortesia, suspenso, encerrado e conta da administração", () => {
  assert.equal(commercialState({ ...active(null), tenantStatus: "TRIALING", subscriptionStatus: "TRIALING", trialEndsAt: "2026-10-14T16:25:00Z" }, "2026-10-06", now).status, "TRIALING");
  assert.equal(commercialState({ ...active(null), tenantStatus: "TRIALING", subscriptionStatus: "TRIALING", trialEndsAt: "2026-10-01T00:00:00Z" }, "2026-10-06", now).status, "TRIAL_EXPIRED");
  assert.equal(commercialState(active(null), "2030-01-01", now).status, "ACTIVE", "cortesia não vence");
  assert.equal(commercialState(active("2026-01-01", { tenantStatus: "SUSPENDED" }), "2026-10-06", now).status, "SUSPENDED");
  assert.equal(commercialState(active(null, { tenantStatus: "CLOSED" }), "2026-10-06", now).status, "CLOSED");
  assert.equal(commercialState({ ...active(null), isPlatformOwner: true, tenantStatus: "TRIALING", subscriptionStatus: "TRIALING", trialEndsAt: "2026-10-01T00:00:00Z" }, "2026-10-06", now).status, "OWNER");
});

test("valor contratado e condição comercial", () => {
  const base = { standardCents: 15000, activatedAt: "2026-10-06", firstDueDate: "2026-11-06", graceDays: 5 };
  assert.equal(validateTerms({ ...base, condition: "STANDARD", contractedCents: 15000 }), null);
  assert.match(validateTerms({ ...base, condition: "STANDARD", contractedCents: 10000 }), /Personalizada/);
  assert.equal(validateTerms({ ...base, condition: "CUSTOM", contractedCents: 10000 }), null, "desconto");
  assert.equal(validateTerms({ ...base, condition: "CUSTOM", contractedCents: 19900 }), null, "maior que o padrão");
  assert.match(validateTerms({ ...base, condition: "CUSTOM", contractedCents: 0 }), /Cortesia/);
  assert.equal(validateTerms({ ...base, condition: "COURTESY", contractedCents: 0, firstDueDate: null }), null);
  assert.match(validateTerms({ ...base, condition: "COURTESY", contractedCents: 100 }), /R\$ 0,00/);
  assert.match(validateTerms({ ...base, condition: "CUSTOM", contractedCents: 10000, firstDueDate: "2026-10-01" }), /antes da ativação/);
  assert.match(validateTerms({ ...base, condition: "CUSTOM", contractedCents: 10000, firstDueDate: "" }), /primeiro vencimento/);
  assert.match(validateTerms({ ...base, condition: "STANDARD", contractedCents: 0, standardCents: 0 }), /preço padrão/);
  assert.match(validateTerms({ ...base, condition: "CUSTOM", contractedCents: 10000, graceDays: 90 }), /tolerância/);
  assert.match(validateTerms({ ...base, condition: "CUSTOM", contractedCents: -1 }), /válido/);
});
