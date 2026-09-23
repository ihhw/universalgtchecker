import { PageHeader } from "@/components/panel";
import { ActivityFeed } from "@/components/activity-feed";
import { useChecker } from "@/state/checker";

export default function ActivityPage() {
  const { feed, feedConnected, clearFeed } = useChecker();
  return (
    <>
      <PageHeader title="Live activity" />
      <ActivityFeed
        title="All platforms"
        events={feed}
        connected={feedConnected}
        onClear={clearFeed}
        showPlatform
        listClassName="max-h-[calc(100dvh-340px)] min-h-[320px]"
      />
    </>
  );
}
