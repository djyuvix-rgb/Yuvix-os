import { redirect } from "next/navigation";
import { needsSetup } from "@/server/auth/bootstrap";
import { AuthForm } from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await needsSetup())) redirect("/login");
  return <AuthForm mode="setup" />;
}
