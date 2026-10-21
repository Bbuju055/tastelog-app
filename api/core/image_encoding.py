"""
Tastelog: Image encoding utilities.
Pure functions - no global state, no environment access, no module-level config.
"""

import base64
import io
from pathlib import Path
from tempfile import TemporaryDirectory

import filetype
from pdf2image import convert_from_path, pdfinfo_from_path
from PIL import Image

from api.core.exceptions import ImageProcessingError


def encode_image(
    image_path: str,
    *,
    max_size: int,
    pdf_dpi: int,
    jpeg_quality: int,
) -> tuple[str, str]:
    """Read image or PDF and return base64 + media type.

    Args:
        image_path: Path to image or PDF file
        max_size: Maximum dimension for resizing (e.g., 1568 for Claude Vision)
        pdf_dpi: DPI for PDF rasterization (>=50)
        jpeg_quality: JPEG/WEBP quality (1-100)

    Returns:
        Tuple of (base64_data, media_type)

    Raises:
        ImageProcessingError: If image cannot be processed or type unsupported
    """
    # Validate arguments
    if max_size < 1:
        raise ImageProcessingError(
            f"max_size must be >= 1, got {max_size}", code="INVALID_ARGUMENT"
        )
    if pdf_dpi < 50:
        raise ImageProcessingError(
            f"pdf_dpi must be >= 50, got {pdf_dpi}", code="INVALID_ARGUMENT"
        )
    if not 1 <= jpeg_quality <= 100:
        raise ImageProcessingError(
            f"jpeg_quality must be 1-100, got {jpeg_quality}", code="INVALID_ARGUMENT"
        )

    path = Path(image_path)

    if not path.exists():
        raise ImageProcessingError(
            f"File not found: {path.name}", code="FILE_NOT_FOUND"
        )

    kind = filetype.guess(str(path))

    if kind is not None and kind.mime == "application/pdf":
        return _encode_pdf(
            path, max_size=max_size, pdf_dpi=pdf_dpi, jpeg_quality=jpeg_quality
        )

    return _encode_image(
        path, kind=kind, max_size=max_size, jpeg_quality=jpeg_quality
    )


def _encode_pdf(
    path: Path,
    *,
    max_size: int,
    pdf_dpi: int,
    jpeg_quality: int,
) -> tuple[str, str]:
    """Encode a verified single-page PDF; never silently discard later pages."""
    try:
        pages = pdfinfo_from_path(str(path), timeout=15).get("Pages")
        if type(pages) is not int or pages < 1:
            raise ValueError("Invalid PDF page count")
    except Exception as e:
        raise ImageProcessingError(
            "Could not verify PDF page count", code="PDF_PAGE_COUNT_FAILED"
        ) from e
    if pages != 1:
        raise ImageProcessingError(
            "Only single-page PDFs are supported", code="PDF_MULTIPAGE_UNSUPPORTED"
        )
    with TemporaryDirectory() as tmp_dir:
        try:
            images = convert_from_path(
                str(path),
                first_page=1,
                last_page=1,
                dpi=pdf_dpi,
                output_folder=tmp_dir,
                timeout=30,
            )
        except Exception as e:
            raise ImageProcessingError(
                f"Failed to convert PDF: {type(e).__name__}: {str(e)[:200]}",
                code="PDF_CONVERSION_FAILED",
            )

        if not images:
            raise ImageProcessingError(
                "Could not extract any pages from PDF", code="PDF_EMPTY"
            )

        img = images[0]
        try:
            if img.width > max_size or img.height > max_size:
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

            img_buffer = io.BytesIO()
            img.save(img_buffer, format="JPEG", quality=jpeg_quality)
            img_buffer.seek(0)
            data = base64.standard_b64encode(img_buffer.read()).decode("utf-8")
            return data, "image/jpeg"
        finally:
            img.close()


def _encode_image(
    path: Path,
    *,
    kind: filetype.Type | None,
    max_size: int,
    jpeg_quality: int,
) -> tuple[str, str]:
    """Encode regular image file with strict media type validation."""
    # Local config tables (not module-level)
    supported_types = {"image/jpeg", "image/png", "image/webp"}
    passthrough_types = {"image/gif"}
    pil_formats: dict[str, str] = {
        "image/jpeg": "JPEG",
        "image/png": "PNG",
        "image/webp": "WEBP",
    }
    extension_map: dict[str, str] = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }

    # Determine media type: detected MIME takes precedence over extension
    if kind is not None:
        media_type = kind.mime
    elif path.suffix:
        media_type = extension_map.get(path.suffix.lower())
        if media_type is None:
            raise ImageProcessingError(
                f"Unsupported file extension: {path.suffix}",
                code="UNSUPPORTED_MEDIA_TYPE",
            )
    else:
        raise ImageProcessingError(
            "Missing file extension and unable to detect type",
            code="UNSUPPORTED_MEDIA_TYPE",
        )

    # Passthrough (e.g., GIF): no resize, preserve animation
    if media_type in passthrough_types:
        with open(path, "rb") as f:
            data = base64.standard_b64encode(f.read()).decode("utf-8")
        return data, media_type

    # Validate supported type
    if media_type not in supported_types:
        raise ImageProcessingError(
            f"Unsupported media type: {media_type}", code="UNSUPPORTED_MEDIA_TYPE"
        )

    img_format = pil_formats[media_type]

    save_kwargs: dict[str, int | bool] = {}
    if img_format in {"JPEG", "WEBP"}:
        save_kwargs["quality"] = jpeg_quality
    if img_format == "PNG":
        save_kwargs["optimize"] = True

    try:
        with Image.open(path) as img:
            if img.width > max_size or img.height > max_size:
                resized = img.copy()
                try:
                    resized.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                    img_buffer = io.BytesIO()
                    resized.save(img_buffer, format=img_format, **save_kwargs)
                    img_buffer.seek(0)
                    data = base64.standard_b64encode(img_buffer.read()).decode("utf-8")
                    return data, media_type
                finally:
                    resized.close()
    except Exception as e:
        raise ImageProcessingError(
            f"Failed to process image: {type(e).__name__}: {str(e)[:200]}",
            code="IMAGE_PROCESSING_FAILED",
        )

    # No resize needed: use original file
    with open(path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")
    return data, media_type
