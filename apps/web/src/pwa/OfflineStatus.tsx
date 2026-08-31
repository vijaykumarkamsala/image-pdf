import { useEffect, useState } from "react";
import { ChevronDown, CloudOff, Minimize2 } from "lucide-react";

import { IconButton } from "../design-system";

export function OfflineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const connected = () => { setOnline(true); setCollapsed(false); };
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => { window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected); };
  }, []);
  if (online) return null;
  if (collapsed) return <div className="offline-indicator" role="status"><CloudOff aria-hidden="true" /><strong>Offline</strong><IconButton label="Show offline details" onClick={() => setCollapsed(false)}><ChevronDown aria-hidden="true" /></IconButton></div>;
  return <div className="offline-status" role="status"><CloudOff aria-hidden="true" /><span><strong>You are offline.</strong> New uploads and online processing require a connection. Interrupted uploads can resume when you reconnect; work already accepted by the server remains durable.</span><IconButton label="Collapse offline message" onClick={() => setCollapsed(true)}><Minimize2 aria-hidden="true" /></IconButton></div>;
}
