import { useEffect, useState } from "react";
import { CloudOff } from "lucide-react";

export function OfflineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => { window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected); };
  }, []);
  if (online) return null;
  return <div className="offline-status" role="status"><CloudOff aria-hidden="true" /><span><strong>You are offline.</strong> New cloud work requires a connection. Interrupted uploads can resume when you reconnect; work already accepted by the server remains durable.</span></div>;
}
