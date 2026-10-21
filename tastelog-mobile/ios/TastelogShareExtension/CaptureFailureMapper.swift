//
//  CaptureFailureMapper.swift
//  TastelogShareExtension
//
//  15.3.S-CF1a: maps capture-endpoint failures to truthful user copy.
//
//  Contract (mirrors lib/captureErrorMessage.ts, the proven JS mapper):
//  the server's stable machine-readable `detail.code` (PROVIDER-S1 wire
//  contract, api/routes/drafts.py) selects client-owned fixed copy; the
//  server `message` text is never displayed. Responses without a
//  recognized code fall back to status-class copy, and a codeless 422
//  never blames the user's content.
//
//  Foundation-only on purpose: the standalone contract harness
//  (scripts/CaptureFailureMapperContract.swift) compiles and executes
//  this exact source with swiftc, outside the application targets.
//

import Foundation

/// What the user actually shared, decided before upload.
enum CaptureShareInputType {
    case image
    case document
    case url
    case unknown
}

enum CaptureFailureMapper {

    private static let providerCopy: [String: String] = [
        "RECIPE_PROVIDER_UNAVAILABLE": "Recipe capture is temporarily unavailable. Try again in a few minutes.",
        "RECIPE_PROVIDER_RATE_LIMITED": "Recipe capture is temporarily unavailable. Try again in a few minutes.",
        "RECIPE_PROVIDER_TIMEOUT": "Recipe capture timed out. Try again in a moment.",
        "RECIPE_PROVIDER_BAD_RESPONSE": "Recipe capture hit a server problem. Try again in a moment.",
    ]

    static func message(
        statusCode: Int,
        body: Data?,
        inputType: CaptureShareInputType
    ) -> String {
        if let code = stableErrorCode(from: body) {
            if code == "RECIPE_INCOMPLETE" { return "No recipe was saved. The capture is missing ingredients or instructions. Open Tastelog to capture and review the complete source." }
            if code == "PDF_MULTIPAGE_UNSUPPORTED" { return "Multi-page PDFs aren't supported yet. No recipe was saved. Use the recipe's source URL instead." }
            if code == "PDF_PAGE_COUNT_FAILED" { return "We couldn't verify this PDF's page count. No recipe was saved. Use an unencrypted single-page PDF or the recipe's source URL instead." }

            if code == "RECIPE_UNREADABLE" {
                switch inputType {
                case .image:
                    return "Couldn\u{2019}t read a recipe from this image. Try a clearer photo."
                case .document:
                    return "Couldn\u{2019}t read a recipe from this file. Try a clearer copy or a photo instead."
                case .url:
                    return "Couldn\u{2019}t find a recipe on this page."
                case .unknown:
                    return "Couldn\u{2019}t find a recipe in what was shared."
                }
            }
            if let copy = providerCopy[code] {
                return copy
            }
            // Unknown code: fall through to the status-class fallback.
        }
        return statusFallbackMessage(statusCode: statusCode, inputType: inputType)
    }

    /// Extracts `detail.code` when the body is the structured capture error
    /// shape `{"detail": {"code": "..."}}`. Anything else (plain-string
    /// detail, arrays, HTML, empty, malformed JSON, absent code) returns nil.
    static func stableErrorCode(from body: Data?) -> String? {
        guard let body, !body.isEmpty else { return nil }
        guard let parsed = try? JSONSerialization.jsonObject(with: body) else { return nil }
        guard let root = parsed as? [String: Any] else { return nil }
        guard let detail = root["detail"] as? [String: Any] else { return nil }
        guard let code = detail["code"] as? String, !code.isEmpty else { return nil }
        return code
    }

    private static func statusFallbackMessage(
        statusCode: Int,
        inputType: CaptureShareInputType
    ) -> String {
        switch statusCode {
        case 401:
            return "Your sharing session has expired. Open Tastelog, sign in, and try again."
        case 409:
            return "This recipe is already in Tastelog, saved or waiting in Drafts. Open Tastelog to review."
        case 413:
            return "Images are too large. Try smaller images or fewer pages."
        case 422:
            // No stable code: never blame the user's content.
            return "Couldn\u{2019}t save a recipe from what was shared. Try again."
        case 429:
            return "Too many captures. Wait and try again later."
        case 502 where inputType == .url:
            return "Couldn\u{2019}t load the recipe page. Try again."
        case 500...599:
            return "Tastelog is having trouble right now. Try again in a moment."
        default:
            return "Upload failed (\(statusCode)). Try again."
        }
    }
}
