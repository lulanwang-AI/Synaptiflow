"""Export the OpenAPI schema to docs/openapi.json for the frontend session.

Usage: python export_openapi.py
"""
import json
from pathlib import Path

from app.main import app

OUT = Path(__file__).resolve().parents[1] / "docs" / "openapi.json"


def main() -> None:
    schema = app.openapi()
    OUT.write_text(json.dumps(schema, indent=2) + "\n")
    print(f"Wrote {OUT} ({len(schema.get('paths', {}))} paths)")


if __name__ == "__main__":
    main()
