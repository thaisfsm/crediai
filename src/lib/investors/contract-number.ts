// Número do contrato gerado pelo sistema: ANO.MÊS.DIA-0001 (data de início do contrato + contador de 4 dígitos da carteira).
// O contador é único por carteira (não reinicia a cada dia), então o número nunca se repete.
export const GENERATED_CONTRACT_NUMBER = /^\d{4}\.\d{2}\.\d{2}-\d{4,}$/;

export function formatContractNumber(startDate: string, sequence: number) {
  const [year, month, day] = startDate.split("-");
  return `${year}.${month}.${day}-${String(sequence).padStart(4, "0")}`;
}

// Maior contador já usado nos números gerados (os digitados à mão, de outro formato, não contam).
export function nextContractSequence(existing: (string | null)[]) {
  const used = existing.flatMap((number) => (number && GENERATED_CONTRACT_NUMBER.test(number) ? [Number(number.slice(number.lastIndexOf("-") + 1))] : []));
  return Math.max(0, ...used) + 1;
}
