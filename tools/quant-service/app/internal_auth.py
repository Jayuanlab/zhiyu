"""Write credentials are server-only; loopback binding is enforced by the launcher."""
import hmac
import os


def authorized(authorization: str | None) -> bool:
    token = os.getenv("QUANT_INTERNAL_TOKEN", "")
    return bool(token) and hmac.compare_digest(authorization or "", f"Bearer {token}")
