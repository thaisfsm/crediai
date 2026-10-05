import { redirect } from "next/navigation";

// Não existe cadastro público: o endereço antigo de cadastro leva ao login.
export default function SignupPage() {
  redirect("/login");
}
