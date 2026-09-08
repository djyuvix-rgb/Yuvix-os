import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/session";
import { needsSetup } from "@/server/auth/bootstrap";
import { Shell } from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (await needsSetup()) redirect("/setup");
  const user = await currentUser();
  if (!user) redirect("/login");
  return <Shell userName={user.name ?? user.email} />;
}
