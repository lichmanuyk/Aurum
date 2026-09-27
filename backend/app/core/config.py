"""Application configuration, sourced from environment variables (.env)."""
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Single source of truth for the running app's version — surfaced in the API
# title, in GET /api/settings as app_version (which the frontend reads to show
# it in Settings; it deliberately does NOT ride on the unauthenticated
# /api/health), and embedded in exported backups so an old file can be told
# apart from a current one.
APP_VERSION = "1.1.8"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="AURUM_", extra="ignore")

    # Postgres connection
    postgres_user: str = "aurum"
    postgres_password: str = "aurum"
    postgres_db: str = "aurum"
    postgres_host: str = "db"
    postgres_port: int = 5432

    # Default currency shown across the UI when an account doesn't override it
    default_currency: str = "USD"

    # Comma-separated list of browser origins allowed to call the API. Empty
    # by default, which allows none: the shipped compose serves the UI and the
    # API from one nginx, and the Vite dev server proxies /api, so neither is
    # a cross-origin caller. Set it only for a genuinely separate frontend.
    cors_origins: str = ""

    # CoinGecko Demo API key (free, no card required — https://www.coingecko.com/en/api/pricing)
    # for services/crypto_service.py's price lookups. Empty by default; the
    # Crypto tab's endpoints 400 with a clear message until this is set,
    # rather than silently hitting CoinGecko's much stingier keyless tier.
    coingecko_api_key: str = ""

    # Swagger/ReDoc/openapi.json at /api/docs. On by default because the API
    # is a documented feature of this app (see DOCS.md), and because when
    # basic auth is configured these sit behind it like everything else under
    # /api/. Turn it off on an instance that's reachable from the internet
    # *without* basic auth: an open /api/openapi.json is a complete,
    # machine-readable map of every endpoint and payload shape.
    enable_docs: bool = True

    # IANA zone every server-side "what day is it" financial rule uses (see
    # app/core/clock.py) — the app runs for one user in Poland, so this
    # deliberately does NOT follow the container's/database's own OS
    # timezone (almost always UTC in Docker), nor any browser's. Validated
    # below at Settings() construction time (app startup, and test import):
    # a typo or a non-existent zone fails loudly here rather than silently
    # falling back to UTC deep inside some unrelated request.
    business_timezone: str = "Europe/Warsaw"

    @field_validator("business_timezone")
    @classmethod
    def _validate_business_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(
                f"AURUM_BUSINESS_TIMEZONE={value!r} is not a known IANA timezone "
                "(e.g. 'Europe/Warsaw'); refusing to silently fall back to UTC"
            ) from exc
        return value

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origins_list(self) -> list[str]:
        if self.cors_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
