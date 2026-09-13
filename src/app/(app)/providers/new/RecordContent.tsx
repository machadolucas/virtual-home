import { requireSessionPage } from "@/server/auth/session";
import { ProviderForm } from "@/features/providers/ProviderForm";
import { Panel } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
export const metadata = { title: "Add provider" };
export default async function NewProviderPage() { await requireSessionPage("/providers/new"); return <PageScroll><PageHeader title="Add provider" description="A name is enough to get started. Add contact details when you have them." /><Panel><ProviderForm /></Panel></PageScroll>; }
