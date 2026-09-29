import { redirect } from "next/navigation";
import Dashboard from "./dashboard";
import { databaseAvailable } from "@/lib/db";
import { getSession } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await databaseAvailable())) redirect("/setup");
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.user.active) redirect("/account-disabled");
  if (session.user.role === "SUPER_ADMIN") redirect("/admin");
  if (!session.user.tenantId) redirect("/account-disabled");
  return <Dashboard userName={session.user.name} />;
}
