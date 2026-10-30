// Alerta do painel da gerente: o máximo de principal da carteira deixa menos espaço do que o caixa combinado ainda disponível.
// Sem máximo definido (null) não há alerta. Só apresentação: não muda nenhuma regra de caixa ou de limite.
export function portfolioLimitBlocksCash(roomAvailableCents: number | null, cashAvailableCents: number): boolean {
  return roomAvailableCents !== null && roomAvailableCents < cashAvailableCents;
}
