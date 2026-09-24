import { Link } from "react-router-dom";
import { useTranslation } from "@/lib/i18n";
export function MoneyError({ error }: { error: Error | null }) {
  const { language } = useTranslation();
  if (!error) return null;
  return <div role="alert" className="rounded-lg border border-danger/30 p-3 text-sm text-danger">
    <p>{error.message}</p><Link to="/settings">{language === "ru" ? "Проверить курсы и настройки" : "Check exchange rates and settings"}</Link>
  </div>;
}
