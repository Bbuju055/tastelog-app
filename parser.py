"""
Tastelog: Recipe parser CLI wrapper.
Thin wrapper around api.core.parser for command-line usage.
"""

import json
import logging
import sys

import anthropic

from api.core.config import get_settings
from api.core.exceptions import TastelogError
from api.core.parser import get_default_config, parse_recipe_image


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python parser.py <image_path>", file=sys.stderr)
        print("Example: python parser.py test_recipe.jpg", file=sys.stderr)
        return 2

    image_path = sys.argv[1]

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("tastelog.cli.parser")

    try:
        settings = get_settings()
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        config = get_default_config()

        result = parse_recipe_image(
            image_path,
            client=client,
            config=config,
            logger=logger,
        )
        print(json.dumps(result, indent=2))
        return 0

    except TastelogError as e:
        logger.error(f"{e.code}: {e}" if e.code else str(e))
        return 1
    except Exception as e:
        logger.exception("Unhandled error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
