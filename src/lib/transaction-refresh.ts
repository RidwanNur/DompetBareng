import { createClient } from "@/lib/supabase/client";

export const transactionRefreshChannel = "dompetbareng-transactions";

type Client = ReturnType<typeof createClient>;
type WorkspaceSubscription = {
  listeners: Set<() => void>;
  close: () => void;
};

const subscriptions = new Map<string, WorkspaceSubscription>();
const closingChannels = new Map<string, Promise<void>>();

function openWorkspaceSubscription(topic: string): WorkspaceSubscription {
  const listeners = new Set<() => void>();
  let client: Client | undefined;
  let channel: ReturnType<Client["channel"]> | undefined;
  let refreshTimer: number | undefined;
  let closed = false;

  function notify() {
    if (closed || refreshTimer !== undefined) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      listeners.forEach((listener) => listener());
    }, 50);
  }

  void (async () => {
    try {
      await closingChannels.get(topic);
      if (closed) return;

      client = createClient();
      const { data, error } = await client.auth.getSession();
      if (closed || error || !data.session) return;
      await client.realtime.setAuth();
      if (closed) return;

      channel = client.channel(topic, { config: { private: true } })
        .on("broadcast", { event: "changed" }, notify);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") notify();
      });
    } catch {
      // Existing refresh actions cover a temporarily unavailable connection.
    }
  })();

  return {
    listeners,
    close() {
      closed = true;
      window.clearTimeout(refreshTimer);
      if (!client || !channel) return;

      const closing = client.removeChannel(channel).then(() => undefined, () => undefined);
      closingChannels.set(topic, closing);
      void closing.then(() => {
        if (closingChannels.get(topic) === closing) closingChannels.delete(topic);
      });
    },
  };
}

export function subscribeToWorkspaceRefresh(workspaceId: string | null | undefined, onChange: () => void) {
  const endpoint = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (
    !workspaceId || typeof window === "undefined" ||
    !endpoint?.trim().startsWith("https://") || typeof WebSocket !== "function"
  ) {
    return () => {};
  }

  const topic = `workspace:${workspaceId}`;
  const subscription = subscriptions.get(topic) ?? openWorkspaceSubscription(topic);
  subscriptions.set(topic, subscription);
  const listener = () => onChange();
  subscription.listeners.add(listener);

  return () => {
    subscription.listeners.delete(listener);
    if (subscription.listeners.size === 0 && subscriptions.get(topic) === subscription) {
      subscriptions.delete(topic);
      subscription.close();
    }
  };
}

export function signalTransactionRefresh() {
  if (typeof BroadcastChannel !== "function") return;
  try {
    const channel = new BroadcastChannel(transactionRefreshChannel);
    channel.postMessage("changed");
    channel.close();
  } catch {
    // Beranda tetap menyegarkan data saat dibuka kembali.
  }
}
