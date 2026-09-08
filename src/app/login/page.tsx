import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/session";
import { needsSetup } from "@/server/auth/bootstrap";
import { AuthForm } from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await needsSetup()) redirect("/setup");
  if (await currentUser()) redirect("/");
  return <AuthForm mode="login" />;
}
