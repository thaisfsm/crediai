import AuthForm from "../auth-form";
import { databaseAvailable } from "@/lib/db";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await databaseAvailable())) redirect("/setup");
  if (await getSession()) redirect("/");
  return <AuthForm />;
}
