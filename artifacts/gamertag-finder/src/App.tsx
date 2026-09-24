import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, Router as WouterRouter } from "wouter";
import { Toaster } from "sonner";
import { AppShell } from "@/components/app-shell";
import { CheckerProvider } from "@/state/checker";
import { DiscordCheckerProvider } from "@/state/discord-checker";
import HomePage from "@/pages/home";
import DiagnosticsPage from "@/pages/diagnostics";
import XboxPage from "@/pages/xbox";
import SniperPage from "@/pages/sniper";
import DiscordPage from "@/pages/discord";
import HitsPage from "@/pages/hits";
import ActivityPage from "@/pages/activity";
import StatusPage from "@/pages/status";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";

// Recharts is a heavy dependency used only here, so it's kept out of the
// main bundle and fetched on demand when the page is actually visited.
const AnalyticsPage = lazy(() => import("@/pages/analytics"));

const queryClient = new QueryClient();

function Routes() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/xbox" component={XboxPage} />
      <Route path="/xbox/sniper" component={SniperPage} />
      <Route path="/discord" component={DiscordPage} />
      <Route path="/hits" component={HitsPage} />
      <Route path="/analytics">
        <Suspense fallback={<p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}>
          <AnalyticsPage />
        </Suspense>
      </Route>
      <Route path="/activity" component={ActivityPage} />
      <Route path="/status" component={StatusPage} />
      <Route path="/diagnostics" component={DiagnosticsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <CheckerProvider>
          <DiscordCheckerProvider>
            <AppShell>
              <Routes />
            </AppShell>
          </DiscordCheckerProvider>
        </CheckerProvider>
      </WouterRouter>
      <Toaster
        theme="light"
        position="bottom-right"
        toastOptions={{
          className: "rounded-xl border-border bg-card text-foreground",
        }}
      />
    </QueryClientProvider>
  );
}
