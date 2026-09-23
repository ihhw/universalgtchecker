import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Switch, Router as WouterRouter } from "wouter";
import { Toaster } from "sonner";
import { AppShell } from "@/components/app-shell";
import { CheckerProvider } from "@/state/checker";
import XboxPage from "@/pages/xbox";
import HitsPage from "@/pages/hits";
import ActivityPage from "@/pages/activity";
import StatusPage from "@/pages/status";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Routes() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/xbox" />
      </Route>
      <Route path="/xbox" component={XboxPage} />
      <Route path="/hits" component={HitsPage} />
      <Route path="/activity" component={ActivityPage} />
      <Route path="/status" component={StatusPage} />
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
          <AppShell>
            <Routes />
          </AppShell>
        </CheckerProvider>
      </WouterRouter>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          className: "rounded-xl border-border bg-card text-foreground",
        }}
      />
    </QueryClientProvider>
  );
}
