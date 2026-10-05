import { redirect } from "next/navigation";
import { requireActiveAccount } from "@/lib/auth/guards";
import { databaseAvailable } from "@/lib/db";
import PasswordForm from "./password-form";

export const dynamic = "force-dynamic";

export default async function DefinePasswordPage() {
  if (!(await databaseAvailable())) redirect("/setup");
  const { session, state } = await requireActiveAccount({ allowTemporaryPassword: true });
  if (!state.mustChangePassword) redirect("/");
  return <PasswordForm email={session.user.email} />;
}
