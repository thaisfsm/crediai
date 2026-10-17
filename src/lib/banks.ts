// Bancos mais usados no Brasil (código de compensação + nome) para sugerir no campo Banco. É só sugestão: o campo continua
// livre, e o valor gravado é o texto escolhido ou digitado (ex.: "341 - Itaú Unibanco").
export const BANKS: ReadonlyArray<readonly [string, string]> = [
  ["001", "Banco do Brasil"], ["003", "Banco da Amazônia"], ["004", "Banco do Nordeste"], ["007", "BNDES"], ["010", "Credicoamo"],
  ["033", "Santander"], ["037", "Banpará"], ["041", "Banrisul"], ["047", "Banese"], ["070", "BRB"], ["077", "Banco Inter"],
  ["082", "Banco Topázio"], ["084", "Uniprime"], ["085", "Ailos"], ["091", "Unicred Central RS"], ["097", "Credisis"],
  ["099", "Uniprime Central"], ["104", "Caixa Econômica Federal"], ["114", "Central Cooperativa Cecoop"], ["120", "Banco Rodobens"],
  ["121", "Agibank"], ["133", "Cresol Confederação"], ["136", "Unicred"], ["208", "BTG Pactual"], ["212", "Banco Original"],
  ["213", "Banco Arbi"], ["218", "Banco BS2"], ["224", "Banco Fibra"], ["237", "Bradesco"], ["241", "Banco Clássico"],
  ["246", "Banco ABC Brasil"], ["260", "Nubank"], ["269", "HSBC"], ["290", "PagBank (PagSeguro)"], ["318", "Banco BMG"],
  ["323", "Mercado Pago"], ["336", "C6 Bank"], ["341", "Itaú Unibanco"], ["348", "Banco XP"], ["349", "Banco Fator"],
  ["356", "Banco Real"], ["364", "Gerencianet (Efí)"], ["380", "PicPay"], ["382", "Banco Fidis"], ["389", "Banco Mercantil do Brasil"],
  ["399", "HSBC Brasil"], ["403", "Cora"], ["412", "Banco Capital"], ["422", "Banco Safra"], ["451", "Banco Neon"],
  ["453", "Banco Rural"], ["456", "Banco MUFG"], ["457", "Banco UY3"], ["461", "Asaas"], ["473", "Banco Caixa Geral"],
  ["505", "Credit Suisse"], ["623", "Banco Pan"], ["633", "Banco Rendimento"], ["637", "Banco Sofisa"], ["643", "Banco Pine"],
  ["654", "Banco Digimais"], ["655", "Banco Votorantim"], ["707", "Banco Daycoval"], ["739", "Banco Cetelem"], ["741", "Banco Ribeirão Preto"],
  ["743", "Banco Semear"], ["745", "Citibank"], ["746", "Banco Modal"], ["748", "Sicredi"], ["751", "Scotiabank"],
  ["752", "BNP Paribas"], ["755", "Bank of America"], ["756", "Sicoob"], ["757", "Banco KEB Hana"],
];

export const bankOptionLabel = ([code, name]: readonly [string, string]) => `${code} - ${name}`;
