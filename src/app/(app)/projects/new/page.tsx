import type { Metadata } from "next";
import Link from "next/link";
import { requireSessionPage } from "@/server/auth/session";
import { PageHeader, PageScroll } from "@/ui/shell";
import { EMPTY_PROJECT, ProjectForm } from "../ProjectForm";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage() {
  await requireSessionPage("/projects/new");

  return (
    <PageScroll>
      <PageHeader
        eyebrow={<Link href="/projects" className="hover:underline">Projects</Link>}
        title="New project"
        description="Start with the name and what kind of work it is. Photos, documents and links to equipment, rooms and routes are added once it exists."
      />
      <ProjectForm initial={EMPTY_PROJECT} submitLabel="Create project" />
    </PageScroll>
  );
}
