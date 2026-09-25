import { useLocation } from "react-router-dom";
import { useCryptoHoldings } from "@/hooks/useCrypto";

// The Crypto page already observes holdings. On every other screen, keep one
// active hourly check so its valuations stay current throughout the open app.
export function AutoCryptoRefresh() {
  const { pathname } = useLocation();
  useCryptoHoldings(null, pathname !== "/crypto");
  return null;
}
