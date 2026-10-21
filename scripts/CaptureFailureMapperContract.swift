//
//  CaptureFailureMapperContract.swift
//
//  15.3.S-CF1a deterministic contract harness for the share extension's
//  CaptureFailureMapper. Executes the REAL mapper source (not a copy):
//
//    swiftc -parse-as-library \
//      tastelog-mobile/ios/TastelogShareExtension/CaptureFailureMapper.swift \
//      scripts/CaptureFailureMapperContract.swift \
//      -o /tmp/capture_mapper_contract && /tmp/capture_mapper_contract
//
//  Exits non-zero on any assertion failure. Not part of any Xcode target.
//

import Foundation

@main
struct CaptureFailureMapperContract {
    static var checks = 0
    static var failures = 0

    static func expect(
        status: Int,
        body: String?,
        input: CaptureShareInputType,
        toBe expected: String,
        _ label: String
    ) {
        checks += 1
        let data = body.map { Data($0.utf8) }
        let actual = CaptureFailureMapper.message(
            statusCode: status, body: data, inputType: input
        )
        if actual != expected {
            failures += 1
            print("FAIL \(label)\n  expected: \(expected)\n  actual:   \(actual)")
        }
    }

    static func expectNilBody(
        status: Int,
        input: CaptureShareInputType,
        toBe expected: String,
        _ label: String
    ) {
        checks += 1
        let actual = CaptureFailureMapper.message(
            statusCode: status, body: nil, inputType: input
        )
        if actual != expected {
            failures += 1
            print("FAIL \(label)\n  expected: \(expected)\n  actual:   \(actual)")
        }
    }

