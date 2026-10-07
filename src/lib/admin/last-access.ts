import { daysBetween, formatDate, TIME_ZONE, todayIso } from "@/lib/finance/format";

// Regra única do "Último acesso" (Clientes SaaS, detalhe do cliente, lista de usuários e Registros).
// Último acesso = o mais recente entre:
//  • o último login (user.last_login_at, gravado a cada sessão criada; continua existindo depois do "Sair");
//  • a última atividade de uma sessão ainda guardada (session.updated_at, renovada pelo Better Auth quando a sessão
//    é usada depois de 1 dia; session.created_at para sessões nunca renovadas).
// Assim, quem continua usando uma sessão aberta há dias aparece com o acesso real, e não com a data do login.
type Moment = string | Date | null | undefined;

const toTime = (value: Moment) => {
  if (!value) return null;
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? null : time;
};

export function lastAccessOf(lastLoginAt: Moment, lastSessionActivityAt: Moment): string | null {
  const times = [toTime(lastLoginAt), toTime(lastSessionActivityAt)].filter((time): time is number => time !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

// Texto do último acesso, por dia de calendário em Brasília (acessar às 23h de ontem é "Ontem", não "Hoje").
export function relativeAccessLabel(value: string | null, now = new Date()) {
  if (!value) return "Nunca acessou";
  const accessed = new Date(value);
  const days = daysBetween(todayIso(accessed), todayIso(now));
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(accessed);
  if (days <= 0) return `Hoje às ${time}`;
  if (days === 1) return `Ontem às ${time}`;
  if (days < 30) return `Há ${days} dias (${formatDate(todayIso(accessed))})`;
  return formatDate(todayIso(accessed));
}
