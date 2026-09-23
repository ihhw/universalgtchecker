import { Link } from "wouter";
import { PageHeader, Panel } from "@/components/panel";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Panel>
        <p className="text-sm text-muted-foreground">This page does not exist.</p>
        <Link
          href="/xbox"
          className="mt-4 inline-block rounded-lg border border-border px-4 py-2.5 text-sm transition-colors hover:bg-secondary"
        >
          Back to Xbox
        </Link>
      </Panel>
    </>
  );
}
