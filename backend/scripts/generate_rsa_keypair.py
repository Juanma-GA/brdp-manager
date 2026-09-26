"""One-off local setup: generate the RS256 keypair used to sign/verify JWTs
(docs/v2/03-especificacion-v2-para-claude-code.md §4.1). Run once per
environment:

    cd backend && python scripts/generate_rsa_keypair.py

Writes to the paths configured by JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH
(default: backend/keys/jwt_private.pem, backend/keys/jwt_public.pem) --
`keys/` is in backend/.gitignore, but this refuses to overwrite an existing
keypair regardless, since that would invalidate every issued token and log
every user out.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import get_settings


def main() -> None:
    settings = get_settings()
    private_path = Path(settings.jwt_private_key_path)
    public_path = Path(settings.jwt_public_key_path)

    for path in (private_path, public_path):
        if path.exists():
            print(f"Refusing to overwrite existing key: {path}", file=sys.stderr)
            print("Delete it yourself first if you really mean to rotate keys "
                  "(this invalidates every issued access token and refresh "
                  "token in the database).", file=sys.stderr)
            sys.exit(1)

    private_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.parent.mkdir(parents=True, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    private_path.write_bytes(private_pem)
    private_path.chmod(0o600)
    public_path.write_bytes(public_pem)

    print(f"Wrote private key: {private_path} (chmod 600)")
    print(f"Wrote public key:  {public_path}")


if __name__ == "__main__":
    main()
