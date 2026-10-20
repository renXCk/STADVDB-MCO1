import os
import re
from pathlib import Path


def load_env_file():
    """Load project-root .env values without overriding existing environment variables."""
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return

    with env_path.open(encoding="utf-8") as env_file:
        for line_number, line in enumerate(env_file, 1):
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            if text.startswith("export "):
                text = text[7:].lstrip()

            key, separator, value = text.partition("=")
            key = key.strip()
            if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise ValueError("%s:%d: expected KEY=VALUE" % (env_path, line_number))

            value = value.strip()
            if value[:1] in ("'", '"'):
                if len(value) < 2 or value[-1] != value[0]:
                    raise ValueError("%s:%d: unmatched quote" % (env_path, line_number))
                value = value[1:-1]
            else:
                value = value.split(" #", 1)[0].rstrip()

            os.environ.setdefault(key, value)