    static func main() {
        expect(status: 422, body: "{\"detail\":{\"code\":\"RECIPE_INCOMPLETE\"}}", input: .document, toBe: "No recipe was saved. The capture is missing ingredients or instructions. Open Tastelog to capture and review the complete source.", "incomplete recipe")
        expect(status: 422, body: "{\"detail\": {\"code\": \"PDF_MULTIPAGE_UNSUPPORTED\"}}", input: .document, toBe: "Multi-page PDFs aren't supported yet. No recipe was saved. Use the recipe's source URL instead.", "PDF_MULTIPAGE_UNSUPPORTED")
        expect(status: 422, body: "{\"detail\": {\"code\": \"PDF_PAGE_COUNT_FAILED\"}}", input: .document, toBe: "We couldn't verify this PDF's page count. No recipe was saved. Use an unencrypted single-page PDF or the recipe's source URL instead.", "PDF_PAGE_COUNT_FAILED")
        let unreadableImage = "Couldn\u{2019}t read a recipe from this image. Try a clearer photo."
        let unreadableDocument = "Couldn\u{2019}t read a recipe from this file. Try a clearer copy or a photo instead."
        let unreadableURL = "Couldn\u{2019}t find a recipe on this page."
        let unreadableUnknown = "Couldn\u{2019}t find a recipe in what was shared."
        let providerDown = "Recipe capture is temporarily unavailable. Try again in a few minutes."
        let providerTimeout = "Recipe capture timed out. Try again in a moment."
        let providerBad = "Recipe capture hit a server problem. Try again in a moment."
        let generic422 = "Couldn\u{2019}t save a recipe from what was shared. Try again."
        let sessionExpired = "Your sharing session has expired. Open Tastelog, sign in, and try again."
        let duplicate = "This recipe is already in Tastelog, saved or waiting in Drafts. Open Tastelog to review."
        let tooLarge = "Images are too large. Try smaller images or fewer pages."
        let rateLimited = "Too many captures. Wait and try again later."
        let pageFailed = "Couldn\u{2019}t load the recipe page. Try again."
        let serverTrouble = "Tastelog is having trouble right now. Try again in a moment."

        func codeBody(_ code: String) -> String {
            "{\"detail\":{\"code\":\"\(code)\",\"message\":\"server text, never displayed\"}}"
        }

        // Recognized code: RECIPE_UNREADABLE, distinguished by input type.
        expect(status: 422, body: codeBody("RECIPE_UNREADABLE"), input: .image,
               toBe: unreadableImage, "unreadable image")
        expect(status: 422, body: codeBody("RECIPE_UNREADABLE"), input: .url,
               toBe: unreadableURL, "unreadable url")
        expect(status: 422, body: codeBody("RECIPE_UNREADABLE"), input: .document,
               toBe: unreadableDocument, "unreadable pdf document")
        expect(status: 422, body: codeBody("RECIPE_UNREADABLE"), input: .unknown,
               toBe: unreadableUnknown, "unreadable unknown input")
        // Code wins even under an unexpected status.
        expect(status: 400, body: codeBody("RECIPE_UNREADABLE"), input: .image,
               toBe: unreadableImage, "unreadable code under 400")

        // Recognized provider codes: honest service copy, never photo blame.
        expect(status: 503, body: codeBody("RECIPE_PROVIDER_UNAVAILABLE"), input: .image,
               toBe: providerDown, "provider unavailable")
        expect(status: 503, body: codeBody("RECIPE_PROVIDER_RATE_LIMITED"), input: .url,
               toBe: providerDown, "provider rate limited")
        expect(status: 504, body: codeBody("RECIPE_PROVIDER_TIMEOUT"), input: .image,
               toBe: providerTimeout, "provider timeout")
        expect(status: 502, body: codeBody("RECIPE_PROVIDER_BAD_RESPONSE"), input: .url,
               toBe: providerBad, "provider bad response beats url 502 copy")

        // Unknown code: status-class fallback, non-blaming.
        expect(status: 422, body: codeBody("SOME_FUTURE_CODE"), input: .image,
               toBe: generic422, "unknown code 422")
        expect(status: 503, body: codeBody("SOME_FUTURE_CODE"), input: .image,
               toBe: serverTrouble, "unknown code 503")

        // Absent code / wrong shapes: status-class fallback.
        expect(status: 422, body: "{\"detail\":{\"message\":\"only text\"}}", input: .image,
               toBe: generic422, "code missing in dict")
        expect(status: 422, body: "{\"detail\":\"plain string detail\"}", input: .image,
               toBe: generic422, "plain-string detail 422 never blames photo")
        expect(status: 422, body: "{\"detail\":[{\"msg\":\"pydantic\"}]}", input: .image,
               toBe: generic422, "validation-list detail 422")
        expect(status: 422, body: "not json at all", input: .image,
               toBe: generic422, "malformed json 422")
        expect(status: 422, body: "", input: .image,
               toBe: generic422, "empty body 422")
        expectNilBody(status: 422, input: .image,
               toBe: generic422, "nil body 422")
        expect(status: 502, body: "<html><body>Bad Gateway</body></html>", input: .image,
               toBe: serverTrouble, "html body 502 image")
        expect(status: 502, body: "<html><body>Bad Gateway</body></html>", input: .url,
               toBe: pageFailed, "html body 502 url keeps page copy")

        // The 409 duplicate-URL response shape carries no `code`; the
        // neutral duplicate copy must not claim the recipe was saved.
        expect(status: 409,
               body: "{\"detail\":{\"detail\":\"Pending draft exists\",\"draft_id\":\"d1\",\"title\":\"T\"}}",
               input: .url,
               toBe: duplicate, "duplicate pending draft 409")
        expectNilBody(status: 409, input: .image, toBe: duplicate, "bare 409")

        // Remaining status fallbacks.
        expectNilBody(status: 401, input: .image, toBe: sessionExpired, "401")
        expectNilBody(status: 413, input: .image, toBe: tooLarge, "413")
        expectNilBody(status: 429, input: .image, toBe: rateLimited, "429")
        expectNilBody(status: 502, input: .url, toBe: pageFailed, "bare 502 url")
        expectNilBody(status: 502, input: .image, toBe: serverTrouble, "bare 502 image")
        expectNilBody(status: 502, input: .unknown, toBe: serverTrouble, "bare 502 unknown")
        expectNilBody(status: 502, input: .document, toBe: serverTrouble, "bare 502 document")
        expect(status: 422, body: "{\"detail\":\"boom\"}", input: .document,
               toBe: generic422, "codeless 422 document stays generic")
        expectNilBody(status: 500, input: .image, toBe: serverTrouble, "500")
        expectNilBody(status: 504, input: .url, toBe: serverTrouble, "bare 504")
        expectNilBody(status: 418, input: .image,
                      toBe: "Upload failed (418). Try again.", "default status")

        if failures > 0 {
            print("CaptureFailureMapperContract: \(failures)/\(checks) FAILED")
            exit(1)
        }
        print("CaptureFailureMapperContract: all \(checks) assertions passed")
    }
}
